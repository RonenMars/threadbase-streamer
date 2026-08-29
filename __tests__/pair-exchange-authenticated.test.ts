import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as miscRoutes from "../src/api/routes/misc.routes";
import type { DeviceRow, DevicesRepository } from "../src/db/repositories/devices.repository";
import {
  generateKeyPair,
  type KeyPair,
  PAIR_PROLOGUE,
  pskFromPairToken,
  readMessage2,
  writeMessage1,
} from "../src/e2ee/noise";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import { capabilitiesForPreset } from "../src/services/security/capabilities";

/**
 * GATE 4 — the E2EE path authenticates everything it stores or presents as
 * verified (design.md §2.4).
 *
 * Two halves, and each is worthless without the other:
 *
 *   1. What lands on the device row comes from message 1's payload, not the
 *      outer JSON. `POST /api/pair/exchange` is public and unauthenticated, so
 *      an intermediary can rename a device or widen `readOnly` on the way past;
 *      inside the AEAD it cannot. Proven by sending DIFFERENT values in the two
 *      places and asserting the authenticated ones win — asserting only that
 *      the row matches message 1 would also pass on a server that read the
 *      outer body and happened to be handed the same string.
 *   2. Message 2 carries every result a new client persists or presents as
 *      verified, so the client never has to trust an outer copy of a credential.
 *      A registration that cannot produce a device id and token therefore fails
 *      the pairing rather than returning a half-provisioned success.
 *
 * The legacy assertions are the positive controls this needs. Without them a
 * test that says "the E2EE path rejects" also passes against a server that
 * rejects everything, and a test that says "the outer body is ignored" also
 * passes against a server that ignores the whole request.
 *
 * The capability is stubbed on for the same reason `pair-exchange-e2ee.test.ts`
 * stubs it: `E2EE_SUPPORTED` is true, but the `e2ee` feature flag defaults off,
 * so an unstubbed capability resolves to disabled.
 */

const API_KEY = "tb_test_key_for_authenticated_pairing";

