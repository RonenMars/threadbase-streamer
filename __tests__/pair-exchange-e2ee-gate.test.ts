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
  writeMessage1,
} from "../src/e2ee/noise";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";

/**
 * Bug in #626: `handlePairExchange` called `parseE2eeRequest` and performed
 * the Noise handshake — and pinned the device with `e2ee_required = 1` —
 * whenever a request carried an `e2ee` field, without checking whether this
 * server actually offers E2EE. The capability negotiation this decision
 * depends on already existed and already answered correctly: `GET /api/info`
 * has always reported `e2ee.enabled` via `describeE2eeCapability`. #626 wired
 * the handshake into the exchange without consulting it, so a build
 * reporting `enabled: false` would still complete a handshake and set a pin
 * nothing a client can undo, contradicting the capability it had just
 * advertised.
 *
 * `POST /api/pair/exchange` now consults the same `describeE2eeCapability`
 * answer before touching the `e2ee` field at all, so the two can never
 * disagree again.
 *
 * `describeE2eeCapability(...).enabled` is `E2EE_SUPPORTED && flagEnabled`
 * (misc.routes.ts). `E2EE_SUPPORTED` is now true, so the remaining gate is the
 * `e2ee` feature flag, which defaults off. With the capability disabled, no
 * configuration this build can reach produces `enabled: true`. The
 * "capability on" cases below stub `describeE2eeCapability` directly, the
 * same technique other suites in this repo use to isolate one collaborator
 * via `vi.spyOn` on a named export (`__tests__/pty-host-survival.test.ts`),
 * rather than flipping the build constant, which is its own later decision.
 *
 * The handshake itself — interop, PSK binding, failure modes — is exercised
 * in `pair-exchange-e2ee.test.ts`, which stubs the capability on for the same
 * reason and defers to this file for the on/off boundary.
 */

const API_KEY = "tb_test_key_for_e2ee_gate";

describe("the pair exchange refuses the handshake when the build denies the capability", () => {
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
    configDir = mkdtempSync(join(tmpdir(), "tb-e2ee-gate-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    serverStaticPub = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
    clientStatic = generateKeyPair();

    server = new StreamerServer({ port: 0, apiKey: API_KEY, localNoAuth: false, verbose: false });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
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

  function handshakeMessage(token: string): string {
    const { message } = writeMessage1({
      prologue: PAIR_PROLOGUE,
      staticKeyPair: clientStatic,
      responderStaticPub: serverStaticPub,
      psk: pskFromPairToken(token),
      // `readOnly` is not optional in message 1's payload — only `deviceName`
      // is (design.md §2.4) — because the server registers the device from
      // these authenticated values, and defaulting an absent one would grant
      // the wider capability preset off a claim the device never made. This
      // payload used to be `{ v: 1 }`, which no longer completes a handshake.
      payload: Buffer.from(JSON.stringify({ v: 1, readOnly: false }), "utf-8"),
    });
    return message.toString("base64");
  }

  /**
   * The row itself, not the `/api/devices` view — `toDeviceView` deliberately
   * never exposes `e2ee_static_pub` (devices.repository.ts), so only the raw
   * row can prove the pin was never written, which is the thing that matters
   * here: the pin is what cannot be undone once set.
   */
  function deviceRow(deviceId: string): DeviceRow | null {
    const devicesRepo = (server as unknown as { devicesRepo: DevicesRepository | null })
      .devicesRepo;
    return devicesRepo?.get(deviceId) ?? null;
  }

  describe("capability off (this build's default)", () => {
    // The named acceptance criterion for this fix: a build which denies the
    // capability refuses to perform the handshake. Asserted on the device
    // row, not only on the response — the pin is what cannot be undone once
    // set, so it is the thing worth checking directly.
    it("refuses to perform the handshake, pairs in plaintext, and leaves the device unpinned", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: handshakeMessage(token) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deviceId?: string; e2ee?: unknown };
      expect(body.e2ee).toBeUndefined();
      expect(body.deviceId).toBeDefined();

      const row = deviceRow(body.deviceId as string);
      expect(row?.e2ee_static_pub).toBeNull();
      expect(row?.e2ee_required).toBe(0);
    });

    // The `parseE2eeRequest` decision: capability off means nothing runs on
    // the field at all, not that it runs and is more lenient. A malformed
    // `e2ee` must not surface as `E2EE_MALFORMED`, because that would mean the
    // parser ran on attacker-controlled bytes this public, unauthenticated
    // endpoint has no reason to touch (src/e2ee/pair-request.ts header
    // comment).
    it("ignores a malformed e2ee field rather than rejecting the pairing", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: 12345 },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { e2ee?: unknown };
      expect(body.e2ee).toBeUndefined();
    });

    it("pairs a client with no e2ee field exactly as before", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deviceId?: string; e2ee?: unknown };
      expect(body.e2ee).toBeUndefined();

      const row = deviceRow(body.deviceId as string);
      expect(row?.e2ee_static_pub).toBeNull();
      expect(row?.e2ee_required).toBe(0);
    });
  });

  describe("capability on (server advertises the handshake)", () => {
    beforeEach(() => {
      vi.spyOn(miscRoutes, "describeE2eeCapability").mockReturnValue({
        supported: true,
        enabled: true,
        version: 1,
        required: false,
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The positive control. Without this, the "off" tests above would also
    // pass against a server that had stopped doing E2EE altogether — this is
    // what proves the gate actually lets the handshake through when the
    // capability says it should.
    it("completes the handshake and pins the device", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
        e2ee: { v: 1, noise: handshakeMessage(token) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deviceId?: string;
        e2ee?: { v: number; noise: string };
      };
      expect(body.e2ee?.v).toBe(1);

      const row = deviceRow(body.deviceId as string);
      expect(typeof row?.e2ee_static_pub).toBe("string");
      expect(row?.e2ee_required).toBe(1);
    });

    it("still pairs a client with no e2ee field", async () => {
      const token = await mintToken();
      const res = await post({
        token,
        clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { deviceId?: string; e2ee?: unknown };
      expect(body.e2ee).toBeUndefined();

      const row = deviceRow(body.deviceId as string);
      expect(row?.e2ee_static_pub).toBeNull();
      expect(row?.e2ee_required).toBe(0);
    });
  });
});
