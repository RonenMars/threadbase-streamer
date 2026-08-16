import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as miscRoutes from "../src/api/routes/misc.routes";
import {
  generateKeyPair,
  type KeyPair,
  pskFromPairToken,
  readMessage2,
  writeMessage1,
} from "../src/e2ee/noise";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";

/**
 * The Noise handshake wired into `POST /api/pair/exchange` (#590, Phase 2).
 *
 * The client half here is the same `writeMessage1`/`readMessage2` the committed
 * vectors pin, and tb-mobile's independent `@stablelib` implementation
 * reproduces those vectors byte for byte — so driving the endpoint with it is a
 * real interop exercise rather than the server talking to itself.
 *
 * What the endpoint owes, in order of how badly it breaks if it stops:
 *
 *   1. An old app, which sends no `e2ee` at all, pairs exactly as it does today.
 *   2. The sealed API key is still returned on the E2EE path — an old app is
 *      the only thing that reads it and it cannot be force-updated.
 *   3. A failing handshake does not spend the token, so a photographed QR does
 *      not become a denial of service against the legitimate phone.
 *   4. A device that paired encrypted is pinned, by a key it proved it holds.
 *
 * `handlePairExchange` only runs the handshake when
 * `describeE2eeCapability(...).enabled` is true, which is
 * `E2EE_SUPPORTED && flagEnabled` (misc.routes.ts) — and `E2EE_SUPPORTED` is
 * currently the hardcoded constant `false`, flipped by Phase 2, step 4, once
 * this handshake lands. This suite is about the handshake itself, not the
 * gate, so it stubs the capability on directly; the on/off boundary of the
 * gate is `__tests__/pair-exchange-e2ee-gate.test.ts`.
 */

const API_KEY = "tb_test_key_for_e2ee_exchange";