describe("the pair exchange authenticates what it stores and returns", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let configDir: string;
  let savedConfigDir: string | undefined;
  let serverStaticPub: Buffer;
  let clientStatic: KeyPair;

  beforeEach(async () => {
    savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-e2ee-authn-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    serverStaticPub = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
    clientStatic = generateKeyPair();

    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;

    vi.spyOn(miscRoutes, "describeE2eeCapability").mockReturnValue({
      supported: true,
      enabled: true,
      version: 1,
      required: false,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (savedConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = savedConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  async function mintToken(): Promise<string> {
    const r = await fetch(`${baseUrl}/api/pair/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return ((await r.json()) as { token: string }).token;
  }

  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  function startHandshake(token: string, payload: unknown) {
    return writeMessage1({
      prologue: PAIR_PROLOGUE,
      staticKeyPair: clientStatic,
      responderStaticPub: serverStaticPub,
      psk: pskFromPairToken(token),
      payload: Buffer.from(JSON.stringify(payload), "utf-8"),
    });
  }

  function devicesRepo(): DevicesRepository | null {
    return (server as unknown as { devicesRepo: DevicesRepository | null }).devicesRepo;
  }

  function deviceRow(deviceId: string): DeviceRow | null {
    return devicesRepo()?.get(deviceId) ?? null;
  }

  describe("message 1's payload decides the device row", () => {
    /**
     * The outer body carries the values an intermediary would substitute; the
     * payload carries what the phone actually said. They disagree on purpose:
     * a server that reads either one alone fails exactly one of these.
     */
    it("uses the authenticated deviceName and readOnly, not the outer body's", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, {
        v: 1,
        deviceName: "Ronen's iPhone",
        readOnly: true,
      });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        deviceName: "relabelled-in-transit",
        readOnly: false,
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deviceId: string; capabilities: string[] };

      const row = deviceRow(body.deviceId);
      expect(row?.name).toBe("Ronen's iPhone");
      expect(row?.name).not.toBe("relabelled-in-transit");
      // The narrower preset the phone asked for, not the wider one the outer
      // body claimed — the widening is the half that actually costs something.
      expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(capabilitiesForPreset("read-only"));
      expect(body.capabilities).toEqual(capabilitiesForPreset("read-only"));
    });

    it("registers with no name when the payload omits deviceName, ignoring the outer one", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, readOnly: false });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        deviceName: "injected-name",
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      const { deviceId } = (await res.json()) as { deviceId: string };

      expect(deviceRow(deviceId)?.name).toBeNull();
    });

    /**
     * The positive control for the pair above: the outer fields are still the
     * source on the legacy path, because that is all a released build sends.
     */
    it("still reads the outer body on the legacy path", async () => {
      const res = await post({
        token: await mintToken(),
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        deviceName: "Old App",
        readOnly: true,
      });
      const { deviceId } = (await res.json()) as { deviceId: string };

      const row = deviceRow(deviceId);
      expect(row?.name).toBe("Old App");
      expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(capabilitiesForPreset("read-only"));
    });

    it("refuses a payload that does not state readOnly, without pairing", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, deviceName: "no-preset" });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("E2EE_MALFORMED");
      // Defaulting would have granted the wider preset off a claim the device
      // never made; refusing must not also cost the user their pair token.
      expect(
        (
          await post({
            token,
            clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
          })
        ).status,
      ).toBe(200);
    });
  });

  describe("message 2 carries the whole authenticated result", () => {
    it("returns every field in the contract, with e2eeRequired true", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, deviceName: "iPhone", readOnly: false });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      const body = (await res.json()) as {
        e2ee?: { v: number; noise: string };
        deviceId: string;
        deviceToken: string;
        capabilities: string[];
        machineName: string;
      };

      expect(body.e2ee?.v).toBe(1);
      const done = readMessage2(initiator.state, Buffer.from(body.e2ee?.noise ?? "", "base64"));
      const payload = JSON.parse(done.payload.toString("utf-8")) as Record<string, unknown>;

      expect(Object.keys(payload).sort()).toEqual(
        [
          "capabilities",
          "deviceId",
          "deviceToken",
          "e2eeRequired",
          "machineName",
          "publicUrl",
          "serverVersion",
          "v",
        ].sort(),
      );
      expect(payload.v).toBe(1);
      expect(payload.e2eeRequired).toBe(true);
      // A credential the client can actually use, not a null in a well-shaped
      // object — the point of authenticating it is that it replaces the outer
      // copy rather than confirming one.
      expect(typeof payload.deviceId).toBe("string");
      expect(typeof payload.deviceToken).toBe("string");
      expect(payload.deviceId).toBe(body.deviceId);
      expect(payload.deviceToken).toBe(body.deviceToken);
      expect(payload.capabilities).toEqual(body.capabilities);
      expect(payload.machineName).toBe(body.machineName);
      expect(typeof payload.serverVersion).toBe("string");
    });

    /**
     * Overlaps the shape assertion above, deliberately, and the overlap is not
     * removable: any mutation that makes the token useless also makes it differ
     * from the outer copy, so both tests redden together. Verified — emitting
     * `deviceId` in the `deviceToken` slot fails this one with `expected 401 to
     * be 200` and that one with a value mismatch.
     *
     * It stays because it is the only assertion here that would catch a token
     * which is well-shaped, matches the outer copy, and simply does not work.
     * A key-set check cannot see that, and it is the failure a client would hit
     * on its first authenticated request rather than at pairing.
     */
    it("issues a device token that actually authenticates", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, readOnly: false });
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      const body = (await res.json()) as { e2ee?: { noise: string } };
      const payload = JSON.parse(
        readMessage2(
          initiator.state,
          Buffer.from(body.e2ee?.noise ?? "", "base64"),
        ).payload.toString("utf-8"),
      ) as { deviceToken: string };

      // Without this the field could be any string and every shape assertion
      // above would still pass.
      const info = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: `Bearer ${payload.deviceToken}` },
      });
      expect(info.status).toBe(200);
    });
  });

  describe("device registration is mandatory on the E2EE path only", () => {
    function breakRegistration(): void {
      const repo = devicesRepo();
      if (!repo) throw new Error("devicesRepo is null; this suite cannot say anything");
      vi.spyOn(repo, "register").mockImplementation(() => {
        throw new Error("runtime.db is unwritable");
      });
    }

    /**
     * Returning success here would hand the client a key-pinned pairing with no
     * usable device credential — the server has recorded the static key, the
     * phone believes it paired, and the failure surfaces weeks later in the
     * record layer, far from its cause.
     */
    it("fails the pairing when the device row cannot be written", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, readOnly: false });
      breakRegistration();

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("E2EE_REGISTRATION_FAILED");
      // No half-provisioned success: nothing a client could mistake for a
      // completed pairing comes back with it.
      expect(body.e2ee).toBeUndefined();
      expect(body.deviceToken).toBeUndefined();
      expect(body.ciphertext).toBeUndefined();
    });

    /**
     * The positive control. Without it the assertion above also passes against
     * a server that refuses every pairing, and the legacy behaviour it must not
     * have changed goes unverified: losing the row there costs revocability,
     * not access, so pairing continues.
     */
    it("still pairs on the legacy path when the device row cannot be written", async () => {
      breakRegistration();

      const res = await post({
        token: await mintToken(),
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ciphertext).toBeDefined();
      expect(body.nonce).toBeDefined();
      expect(body.ephemeralPublicKey).toBeDefined();
      expect(body.deviceToken).toBeUndefined();
    });
  });

  describe("the legacy path is unchanged", () => {
    it("answers a request with no e2ee field with exactly the fields it always did", async () => {
      const res = await post({
        token: await mintToken(),
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual(
        [
          "capabilities",
          "ciphertext",
          "deviceId",
          "deviceToken",
          "ephemeralPublicKey",
          "machineName",
          "nonce",
          "publicUrl",
        ].sort(),
      );
      expect(body.e2ee).toBeUndefined();
    });
  });

  /**
   * Everything above stubs the capability ON, so none of it would notice if
   * #630's gate were reverted — those tests are about GATE 4 (what the E2EE
   * path authenticates), not about GATE 1 (whether it runs at all). This block
   * is the one that would.
   *
   * It matters because the msg1 parse added here sits *inside* a branch #630
   * can switch off entirely. A clean rebase proves git found no textual
   * conflict; it does not prove the combined logic is right. So this asserts
   * the composition directly: with the capability at its real default, a
   * request carrying an `e2ee` field must take the legacy path and never reach
   * `parseE2eeMsg1Payload`.
   *
   * The payload is deliberately one the parser WOULD refuse — no `readOnly`.
   * That is what makes the assertion sharp: 200 with no `e2ee` in the reply can
   * only mean the parse never ran, whereas a 400 `E2EE_MALFORMED` would mean a
   * disabled build had parsed attacker-chosen bytes it has no business reading.
   */
  describe("the capability gate still fronts all of this", () => {
    beforeEach(() => {
      // Undo the outer stub: back to `E2EE_SUPPORTED && flagEnabled`, which is
      // false on every build until Batch D flips the constant.
      vi.restoreAllMocks();
    });

    it("never parses message 1's payload when the build denies the capability", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token, { v: 1, deviceName: "no-preset" });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Paired through the legacy path, with the `e2ee` field ignored outright.
      expect(body.e2ee).toBeUndefined();
      expect(body.ciphertext).toBeDefined();
      expect(body.deviceToken).toBeDefined();
    });
  });
});
