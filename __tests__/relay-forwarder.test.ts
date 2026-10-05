import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DevicesRepository } from "../src/db/repositories/devices.repository";
import {
  generateKeyPair,
  OPEN_PROLOGUE,
  readMessage2,
  type TrafficKeys,
  writeMessage1,
} from "../src/e2ee/noise";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_REST_RESPONSE,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  restTargetHashFromUrl,
} from "../src/e2ee/record";
import { StreamerServer } from "../src/server";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import { FakeRelay, type RelayedResponse } from "./helpers/fake-relay";

/**
 * One sealed request, end to end, through the relay tunnel: a paired device
 * opens a context and reads `GET /api/info` with nothing but frames a relay
 * could have produced. The server is real, the handshake is real, and the
 * stand-in relay records every byte that crossed the tunnel so "the relay saw
 * no plaintext" is a measurement.
 */

const API_KEY = "tb_0123456789abcdef0123456789abcdef";
const TARGET = "/api/info";

let relay: FakeRelay;
let server: StreamerServer;
let configDir: string;
let saved: string | undefined;

beforeEach(async () => {
  saved = process.env.THREADBASE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "tb-rf-"));
  process.env.THREADBASE_CONFIG_DIR = configDir;
  relay = await new FakeRelay().start();
  server = new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    featureFlags: { relay: true, e2ee: true },
    relayUrl: relay.url,
    relayPublicKey: relay.keyPair.publicKeyRaw.toString("base64url"),
  });
  await server.listen(0, { awaitReady: true });
  for (let i = 0; i < 500 && !relay.tunnel; i++) await new Promise((r) => setTimeout(r, 10));
});
afterEach(async () => {
  await server.close();
  await relay.kill().catch(() => {});
  if (saved === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = saved;
  rmSync(configDir, { recursive: true, force: true });
});

const answered = (res: RelayedResponse | "reset"): RelayedResponse => {
  if (res === "reset") throw new Error("stream was reset");
  return res;
};

/** Pair a device directly in the store, then open a REST context over the tunnel. */
async function openContext(): Promise<{ ctxId: string; keys: TrafficKeys }> {
  const device = generateKeyPair();
  const repo = (server as unknown as { devicesRepo: DevicesRepository }).devicesRepo;
  repo.register({
    publicKey: `legacy-${device.publicKeyRaw.toString("base64")}`,
    e2eeStaticPub: device.publicKeyRaw.toString("base64"),
    e2eeVersion: 1,
    preset: "full",
  });
  const { message, state } = writeMessage1({
    staticKeyPair: device,
    responderStaticPub: Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url"),
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "rest" }), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  const res = answered(
    await relay.request(
      {
        kind: "http",
        method: "POST",
        target: "/api/e2ee/open",
        headers: { "content-type": "application/json" },
      },
      Buffer.from(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } })),
    ),
  );
  expect(res.status).toBe(200);
  const outer = JSON.parse(res.body.toString("utf-8")) as { e2ee: { noise: string } };
  const { payload, keys } = readMessage2(state, Buffer.from(outer.e2ee.noise, "base64"));
  return {
    ctxId: (JSON.parse(payload.toString("utf-8")) as { ctxId: string }).ctxId,
    keys: keys.consume(),
  };
}

/** Where the sealed exchange starts in the capture; the handshake before it is Noise in a JSON wrapper. */
let sealedFrom = 0;

async function sealedInfo(extraHeaders: Record<string, string> = {}): Promise<string> {
  const { ctxId, keys } = await openContext();
  sealedFrom = relay.seen.length;
  const ctxIdRaw = Buffer.from(ctxId, "base64url");
  const hash = restTargetHashFromUrl("GET", TARGET);
  const record = createRecordState({
    key: keys.clientToServer,
    ctxId: ctxIdRaw,
    direction: DIRECTION_C2S,
    channel: CHANNEL_REST_REQUEST,
    initialCounter: 0n,
  }).seal(Buffer.alloc(0), hash);
  const res = answered(
    await relay.request({
      kind: "http",
      method: "GET",
      target: TARGET,
      headers: {
        "x-tb-e2ee": "1",
        "x-tb-ctx": ctxId,
        "x-tb-seq": "0",
        "x-tb-env": record.toString("base64url"),
        ...extraHeaders,
      },
    }),
  );
  expect(res.status).toBe(200);
  const sealed = res.headers["x-tb-env"]
    ? Buffer.from(res.headers["x-tb-env"], "base64url")
    : res.body;
  return createRecordState({
    key: keys.serverToClient,
    ctxId: ctxIdRaw,
    direction: DIRECTION_S2C,
    channel: CHANNEL_REST_RESPONSE,
    initialCounter: 0n,
  })
    .unseal(sealed, hash)
    .toString("utf-8");
}

describe("a request relayed through the tunnel", () => {
  it("reads /api/info sealed end to end, and the relay sees none of it", async () => {
    const direct = await fetch(`http://127.0.0.1:${server.port}${TARGET}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const plain = (await direct.json()) as Record<string, unknown>;

    const viaRelay = JSON.parse(await sealedInfo()) as Record<string, unknown>;
    expect(Object.keys(viaRelay).sort()).toEqual(Object.keys(plain).sort());

    // The control: these strings ARE in the plaintext the device recovered, so
    // their absence from the capture is a statement about the tunnel.
    const sealedFrames = relay.seen.slice(sealedFrom);
    const capture = Buffer.concat(sealedFrames).toString("latin1");
    // OPEN and END out, HEAD and END back, at least.
    expect(sealedFrames.length).toBeGreaterThanOrEqual(4);
    for (const key of Object.keys(plain)) {
      expect(JSON.stringify(viaRelay)).toContain(`"${key}"`);
      expect(capture).not.toContain(`"${key}"`);
    }
  });

  it("refuses an unsealed request, whatever credential the relay attaches", async () => {
    const open = { kind: "http", method: "GET", target: TARGET };
    const bare = answered(await relay.request({ ...open, headers: {} }));
    const withKey = answered(
      await relay.request({ ...open, headers: { authorization: `Bearer ${API_KEY}` } }),
    );
    const inQuery = answered(
      await relay.request({ ...open, target: `${TARGET}?key=${API_KEY}`, headers: {} }),
    );

    expect(bare.status).toBe(401);
    expect(withKey.status).toBe(401);
    expect(inQuery.status).toBe(401);
  });

  it("drops a header outside the allowlist instead of trusting the relay", async () => {
    // A forged Authorization that reached the server would 401 the sealed
    // request as a plaintext credential; a 200 means it never arrived.
    await sealedInfo({ authorization: `Bearer ${API_KEY}`, cookie: "a=b" });
  });

  it("resets a stream it will not open", async () => {
    expect(await relay.request({ kind: "ws", method: "GET", target: TARGET, headers: {} })).toBe(
      "reset",
    );
    expect(
      await relay.request({ kind: "http", method: "GET", target: "http://evil/", headers: {} }),
    ).toBe("reset");
    expect(
      await relay.request({ kind: "http", method: "CONNECT", target: TARGET, headers: {} }),
    ).toBe("reset");
    // The tunnel survives a refused stream.
    expect(
      answered(await relay.request({ kind: "http", method: "GET", target: TARGET, headers: {} }))
        .status,
    ).toBe(401);
  });
});