describe("pair exchange with a Noise handshake", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let configDir: string;
  let savedConfigDir: string | undefined;
  let serverStaticPub: Buffer;
  let clientStatic: KeyPair;

  beforeEach(async () => {
    // The identity key is read from THREADBASE_CONFIG_DIR; sandbox it so the
    // suite never generates or reads the developer's real one.
    savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-e2ee-exchange-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    serverStaticPub = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
    clientStatic = generateKeyPair();

    // `port: 0` and read back what the OS assigned, rather than probing for a
    // free port and binding it a moment later. The probe-then-bind pattern the
    // older pairing tests use has a real race — the port can be taken in the
    // gap — and this suite adds servers to a run that already sees occasional
    // EADDRINUSE.
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;

    // See the file header: this suite exercises the handshake, not the gate
    // in front of it, so the capability is stubbed on directly rather than
    // through any configuration this build can actually reach today.
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

  /** What a released app sends: no `e2ee` key at all. */
  const legacyBody = (token: string) => ({
    token,
    clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
  });

  function startHandshake(token: string, responderStaticPub = serverStaticPub) {
    return writeMessage1({
      staticKeyPair: clientStatic,
      responderStaticPub,
      psk: pskFromPairToken(token),
      payload: Buffer.from(JSON.stringify({ v: 1 }), "utf-8"),
    });
  }

  describe("a client that never asks for encryption", () => {
    /**
     * The compatibility floor. A released build cannot be force-updated, so
     * "no `e2ee` field" has to mean "an older client" and never "a malformed
     * request" — the branch is explicit in the handler for exactly this reason.
     */
    it("pairs exactly as before, with no e2ee in the reply", async () => {
      const res = await post(legacyBody(await mintToken()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.ciphertext).toBeDefined();
      expect(body.nonce).toBeDefined();
      expect(body.ephemeralPublicKey).toBeDefined();
      expect(body.deviceToken).toBeDefined();
      expect(body.e2ee).toBeUndefined();
    });
  });

  describe("a client that completes the handshake", () => {
    it("pairs, and both sides agree on the transcript", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token);
      const recipient = nacl.box.keyPair();

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        e2ee?: { v: number; noise: string };
        deviceId?: string;
        ciphertext: string;
        nonce: string;
        ephemeralPublicKey: string;
      };

      expect(body.e2ee?.v).toBe(1);
      // Completing message 2 IS the proof: it only decrypts if the server holds
      // the private half of the identity key this client started from, and if
      // both sides mixed the same pair token as PSK.
      const done = readMessage2(initiator.state, Buffer.from(body.e2ee?.noise ?? "", "base64"));
      const payload = JSON.parse(done.payload.toString("utf-8"));
      expect(payload.deviceId).toBe(body.deviceId);
      expect(payload.e2eeRequired).toBe(true);
      expect(typeof payload.serverVersion).toBe("string");
      // No rootKeyConfirm: the transcript hash already proves the keys agree,
      // which is why design.md §2.4 no longer lists one.
      expect(payload.rootKeyConfirm).toBeUndefined();
    });

    /**
     * The sealed API key is still sent on the E2EE path.
     *
     * An old app is the only thing that reads it, and the response must grow a
     * field rather than lose one — a new app simply ignores these.
     */
    it("still returns the legacy sealed payload, and it still decrypts", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token);
      const recipient = nacl.box.keyPair();

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(recipient.publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      const body = (await res.json()) as {
        ciphertext: string;
        nonce: string;
        ephemeralPublicKey: string;
      };

      const plain = nacl.box.open(
        naclUtil.decodeBase64(body.ciphertext),
        naclUtil.decodeBase64(body.nonce),
        naclUtil.decodeBase64(body.ephemeralPublicKey),
        recipient.secretKey,
      );
      expect(plain).not.toBeNull();
      expect(naclUtil.encodeUTF8(plain as Uint8Array)).toBe(API_KEY);
    });

    // The device is identified by a key it proved it holds, not by a string it
    // sent. Setting it also sets the downgrade lock.
    it("pins the device to the static key recovered from the transcript", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token);

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: initiator.message.toString("base64") },
      });
      const { deviceId } = (await res.json()) as { deviceId: string };

      const listed = await fetch(`${baseUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const devices = (await listed.json()) as {
        devices?: Array<{ deviceId: string; e2ee?: boolean }>;
      };
      const row = (devices.devices ?? []).find((d) => d.deviceId === deviceId);
      expect(row?.e2ee).toBe(true);
    });
  });

  describe("a handshake that fails", () => {
    /**
     * The property that makes this safe to attempt: a hostile or broken `msg1`
     * must not spend the token. Otherwise anyone who photographs the QR gains a
     * denial of service they did not have — burn the token, and the legitimate
     * phone's pairing dies with it.
     */
    it("leaves the token spendable, so the legitimate phone can still pair", async () => {
      const token = await mintToken();
      // A handshake aimed at a different server: the phone believes the wrong
      // static key, so `es`/`ss` diverge and the very first decryption fails.
      const impostor = generateKeyPair();
      const wrong = startHandshake(token, impostor.publicKeyRaw);

      const refused = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: wrong.message.toString("base64") },
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { code?: string }).code).toBe("E2EE_HANDSHAKE_FAILED");

      // Same QR, correct handshake: still works.
      const retry = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: startHandshake(token).message.toString("base64") },
      });
      expect(retry.status).toBe(200);
    });

    it("rejects a tampered message 1", async () => {
      const token = await mintToken();
      const initiator = startHandshake(token);
      const tampered = Buffer.from(initiator.message);
      tampered[tampered.length - 1] ^= 0x01;

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: tampered.toString("base64") },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("E2EE_HANDSHAKE_FAILED");
    });

    /**
     * The PSK binds the handshake to the scanned QR. A client holding a valid
     * token but mixing a different one is the shape of "reached the server
     * without scanning this code", and it must not complete.
     */
    it("rejects a handshake bound to a different pair token", async () => {
      const token = await mintToken();
      const wrongPsk = writeMessage1({
        staticKeyPair: clientStatic,
        responderStaticPub: serverStaticPub,
        psk: pskFromPairToken("pt_ffffffffffffffffffffffffffffffff"),
        payload: Buffer.from("{}", "utf-8"),
      });

      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: wrongPsk.message.toString("base64") },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("E2EE_HANDSHAKE_FAILED");
    });

    // One code for every handshake failure. Telling an attacker which half of
    // their guess was wrong is free information, and the client's remedy is the
    // same in all three cases: scan a fresh code.
    it("does not say which part of the handshake failed", async () => {
      const token = await mintToken();
      const impostor = generateKeyPair();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: {
          v: 1,
          noise: startHandshake(token, impostor.publicKeyRaw).message.toString("base64"),
        },
      });
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toMatch(/psk|static|decrypt|token/i);
    });
  });

  describe("a malformed or unsupported envelope", () => {
    it("refuses a future version distinctly from a parse failure", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 2, noise: startHandshake(token).message.toString("base64") },
      });
      expect(res.status).toBe(400);
      // Distinct so a newer client can fall back deliberately rather than
      // retrying a request that will never succeed.
      expect(((await res.json()) as { code?: string }).code).toBe("E2EE_VERSION_UNSUPPORTED");
    });

    it("refuses a malformed envelope and keeps the token spendable", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: 12345 },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("E2EE_MALFORMED");

      expect((await post(legacyBody(token))).status).toBe(200);
    });
  });
});
