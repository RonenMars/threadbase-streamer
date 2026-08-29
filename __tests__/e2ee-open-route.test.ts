import { serve } from "@hono/node-server";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { request } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createHonoApp } from "../src/api/app";
import { OPEN_SOURCE_FAILURE_LIMIT, PAIR_EXCHANGE_LIMIT } from "../src/api/rate-limit";
import { MAX_OPEN_BODY_BYTES as ROUTE_MAX_BODY } from "../src/api/routes/e2ee.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { contextRegistry } from "../src/e2ee/context";
import {
  generateKeyPair,
  type HandshakeInitiatorState,
  type KeyPair,
  keyPairFromRawPrivate,
  NOISE_IK_PROTOCOL_NAME,
  OPEN_PROLOGUE,
  PAIR_PROLOGUE,
  pskFromPairToken,
  readMessage1,
  readMessage2,
  respond,
  writeMessage1,
} from "../src/e2ee/noise";
import { E2EE_CTX_UNKNOWN, E2EE_DEVICE_REVOKED } from "../src/e2ee/protocol";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import vectors from "./fixtures/e2ee-record-vectors.json";
import pairVectors from "./fixtures/noise-ikpsk1-vectors.json";

/**
 * `POST /api/e2ee/open` (Phase 3, W1a) — NONCE-DESIGN §8, §9, §10, §11.
 *
 * A real HTTP server, the real Hono app with its real auth middleware, a real
 * `devices` row in a real runtime.db, and the real Noise handshake driven from
 * the client side by `writeMessage1`/`readMessage2`. Nothing about the
 * transition under test is stubbed.
 *
 * The app is rebuilt per test because the route's rate limiter is per-app: five
 * attempts per minute per IP is the policy under test in one case and would
 * otherwise silently 429 the rest of the file.
 */

/**
 * A pass-through counter on the REAL `readMessage1` — not a stub. It runs the
 * genuine handshake and only records that it was reached, which is the one way
 * to assert that a refusal happened BEFORE the two Diffie-Hellmans rather than
 * after them. Timing would not prove it.
 */
const noiseCalls = vi.hoisted(() => ({ readMessage1: 0 }));
vi.mock("../src/e2ee/noise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2ee/noise")>();
  return {
    ...actual,
    readMessage1: (args: Parameters<typeof actual.readMessage1>[0]) => {
      noiseCalls.readMessage1++;
      return actual.readMessage1(args);
    },
  };
});

const registry = contextRegistry();

let dir: string;
let store: RuntimeStore;
let repo: DevicesRepository;
let baseUrl: string;
let server: ReturnType<typeof serve>;
let savedConfigDir: string | undefined;
let serverStaticPub: Buffer;

beforeAll(() => {
  savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "tb-e2ee-open-"));
  process.env.THREADBASE_CONFIG_DIR = dir;
  serverStaticPub = Buffer.from(loadOrCreateServerIdentity().publicKey, "base64url");
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new DevicesRepository(store.getDatabase());
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = savedConfigDir;
});

