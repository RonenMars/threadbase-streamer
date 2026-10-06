import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { printServerBanner } from "../cli/pair-banner";
import {
  generateKeyPair,
  PAIR_PROLOGUE,
  pskFromPairToken,
  readMessage2,
  writeMessage1,
} from "../src/e2ee/noise";
import { relayClientUrl, relayRouteId } from "../src/relay/address";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import { FakeRelay } from "./helpers/fake-relay";

/**
 * How a client learns the relay address: the authenticated pairing reply and
 * `GET /api/info` carry it, the QR carries it as a hint, and the outer,
 * unauthenticated pairing response never does.
 */

const API_KEY = "tb_0123456789abcdef0123456789abcdef";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

describe("relayClientUrl", () => {
  // Pinned against the relay's own derivation: a route id that drifts from it
  // names a tunnel that does not exist.
  const key = Buffer.alloc(32, 7);

  it("derives the route id the relay derives", () => {
    expect(relayRouteId(key)).toBe("7iqUq3r3htIlhM0e0bMJHSNDnRviMBNF");
  });

  it("turns the tunnel endpoint into the client base URL", () => {
    expect(relayClientUrl("wss://relay.example.com/tunnel", key)).toBe(
      "https://relay.example.com/r/7iqUq3r3htIlhM0e0bMJHSNDnRviMBNF",
    );
    expect(relayClientUrl("ws://127.0.0.1:9000/tunnel", key)).toBe(
      "http://127.0.0.1:9000/r/7iqUq3r3htIlhM0e0bMJHSNDnRviMBNF",
    );
  });

  it("advertises nothing for a relay_url that does not parse", () => {
    expect(relayClientUrl("not a url", key)).toBeNull();
  });
});

describe("advertising the relay address", () => {
  let relay: FakeRelay;
  let server: StreamerServer;
  let baseUrl: string;
  let configDir: string;
  let saved: string | undefined;
  let expected: string;

  async function boot(relayOn: boolean) {
    server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      featureFlags: { relay: relayOn, e2ee: true },
      relayUrl: relay.url,
      relayPublicKey: relay.keyPair.publicKeyRaw.toString("base64url"),
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  }

  beforeEach(async () => {
    saved = process.env.THREADBASE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "tb-ra-"));
    process.env.THREADBASE_CONFIG_DIR = configDir;
    relay = await new FakeRelay().start();
    const spk = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
    expected = `http://127.0.0.1:${new URL(relay.url).port}/r/${relayRouteId(spk)}`;
  });
  afterEach(async () => {
    await server.close();
    await relay.kill().catch(() => {});
    if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  const info = async () =>
    (await (await fetch(`${baseUrl}/api/info`, { headers: AUTH })).json()) as Record<
      string,
      unknown
    >;

  async function pair() {
    const start = (await (
      await fetch(`${baseUrl}/api/pair/start`, { method: "POST", headers: AUTH })
    ).json()) as { token: string };
    const initiator = writeMessage1({
      staticKeyPair: generateKeyPair(),
      responderStaticPub: Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url"),
      psk: pskFromPairToken(start.token),
      payload: Buffer.from(JSON.stringify({ v: 1, readOnly: false }), "utf-8"),
      prologue: PAIR_PROLOGUE,
    });
    const outer = (await (
      await fetch(`${baseUrl}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: start.token,
          clientPublicKey: naclUtil.encodeBase64(nacl.box.keyPair().publicKey),
          e2ee: { v: 1, noise: initiator.message.toString("base64") },
        }),
      })
    ).json()) as Record<string, unknown> & { e2ee: { noise: string } };
    const done = readMessage2(initiator.state, Buffer.from(outer.e2ee.noise, "base64"));
    return { outer, inner: JSON.parse(done.payload.toString("utf-8")) as Record<string, unknown> };
  }

  async function qr() {
    const log = { info: vi.fn(), warn: vi.fn() };
    await printServerBanner(
      { port: server.port, apiKey: API_KEY, publicUrl: "https://tb.example.test", includeQr: true },
      { log },
    );
    const line = log.info.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.startsWith("Pair URL: "));
    return new URL(line?.slice("Pair URL: ".length) ?? "");
  }

  it("carries the address in /api/info, the authenticated pairing reply and the QR", async () => {
    await boot(true);

    expect((await info()).relayUrl).toBe(expected);
    const { outer, inner } = await pair();
    expect(inner.relayUrl).toBe(expected);
    // The outer copy is what an intermediary can rewrite.
    expect(outer).not.toHaveProperty("relayUrl");
    expect((await qr()).searchParams.get("relay")).toBe(expected);
  });

  it("says nothing about a relay while the flag is off", async () => {
    await boot(false);

    expect(await info()).not.toHaveProperty("relayUrl");
    expect((await pair()).inner).not.toHaveProperty("relayUrl");
    expect((await qr()).searchParams.has("relay")).toBe(false);
  });
});