beforeEach(async () => {
  registry.clear();
  noiseCalls.readMessage1 = 0;
  const deps = {
    apiKey: "tb_0123456789abcdef0123456789abcdef",
    localNoAuth: false,
    logMenubarRequests: false,
    devicesRepo: () => repo,
    featureFlagsConfig: () => ({ registry: [], values: { e2ee: true }, sources: {} }),
  } as unknown as ApiDeps;
  server = serve({ fetch: createHonoApp(deps).fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

/** A paired device: a real row, keyed by the static key it will prove it holds. */
function pairDevice(): { deviceId: string; staticKeyPair: KeyPair } {
  const staticKeyPair = generateKeyPair();
  const { deviceId } = repo.register({
    publicKey: "legacy-public-key",
    e2eeStaticPub: staticKeyPair.publicKeyRaw.toString("base64"),
    e2eeVersion: 1,
  });
  return { deviceId, staticKeyPair };
}

function message1(
  staticKeyPair: KeyPair,
  payload: unknown,
): { body: string; state: HandshakeInitiatorState } {
  const { message, state } = writeMessage1({
    staticKeyPair,
    responderStaticPub: serverStaticPub,
    // `/open` is the psk-less `IK` pattern, named rather than implied (§11).
    pattern: "IK",
    payload: Buffer.from(JSON.stringify(payload), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  return { body: JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } }), state };
}

async function post(body: string): Promise<Response> {
  // No Authorization header anywhere in this file: the endpoint is public
  // because the handshake IS the authentication.
  return fetch(`${baseUrl}/api/e2ee/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Complete an open and return message 2's decrypted payload. */
async function open(kind: "ws" | "rest", device = pairDevice()) {
  const { body, state } = message1(device.staticKeyPair, { v: 1, kind });
  const res = await post(body);
  const text = await res.text();
  const outer = JSON.parse(text) as { e2ee?: { v: number; noise: string } };
  const payload = readMessage2(state, Buffer.from(outer.e2ee?.noise ?? "", "base64")).payload;
  return {
    res,
    rawResponse: text,
    device,
    payload: JSON.parse(payload.toString("utf-8")) as {
      v: number;
      ctxId: string;
      expiresAt: number;
      provisional: boolean;
      ticket?: string;
    },
  };
}

describe("opening a transport context", () => {
  it("completes the handshake and returns ctxId, expiresAt and a ticket inside msg2", async () => {
    const { res, payload, rawResponse } = await open("ws");

    expect(res.status).toBe(200);
    expect(payload.v).toBe(1);
    // §12 encodings: both are 16 bytes as 22 unpadded base64url characters.
    expect(payload.ctxId).toHaveLength(22);
    expect(payload.ticket).toHaveLength(22);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());

    // The context is live and addressable by exactly that handle.
    expect(registry.get(payload.ctxId)?.kind).toBe("ws");
    // And the ticket it named spends once, for that context.
    expect(registry.consumeTicket(payload.ticket as string)).toBe(payload.ctxId);

    // Neither the ticket nor the ctxId appears OUTSIDE the AEAD. A ticket in an
    // outer field would be a credential in a body any proxy can read.
    expect(rawResponse).not.toContain(payload.ticket as string);
    expect(rawResponse).not.toContain(payload.ctxId);
  });

  it("advertises the deadline that actually applies, for BOTH kinds (§8, §12)", async () => {
    // Every context starts provisional and is collected at the 30 s ticket TTL
    // unless something authenticates under it. Advertising the 24 h lifetime
    // here would be a promise the registry does not keep: a client that opened
    // a REST context and sent its first request a minute later would get
    // `E2EE_CTX_UNKNOWN` from a context it was told it owned for a day.
    for (const kind of ["ws", "rest"] as const) {
      const { payload } = await open(kind);
      expect(payload.provisional, kind).toBe(true);
      expect(payload.expiresAt - Date.now(), kind).toBeLessThanOrEqual(30_000);
      expect(registry.get(payload.ctxId)?.provisional, kind).toBe(true);
      // The advertised deadline is the registry's own, not a second number.
      expect(registry.get(payload.ctxId)?.expiresAt, kind).toBe(payload.expiresAt);
    }
  });

  it("extends a socket context past its provisional deadline once the ticket is spent", async () => {
    const { payload } = await open("ws");
    registry.consumeTicket(payload.ticket as string);
    const promoted = registry.get(payload.ctxId);
    expect(promoted?.provisional).toBe(false);
    expect(promoted?.expiresAt).toBeGreaterThan(Date.now() + 60_000);
  });

  it("opens a REST context with no ticket, alongside the socket's own context", async () => {
    const device = pairDevice();
    const ws = await open("ws", device);
    const rest = await open("rest", device);

    expect(rest.payload.ticket).toBeUndefined();
    expect(rest.payload.ctxId).not.toBe(ws.payload.ctxId);
    expect(registry.get(ws.payload.ctxId)?.kind).toBe("ws");
    expect(registry.get(rest.payload.ctxId)?.kind).toBe("rest");
  });

  it("assigns a fresh random ctxId per handshake, never one the client derives", async () => {
    const device = pairDevice();
    const first = await open("ws", device);
    const second = await open("ws", device);
    expect(second.payload.ctxId).not.toBe(first.payload.ctxId);
  });
});

describe("failing closed (§9, §10)", () => {
  it("refuses a static key with no device row, and one whose row is revoked", async () => {
    // No row at all.
    const stranger = generateKeyPair();
    const unknown = await post(message1(stranger, { v: 1, kind: "ws" }).body);
    expect(unknown.status).toBe(403);
    expect((await unknown.json()).code).toBe(E2EE_DEVICE_REVOKED);

    // A row that exists and is revoked. "Absent" and "invalid" are different
    // answers and neither is success.
    const device = pairDevice();
    repo.revoke(device.deviceId);
    const revoked = await post(message1(device.staticKeyPair, { v: 1, kind: "ws" }).body);
    expect(revoked.status).toBe(403);
    const body = await revoked.json();
    expect(body.code).toBe(E2EE_DEVICE_REVOKED);

    // §9: a revocation and a context lost to a restart must not arrive under
    // one code. The client surfaces the first and silently re-handshakes the
    // second, so collapsing them makes it do the wrong one.
    expect(body.code).not.toBe(E2EE_CTX_UNKNOWN);
    expect(registry.size).toBe(0);
  });

  it("loses every context to a restart, which is the recoverable code and not the hard one", async () => {
    const { payload } = await open("rest");
    expect(registry.get(payload.ctxId)).not.toBeNull();

    // A streamer restart: contexts are in-memory only (§8).
    registry.clear();

    // Unresolvable — which the caller reports as E2EE_CTX_UNKNOWN, the code a
    // client recovers from with one transparent re-handshake.
    expect(registry.get(payload.ctxId)).toBeNull();
    expect(E2EE_CTX_UNKNOWN).not.toBe(E2EE_DEVICE_REVOKED);
  });

  it("refuses an oversized body before it decrypts anything (§10)", async () => {
    const device = pairDevice();
    const { body } = message1(device.staticKeyPair, { v: 1, kind: "ws" });
    // A real handshake, buried in padding that is larger than the bound. The
    // bound is on the ENCODED bytes as they arrive, so this is refused before
    // any base64 is decoded and before the handshake runs.
    const padded = `${body.slice(0, -1)},"pad":"${"A".repeat(ROUTE_MAX_BODY * 2)}"}`;
    expect(padded.length).toBeGreaterThan(ROUTE_MAX_BODY);

    const res = await post(padded);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("E2EE_MALFORMED");
    // Nothing was opened, so nothing allocated a context for it either.
    expect(registry.size).toBe(0);
  });

  it("refuses an oversized CHUNKED body without buffering it (§10)", async () => {
    // No `Content-Length` at all, so the declared-length check cannot fire and
    // the running total is the only thing between a public endpoint and an
    // unbounded buffer. This is the case the shared `readBody` helper gets
    // wrong: it concatenates every chunk and only then applies a bound.
    //
    // The body is a REAL, complete handshake with padding in front of it, so an
    // unbounded reader would answer 200 — which is what makes this a test of
    // the bound rather than of JSON parsing.
    const device = pairDevice();
    const { body } = message1(device.staticKeyPair, { v: 1, kind: "ws" });
    const padded = `{"pad":"${"A".repeat(512 * 1024)}",${body.slice(1)}`;

    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/e2ee/open",
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      // Written in chunks, so nothing ever declares the total size.
      for (let i = 0; i < padded.length; i += 64 * 1024) {
        req.write(padded.slice(i, i + 64 * 1024));
      }
      req.end();
    });

    expect(status).toBe(400);
    expect(registry.size).toBe(0);
  });

  it("refuses a spent failure budget BEFORE any Diffie-Hellman runs (§10)", async () => {
    // Long enough to pass the size check, so each of these really does reach
    // `readMessage1` and really does cost two DH — the cost this budget bounds.
    const garbage = JSON.stringify({
      e2ee: { v: 1, noise: randomBytes(220).toString("base64") },
    });

    for (let i = 0; i < OPEN_SOURCE_FAILURE_LIMIT; i++) {
      expect((await post(garbage)).status).toBe(400);
    }
    expect(noiseCalls.readMessage1).toBe(OPEN_SOURCE_FAILURE_LIMIT);

    // The next one is refused, and the handshake was never entered. A budget
    // that is charged but never consulted bounds nothing; this is the assertion
    // that tells the two apart.
    noiseCalls.readMessage1 = 0;
    const refused = await post(garbage);
    expect(refused.status).toBe(429);
    expect(noiseCalls.readMessage1).toBe(0);
  });

  it("charges a WELL-FORMED handshake from an unpaired key, which is the flood that costs DH (adversary D)", async () => {
    // The server's static key is public, so anyone can mint unlimited valid
    // msg1s from fresh keypairs. Each costs two Diffie-Hellmans and is refused
    // only at the device lookup — so charging solely on a malformed handshake
    // left exactly the expensive flood uncounted. Fifty of these once tripped
    // nothing at all.
    let limited = 0;
    let refusedAsUnpaired = 0;
    for (let i = 0; i < 50; i++) {
      const stranger = generateKeyPair();
      const res = await post(message1(stranger, { v: 1, kind: "ws" }).body);
      if (res.status === 429) limited++;
      else if (res.status === 403) refusedAsUnpaired++;
    }

    expect(refusedAsUnpaired).toBe(OPEN_SOURCE_FAILURE_LIMIT);
    expect(limited).toBe(50 - OPEN_SOURCE_FAILURE_LIMIT);
    // And the DH count is bounded by the budget rather than by the flood.
    expect(noiseCalls.readMessage1).toBe(OPEN_SOURCE_FAILURE_LIMIT);
    expect(registry.size).toBe(0);
  });

  it("does not let a stranger's failures lock out a paired device (adversary E)", async () => {
    // Five malformed messages used to exhaust the whole bucket for that
    // address — including a paired device mid-recovery, which is the exact
    // path §8 describes as needing to work after a restart.
    const garbage = JSON.stringify({
      e2ee: { v: 1, noise: randomBytes(220).toString("base64") },
    });
    const device = pairDevice();
    for (let i = 0; i < 5; i++) {
      expect((await post(garbage)).status).toBe(400);
    }

    // The device's own recovery: two opens, socket and REST, as after a
    // streamer restart. Status is asserted on the raw response, before msg2 is
    // decoded — a 429 must fail here as a refused recovery, not three lines
    // later as an unparseable handshake.
    for (const kind of ["ws", "rest"] as const) {
      const res = await post(message1(device.staticKeyPair, { v: 1, kind }).body);
      expect(res.status, `${kind} recovery`).toBe(200);
    }

    // And a success costs the source budget nothing, so the margin is intact.
    for (let i = 0; i < OPEN_SOURCE_FAILURE_LIMIT - 5; i++) {
      expect((await post(garbage)).status).toBe(400);
    }
    expect((await post(garbage)).status).toBe(429);
  });

  it("rate-limits per authenticated device, not per source address (§8)", async () => {
    // Behind a Cloudflare tunnel every request arrives from 127.0.0.1, so an
    // IP-keyed bucket is ONE bucket for the whole fleet — it 429s legitimate
    // devices out of the re-open storm §8 describes. Keyed on the static key,
    // one device exhausting its budget leaves every other device untouched.
    const noisy = pairDevice();
    for (let i = 0; i < PAIR_EXCHANGE_LIMIT; i++) {
      expect((await post(message1(noisy.staticKeyPair, { v: 1, kind: "ws" }).body)).status).toBe(
        200,
      );
    }
    expect((await post(message1(noisy.staticKeyPair, { v: 1, kind: "ws" }).body)).status).toBe(429);

    // Same IP, different device: unaffected.
    const quiet = pairDevice();
    expect((await post(message1(quiet.staticKeyPair, { v: 1, kind: "ws" }).body)).status).toBe(200);
  });

  it("refuses a replayed msg1 before any Diffie-Hellman (adversary E-1)", async () => {
    // ONE captured message, replayed. Every replay is a COMPLETE, authentic
    // handshake — it never throws and it resolves to a live device row — so
    // neither budget saw it, and a thousand replays ran two thousand X25519
    // operations.
    const device = pairDevice();
    const captured = message1(device.staticKeyPair, { v: 1, kind: "ws" }).body;

    expect((await post(captured)).status).toBe(200);
    expect(noiseCalls.readMessage1).toBe(1);

    noiseCalls.readMessage1 = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) statuses.push((await post(captured)).status);

    // Not one more handshake — 200 replays, zero Diffie-Hellman.
    expect(noiseCalls.readMessage1).toBe(0);
    // Every replay refused, and the source budget charged: the first
    // `OPEN_SOURCE_FAILURE_LIMIT` are handshake failures, the rest are the
    // source's ceiling. Nothing succeeds.
    expect(statuses.filter((s) => s === 400)).toHaveLength(OPEN_SOURCE_FAILURE_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(200 - OPEN_SOURCE_FAILURE_LIMIT);
    expect(statuses.filter((s) => s === 200)).toHaveLength(0);
  });

  it("charges a replay to the SOURCE, never to the replayed device (adversary E-2)", async () => {
    // The sharp version: because a replay authenticates AS THE VICTIM, keying
    // the limiter on the authenticated device is what made this targeted —
    // five replays spent the victim's own minute and pushed it past its
    // four-socket cap, retiring a live context.
    const victim = pairDevice();
    const captured = message1(victim.staticKeyPair, { v: 1, kind: "ws" }).body;
    expect((await post(captured)).status).toBe(200);
    const opened = registry.forDevice(victim.deviceId).map((c) => c.ctxId);

    for (let i = 0; i < 20; i++) expect((await post(captured)).status).toBe(400);

    // The victim's own budget is untouched: it can still open, repeatedly.
    for (let i = 0; i < 3; i++) {
      const res = await post(message1(victim.staticKeyPair, { v: 1, kind: "ws" }).body);
      expect(res.status, `victim open ${i}`).toBe(200);
    }
    // Its first context was never evicted by the replays.
    expect(registry.get(opened[0])).not.toBeNull();
  });

  it("does not let garbage occupy the replay cache (§10)", async () => {
    // The cache is recorded only for a message that actually reached the
    // handshake, so a flood of malformed bytes cannot fill the bound that
    // exists to survive a flood. The same bytes twice must therefore cost two
    // handshake attempts, not one plus a cache hit.
    const sameBytes = randomBytes(220);
    const garbage = JSON.stringify({ e2ee: { v: 1, noise: sameBytes.toString("base64") } });

    expect((await post(garbage)).status).toBe(400);
    expect((await post(garbage)).status).toBe(400);
    expect(noiseCalls.readMessage1).toBe(2);
  });

  it("does not let an unknown key age the replay cache (round 3, finding 2)", async () => {
    // `record()` runs only after the device row resolves. Anywhere earlier and
    // unauthenticated traffic drives the eviction clock: one permitted source
    // contributes ~43 200 entries a day, two fill the cache inside a day, and
    // eviction then discards the OLDEST entries — which is exactly where a
    // captured victim's msg1 lives.
    //
    // Observable proof of the placement: the SAME unknown-key message twice
    // must cost TWO handshakes. If it had been recorded, the second would be a
    // cache hit — a `400` with no Diffie-Hellman.
    const stranger = generateKeyPair();
    const unknownKey = message1(stranger, { v: 1, kind: "ws" }).body;

    expect((await post(unknownKey)).status).toBe(403);
    noiseCalls.readMessage1 = 0;
    expect((await post(unknownKey)).status).toBe(403);
    expect(noiseCalls.readMessage1).toBe(1);

    // The control: a PAIRED device's message is recorded, so its replay is a
    // cache hit with no handshake at all. Same cache, opposite outcome — which
    // is what makes the assertion above about the device row and not about the
    // cache being broken.
    const paired = pairDevice();
    const captured = message1(paired.staticKeyPair, { v: 1, kind: "ws" }).body;
    expect((await post(captured)).status).toBe(200);
    noiseCalls.readMessage1 = 0;
    expect((await post(captured)).status).toBe(400);
    expect(noiseCalls.readMessage1).toBe(0);
  });

  it("refuses a retry that re-sends the same bytes, and accepts one that re-handshakes (§11)", async () => {
    // The retry obligation, end to end. A client whose response was lost — a
    // timeout, a dropped connection, a `429` — must run `writeMessage1` afresh.
    // Re-sending the previous bytes is indistinguishable from a replay and is
    // refused for the life of the cache entry, which is a client obligation
    // written into the contract rather than something the server can rescue.
    const device = pairDevice();
    const attempt = message1(device.staticKeyPair, { v: 1, kind: "ws" });

    // The open succeeds; imagine the client never sees this response.
    expect((await post(attempt.body)).status).toBe(200);

    // The wrong retry: the same bytes again.
    const wrongRetry = await post(attempt.body);
    const wrongBody = await wrongRetry.json();
    expect(wrongRetry.status).toBe(400);
    expect(wrongBody.code).toBe("E2EE_HANDSHAKE_FAILED");

    // The right retry: a fresh `writeMessage1`, which is what §11 requires.
    const rightRetry = await post(message1(device.staticKeyPair, { v: 1, kind: "ws" }).body);
    expect(rightRetry.status).toBe(200);
  });

  it("tells a replay nothing that distinguishes it from any other handshake failure (§11)", async () => {
    // Deliberate indistinguishability, pinned so nobody later "improves" the
    // diagnostic: telling an attacker which of its guesses was a replay is
    // worse than the diagnostic being unavailable. The cost is that a client
    // retrying wrongly cannot tell why — which is why the rule lives in the
    // contract instead.
    const device = pairDevice();
    const attempt = message1(device.staticKeyPair, { v: 1, kind: "ws" });
    expect((await post(attempt.body)).status).toBe(200);

    const replay = await post(attempt.body);
    const replayText = await replay.text();

    // A different handshake failure entirely: a message for a server key this
    // server does not hold.
    const impostor = generateKeyPair();
    const wrongKey = writeMessage1({
      staticKeyPair: device.staticKeyPair,
      responderStaticPub: impostor.publicKeyRaw,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
      prologue: OPEN_PROLOGUE,
    });
    const other = await post(
      JSON.stringify({ e2ee: { v: 1, noise: wrongKey.message.toString("base64") } }),
    );
    const otherText = await other.text();

    // Byte-identical status and body — there is nothing in the answer to tell
    // the two apart.
    expect(replay.status).toBe(other.status);
    expect(replayText).toBe(otherText);
    for (const word of ["replay", "replayed", "cache", "seen", "ephemeral", "duplicate"]) {
      expect(replayText.toLowerCase()).not.toContain(word);
    }
    // And no header leaks it either.
    expect(JSON.stringify([...replay.headers])).toBe(JSON.stringify([...other.headers]));
  });

  it("lets a device open twice: two handshakes, two ephemerals — the positive control", async () => {
    // If a fresh ephemeral were ever mistaken for a repeat, this is the test
    // that fails: legitimate clients open repeatedly and must never be told
    // they replayed.
    const device = pairDevice();
    const first = await open("ws", device);
    const second = await open("rest", device);
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(first.payload.ctxId).not.toBe(second.payload.ctxId);
    expect(noiseCalls.readMessage1).toBe(2);
  });

  it("refuses a body with no e2ee field, a wrong version, and an unnamed context kind", async () => {
    const device = pairDevice();

    const bare = await post(JSON.stringify({}));
    expect(bare.status).toBe(400);
    expect((await bare.json()).code).toBe("E2EE_MALFORMED");

    const wrongVersion = await post(JSON.stringify({ e2ee: { v: 99, noise: "AAAA" } }));
    expect(wrongVersion.status).toBe(400);
    expect((await wrongVersion.json()).code).toBe("E2EE_VERSION_UNSUPPORTED");

    // `kind` lives inside the AEAD, so this one only fails after a successful
    // handshake — which is the point: an intermediary cannot supply it.
    const noKind = await post(message1(device.staticKeyPair, { v: 1 }).body);
    expect(noKind.status).toBe(400);
    expect((await noKind.json()).code).toBe("E2EE_MALFORMED");
  });

  it("refuses a handshake against the wrong server static key", async () => {
    const device = pairDevice();
    const impostor = generateKeyPair();
    const { message } = writeMessage1({
      staticKeyPair: device.staticKeyPair,
      responderStaticPub: impostor.publicKeyRaw,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
      prologue: OPEN_PROLOGUE,
    });

    const res = await post(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("E2EE_HANDSHAKE_FAILED");
  });

  it("refuses a message built for the PAIRING handshake (§11)", async () => {
    const device = pairDevice();
    const { message } = writeMessage1({
      staticKeyPair: device.staticKeyPair,
      responderStaticPub: serverStaticPub,
      psk: pskFromPairToken("pt_00112233445566778899aabbccddeeff"),
      payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
      // The PAIRING prologue, stated: it is a required parameter now, because
      // defaulting it let a polluted prototype pick the wrong namespace (§11).
      // The psk makes this `IKpsk1`. Both differences are domain separation.
      prologue: PAIR_PROLOGUE,
    });

    const res = await post(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("E2EE_HANDSHAKE_FAILED");
  });
});

describe("prologue separation (§11)", () => {
  // Isolates the PROLOGUE. Both messages here are psk-less `IK` — the same
  // pattern and the same protocol name — so the prologue is the only thing that
  // differs, which is what makes this test about the prologue rather than about
  // the three separations together.
  it("refuses a psk-less message built with the PAIRING prologue", async () => {
    const device = pairDevice();
    const { message } = writeMessage1({
      staticKeyPair: device.staticKeyPair,
      responderStaticPub: serverStaticPub,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
      prologue: PAIR_PROLOGUE,
    });

    const res = await post(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("E2EE_HANDSHAKE_FAILED");

    // The positive control: the same construction with the OPEN prologue is
    // accepted, so the refusal above is the prologue and not the shape.
    const ok = await post(message1(device.staticKeyPair, { v: 1, kind: "ws" }).body);
    expect(ok.status).toBe(200);
  });
});

describe("/open handshake vectors (§11, §16)", () => {
  const open = vectors.open;

  it("names the psk-less pattern and its own prologue", () => {
    expect(open.protocolName).toBe(NOISE_IK_PROTOCOL_NAME);
    expect(open.protocolName).not.toBe("Noise_IKpsk1_25519_ChaChaPoly_SHA256");
    expect(open.prologueUtf8).toBe(OPEN_PROLOGUE.toString("utf-8"));
    expect(open.psk).toBeNull();
  });

  it("reproduces message 1 and message 2 byte for byte", () => {
    const clientStatic = keyPairFromRawPrivate(
      Buffer.from(open.keys.clientStaticPrivate, "base64"),
    );
    const serverStatic = keyPairFromRawPrivate(
      Buffer.from(open.keys.serverStaticPrivate, "base64"),
    );
    const clientEphemeral = keyPairFromRawPrivate(
      Buffer.from(open.keys.clientEphemeralPrivate, "base64"),
    );
    const serverEphemeral = keyPairFromRawPrivate(
      Buffer.from(open.keys.serverEphemeralPrivate, "base64"),
    );

    const { message, state } = writeMessage1({
      staticKeyPair: clientStatic,
      responderStaticPub: serverStatic.publicKeyRaw,
      pattern: "IK",
      payload: Buffer.from(open.payload1Utf8, "utf-8"),
      prologue: OPEN_PROLOGUE,
      ephemeral: clientEphemeral,
    });
    expect(message.toString("base64")).toBe(open.message1);

    const responded = respond({
      staticKeyPair: serverStatic,
      pattern: "IK",
      message1: message,
      prologue: OPEN_PROLOGUE,
      buildPayload: () => Buffer.from(open.payload2Utf8, "utf-8"),
      ephemeral: serverEphemeral,
    });
    expect(responded.message2.toString("base64")).toBe(open.message2);

    const clientSide = readMessage2(state, responded.message2);
    expect(clientSide.payload.toString("utf-8")).toBe(open.payload2Utf8);
    // `consume()` is the only way to the keys, and it hands over KeyObjects;
    // `export()` here is a TEST reach for needle bytes, which no `src/` caller
    // makes — asserted by its own test.
    const clientKeys = clientSide.keys.consume();
    expect(clientKeys.handshakeHash.toString("base64")).toBe(open.handshakeHash);
    expect(clientKeys.clientToServer.export().toString("base64")).toBe(open.clientToServerKey);
    expect(clientKeys.serverToClient.export().toString("base64")).toBe(open.serverToClientKey);
  });

  // Without this the domain separation is a claim rather than a property: a
  // pairing msg1 and an `/open` msg1 would otherwise differ only by the psk
  // step, and defaulting the prologue would silently remove the difference.
  it("refuses a PAIRING vector against the open prologue", () => {
    const serverStatic = keyPairFromRawPrivate(
      Buffer.from(open.keys.serverStaticPrivate, "base64"),
    );
    const pairingMsg1 = Buffer.from(open.pairingMessage1RejectedHere.message1, "base64");

    expect(() =>
      readMessage1({
        staticKeyPair: serverStatic,
        pattern: "IK",
        message1: pairingMsg1,
        prologue: OPEN_PROLOGUE,
      }),
    ).toThrow();

    // The positive control: the same bytes DO read under the pairing pattern,
    // so the refusal above is about the prologue and the pattern rather than
    // about a vector that never worked.
    expect(() =>
      readMessage1({
        staticKeyPair: serverStatic,
        psk: Buffer.from(pairVectors.psk, "base64"),
        message1: pairingMsg1,
        prologue: PAIR_PROLOGUE,
      }),
    ).not.toThrow();
  });
});
