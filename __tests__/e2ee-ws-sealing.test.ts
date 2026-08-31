import { serve } from "@hono/node-server";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { request as httpRequest, type Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { type WebSocket, WebSocket as WsClient } from "ws";
import { createHonoApp } from "../src/api/app";
import {
  createWsRoutes,
  mountWebSocket,
  WS_MAX_CLIENT_FRAME_BYTES,
} from "../src/api/routes/ws.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import {
  authenticateContext,
  CONTEXT_DRAIN_MS,
  contextRegistry,
  type E2eeContext,
  MAX_WS_CONTEXTS_PER_DEVICE,
  newCtxId,
  TICKET_HEADER,
} from "../src/e2ee/context";
import {
  generateKeyPair,
  type KeyPair,
  OPEN_PROLOGUE,
  readMessage2,
  type TrafficKeys,
  writeMessage1,
} from "../src/e2ee/noise";
import {
  E2EE_CTX_UNKNOWN,
  E2EE_DEVICE_REVOKED,
  E2EE_PROTOCOL_VERSION,
  E2EE_SEAL_FAILED,
  E2EE_SEQUENCE_VIOLATION,
} from "../src/e2ee/protocol";
import {
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  RecordError,
  type RecordState,
} from "../src/e2ee/record";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import { type ApiDepsWiring, createApiDeps } from "../src/server-wiring";
import { WS_FIRST_FRAME_DEADLINE_MS, WSHub } from "../src/ws-hub";

/**
 * W1b — sealing the WebSocket. NONCE-DESIGN §5, §8, §9, §10, §12.
 *
 * Nothing about the transition under test is stubbed: a real `http.Server` on
 * loopback, the real Hono app with its real auth middleware, the real
 * `@hono/node-ws` upgrade, a real `WSHub`, real `ws` sockets, a real `devices`
 * row in a real runtime.db, the real `POST /api/e2ee/open` handshake driven
 * from the client side, and real `RecordState`s on both ends. The only thing
 * this file supplies is the session machinery `handleWsMessage` talks to, which
 * is not the transition under test.
 *
 * The capture harness is `frames` below: every byte the server puts on the wire,
 * before the client's record layer touches it. Its NEGATIVE CONTROL is the
 * legacy socket — same harness, same assertions, sealing off — which shows
 * plaintext. Without that, "no plaintext seen" would be indistinguishable from
 * a harness that sees nothing at all.
 */

const registry = contextRegistry();

let dir: string;
let store: RuntimeStore;
let repo: DevicesRepository;
let hub: WSHub;
let server: Server;
let baseUrl: string;
let wsUrl: string;
let serverStaticPub: Buffer;
let savedConfigDir: string | undefined;
/** Every `http.request` line the app logged, for the "the ticket is nowhere" test. */
let httpLines: string[];
let open: WsClient[];
/** The principal the /ws route resolved for the last inbound frame. */
let lastPrincipal: { kind: string; deviceId?: string } | null;

const API_KEY = "tb_0123456789abcdef0123456789abcdef";

vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  return {
    ...actual,
    getLogger: (component?: string) => {
      const real = actual.getLogger(component);
      return {
        ...real,
        info: (msg: string, meta?: unknown) => {
          capture(msg, meta);
          return real.info(msg, meta);
        },
        warn: (msg: string, meta?: unknown) => {
          capture(msg, meta);
          return real.warn(msg, meta);
        },
      };
    },
  };
});

/** Records every log line, message AND structured fields, verbatim. */
function capture(msg: string, meta?: unknown): void {
  if (!httpLines) return;
  httpLines.push(`${msg} ${JSON.stringify(meta ?? {})}`);
}

beforeAll(() => {
  savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "tb-e2ee-ws-"));
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

async function startServer(hubOptions: { firstFrameMs?: number } = {}): Promise<void> {
  registry.clear();
  lastPrincipal = null;
  httpLines = [];
  open = [];
  hub = new WSHub(hubOptions);

  // The real `handleWsOpen` / `handleWsMessage` / `handleWsClose`, over a real
  // hub. Only the session machinery below them is supplied — a live PTY is not
  // the transition under test, and standing one up would test the wiring.
  const wiring = {
    wsHub: hub,
    withReconciledLifecycle: (s: unknown) => s,
    sessionStore: { list: () => [] },
    ptyAttachedIds: () => new Set<string>(),
    currentWarmupState: () => false,
    cacheMonitor: () => null,
    hostPressureMonitor: () => null,
    startGraceTimer: vi.fn(),
    armHoldWhenIdle: vi.fn(),
    addSessionSubscriber: vi.fn(),
    removeSessionSubscriber: vi.fn(),
    ptyGracePeriodMs: 1000,
    wsToClientId: new Map(),
    clientIdToWs: new Map(),
    sessionSubscribers: new Map(),
    terminalSeq: new Map(),
    pendingPermission: new Map(),
    pendingQuestions: new Map(),
    ptyManager: { hasSession: () => false },
    log: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  } as unknown as ApiDepsWiring;
  const wired = createApiDeps(wiring);

  const deps = {
    apiKey: API_KEY,
    localNoAuth: false,
    logMenubarRequests: true,
    devicesRepo: () => repo,
    featureFlagsConfig: () => ({ registry: [], values: { e2ee: true }, sources: {} }),
    wsHub: hub,
    handleWsOpen: wired.handleWsOpen,
    // A pass-through recorder on the REAL handler — it runs the genuine one and
    // only notes which principal the route resolved. That is the one way to
    // assert the A2 invariant, since a socket has no HTTP status to look at.
    handleWsMessage: (ws: unknown, raw: unknown, principal: unknown) => {
      lastPrincipal = principal as { kind: string; deviceId?: string } | null;
      return (wired.handleWsMessage as (a: unknown, b: unknown, c: unknown) => void)(
        ws,
        raw,
        principal,
      );
    },
    handleWsClose: wired.handleWsClose,
  } as unknown as ApiDeps;

  const app = createHonoApp(deps);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  await new Promise((r) => server.once("listening", r));
  // The PRODUCTION wiring, called rather than copied: the frame ceiling and the
  // upgrade mount live in one function so a test cannot assert on its own copy.
  mountWebSocket(app, server, deps);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
}

beforeEach(async () => {
  repo.deleteRevoked();
  await startServer();
});

/** Rebuild the whole rig with different hub options. */
async function restartWith(hubOptions: { firstFrameMs?: number }): Promise<void> {
  for (const c of open) {
    try {
      c.terminate();
    } catch {
      /* already gone */
    }
  }
  hub.dispose();
  await new Promise((r) => server.close(r));
  await startServer(hubOptions);
}

afterEach(async () => {
  for (const c of open) {
    try {
      c.terminate();
    } catch {
      /* already gone */
    }
  }
  hub.dispose();
  await new Promise((r) => server.close(r));
});

// ─── the client half ────────────────────────────────────────────────

interface Device {
  deviceId: string;
  deviceToken: string;
  staticKeyPair: KeyPair;
}

/** A real paired, e2ee-PINNED device row. `register` sets `e2ee_required` itself. */
function pairDevice(): Device {
  const staticKeyPair = generateKeyPair();
  const { deviceId, deviceToken } = repo.register({
    publicKey: `legacy-${staticKeyPair.publicKeyRaw.toString("base64url").slice(0, 8)}`,
    e2eeStaticPub: staticKeyPair.publicKeyRaw.toString("base64"),
    e2eeVersion: E2EE_PROTOCOL_VERSION,
  });
  return { deviceId, deviceToken, staticKeyPair };
}

interface OpenedContext {
  ctxId: string;
  ticket: string;
  keys: TrafficKeys;
  /** The CLIENT's own record states — its keys, its counters, its own module. */
  send: RecordState;
  receive: RecordState;
}

/** Drive a real `POST /api/e2ee/open` and build the client's record states. */
async function openContext(device: Device): Promise<OpenedContext> {
  const { message, state } = writeMessage1({
    staticKeyPair: device.staticKeyPair,
    responderStaticPub: serverStaticPub,
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: E2EE_PROTOCOL_VERSION, kind: "ws" }), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  const res = await fetch(`${baseUrl}/api/e2ee/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ e2ee: { v: E2EE_PROTOCOL_VERSION, noise: message.toString("base64") } }),
  });
  const outer = (await res.json()) as { e2ee: { noise: string } };
  const read = readMessage2(state, Buffer.from(outer.e2ee.noise, "base64"));
  const payload = JSON.parse(read.payload.toString("utf-8")) as { ctxId: string; ticket: string };
  const keys = read.keys.consume();
  const ctxIdRaw = Buffer.from(payload.ctxId, "base64url");
  return {
    ctxId: payload.ctxId,
    ticket: payload.ticket,
    keys,
    send: createRecordState({
      key: keys.clientToServer,
      ctxId: ctxIdRaw,
      direction: DIRECTION_C2S,
      channel: CHANNEL_WS,
    }),
    receive: createRecordState({
      key: keys.serverToClient,
      ctxId: ctxIdRaw,
      direction: DIRECTION_S2C,
      channel: CHANNEL_WS,
    }),
  };
}

/**
 * The capture harness: every byte the server sent, exactly as it left the wire.
 *
 * `frames` is filled BEFORE the client's record layer sees anything, which is
 * what makes "no plaintext `type` field" a statement about the wire rather than
 * about the client.
 */
interface Client {
  ws: WsClient;
  frames: Buffer[];
  closes: Array<{ code: number; reason: string }>;
  /** Resolves once the server has sent `n` frames. */
  until(n: number, ms?: number): Promise<void>;
  closed(ms?: number): Promise<{ code: number; reason: string }>;
}

function connect(headers: Record<string, string>, query = ""): Promise<Client> {
  const ws = new WsClient(wsUrl + query, { headers });
  open.push(ws);
  const frames: Buffer[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    frames.push(isBinary ? Buffer.from(data) : Buffer.from(String(data), "utf-8"));
  });
  ws.on("close", (code: number, reason: Buffer) => {
    closes.push({ code, reason: reason.toString("utf-8") });
  });
  const client: Client = {
    ws,
    frames,
    closes,
    until: (n, ms = 2000) => poll(() => frames.length >= n, ms, `${n} frames`),
    closed: async (ms = 2000) => {
      await poll(() => closes.length > 0, ms, "a close");
      return closes[0];
    },
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

/** The upgrade's HTTP status, for a connection that is meant to be refused. */
function refusedStatus(headers: Record<string, string>, query = ""): Promise<number> {
  const ws = new WsClient(wsUrl + query, { headers });
  open.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () =>
      reject(new Error("the upgrade was accepted; it should have been refused")),
    );
    ws.once("error", (err) => reject(err));
  });
}

/**
 * The SERVER-side sockets, in the order the hub accepted them.
 *
 * The three send paths take the server's end of a connection; a test that
 * handed them the client's end would be exercising nothing. Insertion order,
 * so `serverSockets()[i]` is the socket for `clients[i]`.
 */
function serverSockets(): Array<{ bufferedAmount: number; readyState: number }> {
  return [
    ...(hub as never as { clients: Set<{ bufferedAmount: number; readyState: number }> }).clients,
  ];
}

function fakeServerSocket(): {
  ws: WebSocket;
  close: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const ping = vi.fn();
  const send = vi.fn();
  return {
    ws: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      on: vi.fn(),
      close,
      send,
      ping,
    } as unknown as WebSocket,
    close,
    ping,
    send,
  };
}

function openServerContext(deviceId: string, now: number): E2eeContext {
  const { raw, id } = newCtxId();
  const clientToServer = randomBytes(32);
  const serverToClient = randomBytes(32);
  return registry.open({
    deviceId,
    kind: "ws",
    ctxIdRaw: raw,
    ctxId: id,
    keys: { clientToServer, serverToClient, handshakeHash: randomBytes(32) } as never,
    now,
  });
}

function contextCanSeal(context: E2eeContext): boolean {
  try {
    context.sendState(CHANNEL_WS).seal(Buffer.from("{}"));
    return true;
  } catch {
    return false;
  }
}

/** The hub's private per-socket context map, for the detach test below. */
function hubContexts(): Map<unknown, { ctxId: string }> {
  return (hub as never as { contexts: Map<unknown, { ctxId: string }> }).contexts;
}

/**
 * Unseal every frame this client has received since the last call.
 *
 * The client's receive state is STRICT, so frames must be opened in order and
 * exactly once — draining is the only correct way to read a subset.
 */
const cursors = new WeakMap<Client, number>();
function drain(client: Client, ctx: OpenedContext): Array<Record<string, unknown>> {
  const from = cursors.get(client) ?? 0;
  const out = client.frames
    .slice(from)
    .map((f) => JSON.parse(ctx.receive.unseal(f).toString("utf-8")) as Record<string, unknown>);
  cursors.set(client, client.frames.length);
  return out;
}

/** POST with `Transfer-Encoding: chunked` and NO `Content-Length` header. */
function rawChunkedPost(path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${baseUrl}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function poll(done: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** `(direction, counter)` off a record's plaintext header (§4). */
function headerOf(frame: Buffer): { ctxId: string; direction: number; counter: bigint } {
  return {
    ctxId: frame.subarray(1, 17).toString("base64url"),
    direction: frame.readUInt32BE(17),
    counter: frame.readBigUInt64BE(21),
  };
}

const bearer = (d: Device) => ({ authorization: `Bearer ${d.deviceToken}` });

// ─── ciphertext on the wire, and the control that proves the harness works ───

describe("what a capture of a real socket shows", () => {
  it("shows ciphertext — no plaintext `type` field anywhere on the wire", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });

    // handleWsOpen unicasts session_list and cache_ready on connect; then a
    // broadcast, a scoped broadcast and a unicast — all three send paths.
    await client.until(2);
    hub.broadcast({ type: "session_update", session: { id: "s1" } } as never);
    hub.broadcastToClients(
      serverSockets() as never,
      {
        type: "terminal_output",
        sessionId: "s1",
        data: "total 8\ndrwxr-xr-x  fixtures\n",
      } as never,
    );
    hub.unicast(serverSockets()[0] as never, { type: "ping", ts: 1 } as never);
    await client.until(5);

    const wire = Buffer.concat(client.frames).toString("latin1");
    expect(wire).not.toContain("type");
    expect(wire).not.toContain("session_list");
    expect(wire).not.toContain("terminal_output");
    expect(wire).not.toContain("drwxr-xr-x");

    // And it IS the real messages underneath — sealed, not merely absent.
    const types = drain(client, ctx).map((m) => m.type);
    expect(types).toEqual([
      "session_list",
      "cache_ready",
      "session_update",
      "terminal_output",
      "ping",
    ]);
  });

  it("NEGATIVE CONTROL: the same harness shows plaintext when sealing is off", async () => {
    // A legacy `?key=` client — no ticket, no context, the dual path that must
    // keep working. If this saw ciphertext too, the test above would prove
    // nothing about sealing and everything about a blind harness.
    const client = await connect({ authorization: `Bearer ${API_KEY}` });
    await client.until(2);
    hub.broadcastToClients(
      serverSockets() as never,
      {
        type: "terminal_output",
        sessionId: "s1",
        data: "drwxr-xr-x  fixtures\n",
      } as never,
    );
    await client.until(3);

    const wire = Buffer.concat(client.frames).toString("latin1");
    expect(wire).toContain('"type"');
    expect(wire).toContain("session_list");
    expect(wire).toContain("terminal_output");
    expect(wire).toContain("drwxr-xr-x");
    expect(hub.sealedCount).toBe(0);
  });
});

// ─── (a) nonce reuse ────────────────────────────────────────────────

describe("(a) nonce reuse", () => {
  it("never repeats a (direction, counter) within a context, across a full session and a reconnect", async () => {
    const device = pairDevice();
    const seen = new Set<string>();
    const ctxIds: string[] = [];

    for (const pass of [1, 2]) {
      const ctx = await openContext(device);
      ctxIds.push(ctx.ctxId);
      const client = await connect({ [TICKET_HEADER]: ctx.ticket });
      await client.until(2);

      // Traffic in both directions, including an app-level ping, which is
      // sealed like any other frame and consumes a counter (§18).
      for (let i = 0; i < 20; i++) {
        hub.broadcast({ type: "ping", ts: i } as never);
        client.ws.send(
          ctx.send.seal(
            Buffer.from(JSON.stringify({ type: "register", clientId: `c${pass}-${i}` })),
          ),
        );
      }
      await client.until(22);

      for (const frame of client.frames) {
        const h = headerOf(frame);
        const key = `${h.ctxId}|${h.direction}|${h.counter}`;
        expect(seen.has(key), `nonce reuse at ${key}`).toBe(false);
        seen.add(key);
        expect(h.direction).toBe(DIRECTION_S2C);
      }
      // The client's own send counter is the c2s half of the same invariant:
      // 20 seals, so the next counter is exactly 20, never a repeat of one.
      expect(ctx.send.counter).toBe(20n);

      client.ws.close();
      await client.closed();
      await poll(
        () => registry.get(ctx.ctxId) === null,
        2000,
        "the context to die with the socket",
      );
    }

    // A reconnect's counters legitimately start at 0 again, and that is NOT a
    // reuse: §8 scopes uniqueness per context, and this is a different context
    // with different keys. The assertion that makes that true is that the
    // ctxIds differ — which is why the key above is (ctxId, direction, counter)
    // and not (direction, counter).
    expect(ctxIds[0]).not.toBe(ctxIds[1]);
    expect(seen.size).toBe(44);
  });
});

// ─── (b) ticket single-use under a race ─────────────────────────────

describe("(b) the ticket is single-use", () => {
  it("accepts exactly one of two concurrent upgrades presenting one ticket", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const headers = { [TICKET_HEADER]: ctx.ticket };

    // Both started in the same tick. The device is PINNED, so the loser cannot
    // fall back to a plaintext socket — it is refused 401, which is what makes
    // "exactly one accepted" observable rather than "one of them is quieter".
    const results = await Promise.allSettled([connect({ ...headers }), connect({ ...headers })]);
    const accepted = results.filter((r) => r.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    expect(hub.sealedCount).toBe(1);
    // The ticket is gone either way: presented is spent.
    expect(registry.ticketCount).toBe(0);
  });

  it("refuses a second, later use of the same ticket", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const headers = { [TICKET_HEADER]: ctx.ticket };
    await connect({ ...headers });
    // 401, not 426: a spent ticket authenticates nobody, and a ticketed upgrade
    // carries no other credential to fall back to (§13). The client's recovery
    // is the same either way — one `POST /api/e2ee/open` and retry — and that
    // obligation belongs in the client contract, because the status alone does
    // not spell it out.
    await expect(refusedStatus({ ...headers })).resolves.toBe(401);
    expect(hub.sealedCount).toBe(1);
  });

  it("never turns a spent ticket into a shared-bearer plaintext socket", async () => {
    // Production break: failed ticket resolution fell through to ordinary
    // bearer authentication, so the shared key changed a visibly ticketed
    // request from sealed to legacy plaintext.
    const device = pairDevice();
    const ctx = await openContext(device);
    await connect({ [TICKET_HEADER]: ctx.ticket });

    await expect(
      refusedStatus({
        authorization: `Bearer ${API_KEY}`,
        [TICKET_HEADER]: ctx.ticket,
      }),
    ).resolves.toBe(401);
    expect(hub.sealedCount).toBe(1);
  });

  it("never turns a spent ticket into a shared-query-key plaintext socket", async () => {
    // The query credential is the released legacy spelling and must be tested
    // independently from Authorization: either fallback is a downgrade.
    const device = pairDevice();
    const ctx = await openContext(device);
    await connect({ [TICKET_HEADER]: ctx.ticket });

    await expect(refusedStatus({ [TICKET_HEADER]: ctx.ticket }, `?key=${API_KEY}`)).resolves.toBe(
      401,
    );
    expect(hub.sealedCount).toBe(1);
  });

  it("appears nowhere in an http.request line — it is a header, so there is nothing to redact", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    await connect({ [TICKET_HEADER]: ctx.ticket });

    const http = httpLines.filter((l) => l.includes("http.request"));
    // Positive control: the harness DID capture the upgrade's own log line, so
    // "the ticket is absent" is a statement about the line rather than about an
    // empty array.
    expect(http.some((l) => l.includes("/ws"))).toBe(true);
    for (const line of httpLines) {
      expect(line.includes(ctx.ticket)).toBe(false);
      // And no long-term credential either: a ticketed upgrade sends none, so
      // there is nothing for a log to leak in the first place (§13).
      expect(line.includes(device.deviceToken)).toBe(false);
    }
  });
});

// ─── a ticketed upgrade carries no Authorization (§13) ──────────────

describe("a ticketed upgrade authenticates by its ticket", () => {
  it("succeeds with NO credential at all, and logs neither the ticket nor a bearer", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    // No `Authorization`, no `?key=`. The ticket came out of a Noise handshake
    // against this device's own static key, so the long-term credential has
    // nothing left to prove — and sending it would put a device token on the
    // wire on every reconnect.
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    expect(hub.sealedCount).toBe(1);
    expect(drain(client, ctx).map((m) => m.type)).toEqual(["session_list", "cache_ready"]);
    // The principal came from the CONTEXT: the socket is authorized, which a
    // bearer-less upgrade could not be without that resolution.
    // Positive control on the log capture, so "the ticket is absent" below is a
    // statement about a line that exists rather than about an empty array.
    expect(httpLines.filter((l) => l.includes("http.request") && l.includes("/ws"))).toHaveLength(
      1,
    );
    for (const line of httpLines) {
      expect(line.includes(ctx.ticket)).toBe(false);
      expect(line.includes(device.deviceToken)).toBe(false);
    }
  });

  it("refuses a ticket presented beside a credential naming ANOTHER device", async () => {
    const device = pairDevice();
    const other = pairDevice();
    const ctx = await openContext(device);
    // Two answers to "who is this" is not a request to resolve by preferring
    // one — "header device ≠ context device" is refused rather than left
    // undefined at a trust boundary.
    await expect(refusedStatus({ ...bearer(other), [TICKET_HEADER]: ctx.ticket })).resolves.toBe(
      401,
    );
    expect(hub.sealedCount).toBe(0);
    // **And the context survives the refusal**, through the real route. Destroy
    // only on a fact in our own database (`revoked_at`), never on a header an
    // attacker chose: `ctxId` travels in the clear on every sealed REST
    // request, so destroy-on-mismatch would let anyone on path kill a device's
    // context on repeat — observe the id, forge a credential beside it, watch
    // the victim re-open, read the new id, again.
    expect(registry.get(ctx.ctxId)).not.toBeNull();
  });

  it("destroys the context when the trigger IS a fact in our database", async () => {
    // The control for the row above: the two triggers must be distinguishable,
    // or "never destroys on a mismatch" would be indistinguishable from "never
    // cleans up at all".
    const device = pairDevice();
    const ctx = await openContext(device);
    repo.revoke(device.deviceId);
    await expect(refusedStatus({ [TICKET_HEADER]: ctx.ticket })).resolves.toBe(403);
    expect(registry.get(ctx.ctxId)).toBeNull();
  });

  it("names each outcome for what it IS, and never destroys or throws", async () => {
    // Asserted on the helper directly, because these are the frozen semantics a
    // second repository is being built against — and two of the three are
    // invisible on this channel while being load-bearing on the REST one.
    const device = pairDevice();
    const other = pairDevice();
    const ctx = await openContext(device);
    const context = registry.get(ctx.ctxId) as never;

    // No credential is the ORDINARY case and an ordinary success.
    const plain = authenticateContext({ context, devicesRepo: repo, presented: undefined });
    expect(plain.ok).toBe(true);
    expect(plain.ok === true && plain.principal.deviceId).toBe(device.deviceId);

    // A credential naming another device.
    const mismatch = authenticateContext({
      context,
      devicesRepo: repo,
      presented: other.deviceToken,
    });
    expect(mismatch.ok === false && mismatch.reason).toBe("credential-mismatch");

    // A credential naming NO device — the shared api key is a mismatch, not an
    // exemption. "Names another device" read literally would miss this one.
    const shared = authenticateContext({ context, devicesRepo: repo, presented: API_KEY });
    expect(shared.ok === false && shared.reason).toBe("credential-mismatch");

    // No store, and a store that throws: a refusal, never a success and never a
    // throw out of the helper. A guard that defaults to allowing the downgrade
    // is not a guard.
    const noStore = authenticateContext({ context, devicesRepo: null, presented: undefined });
    expect(noStore.ok === false && noStore.reason).toBe("no-device-store");
    const broken = authenticateContext({
      context,
      devicesRepo: {
        get: () => {
          throw new Error("disk on fire");
        },
        authenticate: () => null,
      },
      presented: undefined,
    });
    expect(broken.ok === false && broken.reason).toBe("no-device-store");

    // A MISSING row reaches `device-revoked` too: absent is not the same as
    // invalid, and neither is success.
    const noRow = authenticateContext({
      context,
      devicesRepo: { get: () => null, authenticate: () => null },
      presented: undefined,
    });
    expect(noRow.ok === false && noRow.reason).toBe("device-revoked");
    // A row whose `revoked_at` column is absent must not read as live.
    const columnless = authenticateContext({
      context,
      devicesRepo: {
        get: () => ({ device_id: device.deviceId, capabilities: "[]" }) as never,
        authenticate: () => null,
      },
      presented: undefined,
    });
    expect(columnless.ok === false && columnless.reason).toBe("device-revoked");

    // …and through all of that the helper has destroyed nothing and logged
    // nothing: it is a verdict, and applying it is the caller's.
    expect(registry.get(ctx.ctxId)).not.toBeNull();

    // The control: a revoked row IS `device-revoked`, so the reasons are
    // distinguishable rather than one catch-all.
    repo.revoke(device.deviceId);
    const revoked = authenticateContext({ context, devicesRepo: repo, presented: undefined });
    expect(revoked.ok === false && revoked.reason).toBe("device-revoked");
  });

  it("returns no-device-store when the row's revoked_at accessor throws", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const context = registry.get(ctx.ctxId) as never;
    const hostile = Object.defineProperty(
      { device_id: device.deviceId, capabilities: "[]" },
      "revoked_at",
      {
        enumerable: true,
        get: () => {
          throw new Error("hostile accessor");
        },
      },
    );
    let result: ReturnType<typeof authenticateContext> | undefined;

    expect(() => {
      result = authenticateContext({
        context,
        devicesRepo: { get: () => hostile as never, authenticate: () => null },
        presented: undefined,
      });
    }).not.toThrow();
    expect(result?.ok === false && result.reason).toBe("no-device-store");
  });

  it("destroys a context orphaned by capability refusal after its ticket is consumed", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    store
      .getDatabase()
      .prepare("UPDATE devices SET capabilities = '[]' WHERE device_id = ?")
      .run(device.deviceId);

    expect(registry.get(ctx.ctxId)).not.toBeNull();
    expect(registry.ticketCount).toBe(1);
    await expect(refusedStatus({ [TICKET_HEADER]: ctx.ticket })).resolves.toBe(403);
    expect(registry.ticketCount).toBe(0);
    expect(registry.get(ctx.ctxId) === null).toBe(true);
  });

  it("refuses a ticket presented beside the SHARED api key, which names no device", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    await expect(
      refusedStatus({ authorization: `Bearer ${API_KEY}`, [TICKET_HEADER]: ctx.ticket }),
    ).resolves.toBe(401);
  });

  it("tolerates a credential that names the ticket's OWN device", async () => {
    // The rule is "the same device", not "no credential" — a client that keeps
    // sending one through a transition still connects.
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ ...bearer(device), [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    expect(hub.sealedCount).toBe(1);
  });

  it("refuses a ticket whose device was revoked between the open and the upgrade", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    // The ticket is still valid on its face. `revoked_at` is re-checked per
    // upgrade rather than trusted from the handshake (§10).
    repo.revoke(device.deviceId);
    await expect(refusedStatus({ [TICKET_HEADER]: ctx.ticket })).resolves.toBe(403);
  });

  it("refuses a BEARER-ONLY upgrade from a pinned device with 426", async () => {
    const device = pairDevice();
    // No ticket. `register` with a static key sets `e2ee_required = 1`, so
    // W1a's guard refuses the plaintext socket this would otherwise be.
    await expect(refusedStatus(bearer(device))).resolves.toBe(426);
  });
});

// ─── (c) revocation during a live context ───────────────────────────

describe("(c) revocation reaches a live socket", () => {
  it("closes the socket, destroys the context, refuses the next frame, and leaves other sockets alone", async () => {
    const victim = pairDevice();
    const bystander = pairDevice();
    const vCtx = await openContext(victim);
    const bCtx = await openContext(bystander);
    const vClient = await connect({ [TICKET_HEADER]: vCtx.ticket });
    const bClient = await connect({ [TICKET_HEADER]: bCtx.ticket });
    await vClient.until(2);
    await bClient.until(2);
    const vSocket = serverSockets().find((s) => hubContexts().get(s)?.ctxId === vCtx.ctxId);

    const res = await fetch(`${baseUrl}/api/devices/${victim.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);

    // The socket closes, with the frozen code as its reason (§9).
    const close = await vClient.closed();
    expect(close.code).toBe(1008);
    expect(close.reason).toBe(E2EE_DEVICE_REVOKED);
    // The context dies with it.
    expect(registry.get(vCtx.ctxId)).toBeNull();

    // The next frame either way is refused. A frame arriving in the window
    // between `close()` and the socket actually going away must NOT be handled
    // as a legacy plaintext one — that would be a sealed socket downgrading
    // itself on the way out.
    const nextFrame = vCtx.send.seal(
      Buffer.from(JSON.stringify({ type: "register", clientId: "x" })),
    );
    expect(hub.receive(vSocket as never, nextFrame)).toBeNull();

    // And the bystander is untouched: still sealed, still receiving.
    expect(bClient.closes).toHaveLength(0);
    hub.broadcast({ type: "ping", ts: 9 } as never);
    await bClient.until(3);
    expect(drain(bClient, bCtx).map((m) => m.type)).toEqual([
      "session_list",
      "cache_ready",
      "ping",
    ]);
    expect(registry.get(bCtx.ctxId)).not.toBeNull();
  });

  it("force-deleting an active device cuts its live sealed context", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    expect(repo.get(device.deviceId)?.revoked_at).toBeNull();

    const res = await fetch(`${baseUrl}/api/devices/${device.deviceId}?force=1`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(repo.get(device.deviceId) === null).toBe(true);
    expect(registry.get(ctx.ctxId) === null).toBe(true);

    const close = await client.closed();
    expect(close.code).toBe(1008);
    expect(close.reason).toBe(E2EE_DEVICE_REVOKED);
  });

  it("repeating revoke still cuts stale live ownership for an already-revoked row", async () => {
    // Production break: the idempotent early return answered successfully
    // before reaching the live teardown, so a stale sealed socket survived.
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    repo.revoke(device.deviceId);

    const res = await fetch(`${baseUrl}/api/devices/${device.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyRevoked: true });

    const close = await client.closed();
    expect(close).toEqual({ code: 1008, reason: E2EE_DEVICE_REVOKED });
    expect(registry.get(ctx.ctxId)).toBeNull();
    expect(hub.sealedCount).toBe(0);
  });

  it("repeating delete still cuts stale live ownership after the row is gone", async () => {
    // Production break: the idempotent missing-row answer skipped teardown,
    // leaving a context whose device could no longer be named by the store.
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    repo.delete(device.deviceId);

    const res = await fetch(`${baseUrl}/api/devices/${device.deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyDeleted: true });

    const close = await client.closed();
    expect(close).toEqual({ code: 1008, reason: E2EE_DEVICE_REVOKED });
    expect(registry.get(ctx.ctxId)).toBeNull();
    expect(hub.sealedCount).toBe(0);
  });

  it("bulk-deleting revoked devices cuts their live ownership and leaves active devices alone", async () => {
    const victim = pairDevice();
    const bystander = pairDevice();
    const victimCtx = await openContext(victim);
    const bystanderCtx = await openContext(bystander);
    const victimClient = await connect({ [TICKET_HEADER]: victimCtx.ticket });
    const bystanderClient = await connect({ [TICKET_HEADER]: bystanderCtx.ticket });
    await victimClient.until(2);
    await bystanderClient.until(2);

    // Create the stale ownership the bulk route must clean up: the row is
    // revoked directly, without going through the single-device route.
    repo.revoke(victim.deviceId);

    const res = await fetch(`${baseUrl}/api/devices`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 });
    expect(repo.get(victim.deviceId)).toBeNull();
    expect(registry.get(victimCtx.ctxId)).toBeNull();
    await expect(victimClient.closed()).resolves.toEqual({
      code: 1008,
      reason: E2EE_DEVICE_REVOKED,
    });

    expect(repo.get(bystander.deviceId)?.revoked_at).toBeNull();
    expect(registry.get(bystanderCtx.ctxId)).not.toBeNull();
    expect(bystanderClient.closes).toHaveLength(0);
    expect(hub.sealedCount).toBe(1);
  });
});

// ─── (d) broadcast independence ─────────────────────────────────────

describe("(d) broadcast independence", () => {
  it("seals N distinct (direction, counter) pairs for N sockets", async () => {
    const contexts = [];
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const device = pairDevice();
      const ctx = await openContext(device);
      contexts.push(ctx);
      clients.push(await connect({ [TICKET_HEADER]: ctx.ticket }));
    }
    await Promise.all(clients.map((c) => c.until(2)));

    hub.broadcast({ type: "ping", ts: 42 } as never);
    await Promise.all(clients.map((c) => c.until(3)));

    const third = clients.map((c) => c.frames[2]);
    // N sockets, N ciphertexts. Identical plaintext, and no two frames alike —
    // because each is sealed to its own key under its own counter.
    expect(new Set(third.map((f) => f.toString("base64"))).size).toBe(3);
    const heads = third.map(headerOf);
    expect(new Set(heads.map((h) => h.ctxId)).size).toBe(3);
    for (const [i, h] of heads.entries()) {
      expect(h.ctxId).toBe(contexts[i].ctxId);
      // Its own third frame, so its own counter 2 — not a shared one.
      expect(h.counter).toBe(2n);
      expect(h.direction).toBe(DIRECTION_S2C);
    }
    // Every one of them unseals under ITS OWN keys and nobody else's.
    for (const [i, c] of clients.entries()) {
      expect(drain(c, contexts[i]).map((m) => m.type)).toEqual([
        "session_list",
        "cache_ready",
        "ping",
      ]);
    }
    // Cross-unsealing fails: three ciphertexts of one plaintext are three
    // different records, not one record sent three times.
    expect(() => contexts[0].receive.unseal(third[1])).toThrow();
    expect(() => contexts[1].receive.unseal(third[2])).toThrow();
  });

  it("a slow client does not block the hub", async () => {
    const clients = [];
    const contexts = [];
    for (let i = 0; i < 3; i++) {
      const device = pairDevice();
      const ctx = await openContext(device);
      contexts.push(ctx);
      clients.push(await connect({ [TICKET_HEADER]: ctx.ticket }));
    }
    await Promise.all(clients.map((c) => c.until(2)));

    // Make client 0 genuinely slow: stop reading from its TCP socket, then push
    // until the SERVER's send buffer for it is backed up.
    const slow = clients[0];
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const filler = { type: "terminal_output", sessionId: "s", data: "x".repeat(60_000) };
    const serverSide = (hub as never as { clients: Set<{ bufferedAmount: number }> }).clients;
    const slowSocket = [...serverSide][0];
    for (let i = 0; i < 200 && slowSocket.bufferedAmount === 0; i++) {
      hub.broadcastToClients([...serverSide] as never, filler as never);
    }
    // POSITIVE CONTROL: the client really is backed up. Without this the timing
    // assertion below would pass on a hub that had no slow client at all.
    expect(slowSocket.bufferedAmount).toBeGreaterThan(0);

    // With megabytes queued for one client, the hub still returns immediately…
    const started = process.hrtime.bigint();
    hub.broadcast({ type: "ping", ts: 7 } as never);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(50);

    // …and the other two are served, while the slow one is still behind.
    await clients[1].until(3);
    await clients[2].until(3);
    expect(slow.frames.length).toBeLessThan(clients[1].frames.length);
  });
});

// ─── the first-frame deadline, and the two flags it leans on ────────

describe("a sealed socket has 10 s to prove it holds the keys (§10)", () => {
  it("pins the deadline at the contract's value", () => {
    // 15 s — the client's own connect timeout — is the only permitted
    // relaxation, and never lower: a real phone on a bad network has to fit an
    // upgrade and one frame inside it.
    expect(WS_FIRST_FRAME_DEADLINE_MS).toBeGreaterThanOrEqual(10_000);
    expect(WS_FIRST_FRAME_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });

  it("closes a socket that spent a ticket and then never spoke", async () => {
    await restartWith({ firstFrameMs: 300 });
    const device = pairDevice();
    const ctx = await openContext(device);
    // The ticket thief: it holds the socket the ticket bought and has no keys,
    // so it can never send a frame that unseals. It answers protocol pongs for
    // free, which is exactly why the existing ping reaper cannot evict it.
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    const close = await client.closed();
    expect(close.code).toBe(1008);
    expect(close.reason).toBe(E2EE_CTX_UNKNOWN);
    // The context goes with it, so the slot is genuinely returned.
    expect(registry.get(ctx.ctxId)).toBeNull();
    expect(hub.sealedCount).toBe(0);
  });

  it("POSITIVE CONTROL: the same silent socket survives when the deadline is long", async () => {
    // Without this, the test above could be passing because silence closes a
    // socket for some other reason entirely.
    await restartWith({ firstFrameMs: 60_000 });
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    await new Promise((r) => setTimeout(r, 600));
    expect(client.closes).toHaveLength(0);
    expect(hub.sealedCount).toBe(1);
  });

  it("stops the clock on ANY valid sealed frame, not on a `register` in particular", async () => {
    await restartWith({ firstFrameMs: 400 });
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    // Deliberately NOT `register`. The client contract says a socket registers
    // promptly; that is one way to satisfy the server's condition, not the
    // condition itself, and the server must not depend on a message name.
    client.ws.send(
      ctx.send.seal(Buffer.from(JSON.stringify({ type: "unsubscribe_session", sessionId: "s1" }))),
    );
    await new Promise((r) => setTimeout(r, 900));
    expect(client.closes).toHaveLength(0);
    expect(hub.sealedCount).toBe(1);
  });

  it("does not put a legacy plaintext socket on the clock at all", async () => {
    await restartWith({ firstFrameMs: 300 });
    const client = await connect({ authorization: `Bearer ${API_KEY}` });
    await client.until(2);
    await new Promise((r) => setTimeout(r, 600));
    // A `?key=` client authenticated at the upgrade and has no keys to prove.
    expect(client.closes).toHaveLength(0);
  });
});

describe("the two flags the send path leans on", () => {
  it("marks a socket sealed at ATTACH, before it has ever sent or received", async () => {
    // Driven straight at the hub, because through the route `handleWsOpen`
    // unicasts before a test could look — and "at attach" is precisely the
    // claim that a first-successful-seal flag would satisfy too.
    const device = pairDevice();
    const ctx = await openContext(device);
    const context = registry.get(ctx.ctxId);
    const sent: unknown[] = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (d: unknown) => sent.push(d),
      close: () => {},
      on: () => {},
    };

    hub.addClient(socket as never, context as never);
    // Detach immediately: nothing has been sealed, so a flag set on the first
    // successful seal would still be false here and the socket would fall
    // through to the plaintext branch.
    hubContexts().delete(socket);

    hub.unicast(socket as never, { type: "session_list", sessions: [] } as never);
    expect(sent).toHaveLength(0);
    expect(hub.receive(socket as never, "{}")).toBeNull();
  });
});

// ─── prototype pollution at the trust boundaries ────────────────────

describe("no option or header is read through the prototype chain", () => {
  // Every case restores in `finally`, so a pollution cannot leak into another
  // test and quietly change what it proves.
  async function polluted<T>(
    key: string,
    value: unknown,
    body: () => T,
    enumerable = false,
  ): Promise<Awaited<T>> {
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      enumerable,
      writable: true,
    });
    try {
      return await body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key];
      expect(Object.hasOwn(Object.prototype, key)).toBe(false);
    }
  }

  it("does not let Object.prototype LENGTHEN the first-frame deadline", async () => {
    // `server.ts` constructs `new WSHub()`, so the options object is `{}` and
    // `??` would read straight through it. Lengthened, the ticket-thief defence
    // stops firing entirely — the ping reaper cannot evict a socket that
    // answers pongs, so this is the only clock that would have run.
    const hub = await polluted("firstFrameMs", 86_400_000, () => new WSHub());
    try {
      expect((hub as never as { firstFrameMs: number }).firstFrameMs).toBe(
        WS_FIRST_FRAME_DEADLINE_MS,
      );
    } finally {
      hub.dispose();
    }
  });

  it("does not let Object.prototype SHORTEN it below the floor either", async () => {
    // The other direction is equally behavioural: every legitimate socket is
    // reaped before a phone on a bad network fits an upgrade and one frame in.
    const hub = await polluted("firstFrameMs", 1, () => new WSHub());
    try {
      expect((hub as never as { firstFrameMs: number }).firstFrameMs).toBe(
        WS_FIRST_FRAME_DEADLINE_MS,
      );
    } finally {
      hub.dispose();
    }
  });

  it("still honours a deadline the CALLER actually passed", () => {
    // The control. Without it, "reads the constant" would be satisfied by an
    // option that had stopped working at all.
    const hub = new WSHub({ firstFrameMs: 250 });
    try {
      expect((hub as never as { firstFrameMs: number }).firstFrameMs).toBe(250);
    } finally {
      hub.dispose();
    }
  });

  it("CONTROL: the two `own()` siblings are unmoved by the same technique", async () => {
    // If polluting `now` or `initialCounter` DID move those, the assertions
    // above would be measuring something other than `own()`.
    const { raw, id } = newCtxId();
    const key = randomBytes(32);
    const ctx = await polluted("now", 1, () =>
      registry.open({
        deviceId: "proto-control",
        kind: "ws",
        ctxIdRaw: raw,
        ctxId: id,
        keys: { clientToServer: key, serverToClient: key, handshakeHash: key } as never,
      }),
    );
    expect(ctx.createdAt).toBeGreaterThan(1);

    const state = await polluted("initialCounter", 99n, () =>
      createRecordState({
        key,
        ctxId: randomBytes(16),
        direction: DIRECTION_S2C,
        channel: CHANNEL_WS,
      }),
    );
    expect(state.counter).toBe(0n);
  });

  it("does not read an absent Content-Length off Object.prototype on /api/e2ee/open", async () => {
    // `req.headers` is a RAW Node object, so a bracket read of an absent header
    // returns whatever the prototype holds. Not a bypass — the running byte
    // total is the real ceiling — but a polluted value makes a small, honest
    // body read as huge and eat a 400 on a public, pre-authentication path.
    const device = pairDevice();
    const { message } = writeMessage1({
      staticKeyPair: device.staticKeyPair,
      responderStaticPub: serverStaticPub,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify({ v: E2EE_PROTOCOL_VERSION, kind: "ws" }), "utf-8"),
      prologue: OPEN_PROLOGUE,
    });
    const body = JSON.stringify({
      e2ee: { v: E2EE_PROTOCOL_VERSION, noise: message.toString("base64") },
    });

    // `fetch` always sends a Content-Length, so drive a raw socket that omits
    // it and uses chunked encoding instead — which is the shape the bracket
    // read fails on.
    const status = await polluted("content-length", "999999999", () =>
      rawChunkedPost("/api/e2ee/open", body),
    );
    expect(status).toBe(200);
  });

  it("does not authenticate an inherited Authorization header on a real upgrade", async () => {
    // Production break: @hono/node-ws copies raw IncomingMessage headers with
    // `for...in`, promoting an enumerable inherited value into trusted Headers.
    const status = await polluted(
      "authorization",
      `Bearer ${API_KEY}`,
      async () => {
        const rawHeaders = {};
        expect(Object.hasOwn(rawHeaders, "authorization")).toBe(false);
        expect((rawHeaders as Record<string, unknown>).authorization === `Bearer ${API_KEY}`).toBe(
          true,
        );
        return await refusedStatus({});
      },
      true,
    );
    expect(status).toBe(401);
  });

  it("does not authenticate an inherited X-TB-Ticket header on a real upgrade", async () => {
    const opened = await openContext(pairDevice());
    const status = await polluted(
      TICKET_HEADER,
      opened.ticket,
      async () => {
        const rawHeaders = {};
        expect(Object.hasOwn(rawHeaders, TICKET_HEADER)).toBe(false);
        expect((rawHeaders as Record<string, unknown>)[TICKET_HEADER] === opened.ticket).toBe(true);
        return await refusedStatus({});
      },
      true,
    );
    expect(status).toBe(401);
    expect(registry.ticketCount).toBe(1);
  });
});

// ─── A2: the principal is the context's own device ──────────────────

describe("a context-attached socket's principal is its context's device", () => {
  it("resolves principal.deviceId equal to context.deviceId", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    // A frame, so the route hands its captured principal to the handler.
    client.ws.send(ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "a" }))));
    await poll(() => lastPrincipal !== null, 2000, "the route to resolve a principal");

    const socketContext = hubContexts().get(serverSockets()[0]) as unknown as { deviceId: string };
    expect(lastPrincipal?.kind).toBe("device");
    // The property, not a coincidence: the principal is BUILT from the
    // context's own device row, so there is no path on which the two differ.
    expect(lastPrincipal?.deviceId).toBe(socketContext.deviceId);
    expect(lastPrincipal?.deviceId).toBe(device.deviceId);
  });

  it("takes the successful principal id from the context when its row disagrees", () => {
    const contextDeviceId = "context-device";
    const { raw, id } = newCtxId();
    const key = randomBytes(32);
    const context = registry.open({
      deviceId: contextDeviceId,
      kind: "ws",
      ctxIdRaw: raw,
      ctxId: id,
      keys: { clientToServer: key, serverToClient: key, handshakeHash: key } as never,
    });
    const rowDeviceId = "row-names-a-different-device";
    const result = authenticateContext({
      context,
      devicesRepo: {
        get: () => ({ device_id: rowDeviceId, capabilities: "[]", revoked_at: null }) as never,
        authenticate: () => null,
      },
      presented: undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.principal.deviceId).toBe(contextDeviceId);
    expect(result.ok && result.principal.deviceId).not.toBe(rowDeviceId);
  });
});

// ─── the strict counter, the two codes, and the frame ceiling ───────

describe("the socket's counter is strict (§5 R2)", () => {
  it("closes with E2EE_SEQUENCE_VIOLATION on a gap", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    // Burn a counter without sending it: the server's next expected is 0, and
    // this frame claims 1. Ordered, gap-free by construction — a gap is a
    // protocol violation, not a network event.
    ctx.send.seal(Buffer.from("{}"));
    client.ws.send(ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "a" }))));

    const close = await client.closed();
    expect(close.code).toBe(1008);
    expect(close.reason).toBe(E2EE_SEQUENCE_VIOLATION);
  });

  it("closes with E2EE_SEQUENCE_VIOLATION on a repeat", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    const frame = ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "a" })));
    client.ws.send(frame);
    client.ws.send(frame);
    const close = await client.closed();
    expect(close.reason).toBe(E2EE_SEQUENCE_VIOLATION);
  });

  it("reports a bad tag as E2EE_SEAL_FAILED, not as a claim about the peer (§5 R2 ordering, §9)", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    // The RIGHT counter, a corrupted tag. Authenticate first, then compare: a
    // sequence violation is a claim about the peer and this frame proves
    // nothing about the peer at all.
    const frame = ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "a" })));
    frame[frame.length - 1] ^= 0xff;
    client.ws.send(frame);

    const close = await client.closed();
    expect(close.reason).toBe(E2EE_SEAL_FAILED);
    expect(close.reason).not.toBe(E2EE_SEQUENCE_VIOLATION);
  });

  it("logs e2ee.sequence_violation, and a seal failure under its own event", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    ctx.send.seal(Buffer.from("{}"));
    client.ws.send(ctx.send.seal(Buffer.from(JSON.stringify({ type: "register" }))));
    await client.closed();
    expect(httpLines.some((l) => l.includes("e2ee.sequence_violation"))).toBe(true);
    expect(httpLines.some((l) => l.includes("e2ee.frame_refused"))).toBe(false);
  });
});

describe("frame-refusal diagnostics preserve the record-layer cause", () => {
  it("distinguishes a misaddressed inbound record from an unknown one in structured logs", async () => {
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const first = await openContext(pairDevice());
    const firstContext = registry.get(first.ctxId);
    const firstSocket = fakeServerSocket();
    const second = await openContext(pairDevice());
    const secondContext = registry.get(second.ctxId);
    const secondSocket = fakeServerSocket();
    if (!firstContext || !secondContext) throw new Error("contexts were not opened");

    try {
      localHub.addClient(firstSocket.ws, firstContext);
      const misaddressed = first.send.seal(Buffer.from("{}"));
      randomBytes(16).copy(misaddressed, 1);
      expect(localHub.receive(firstSocket.ws, misaddressed)).toBeNull();

      vi.spyOn(secondContext, "receiveState").mockReturnValue({
        unseal: () => {
          throw new RecordError(E2EE_CTX_UNKNOWN, "record names an unknown context");
        },
      } as never);
      localHub.addClient(secondSocket.ws, secondContext);
      expect(localHub.receive(secondSocket.ws, Buffer.alloc(30))).toBeNull();

      const refusals = httpLines.filter((line) => line.includes('"event":"e2ee.frame_refused"'));
      expect(
        refusals.some((line) => line.includes('"detail":"record is addressed to another context"')),
      ).toBe(true);
      expect(
        refusals.some((line) => line.includes('"detail":"record names an unknown context"')),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
      localHub.dispose();
    }
  });

  it("closes a synthetic send-side sequence code as E2EE_SEAL_FAILED and logs the original", async () => {
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const opened = await openContext(pairDevice());
    const context = registry.get(opened.ctxId);
    const socket = fakeServerSocket();
    if (!context) throw new Error("context was not opened");

    try {
      vi.spyOn(context, "sendState").mockReturnValue({
        seal: () => {
          throw new RecordError(E2EE_SEQUENCE_VIOLATION, "synthetic send-side sequence code");
        },
      } as never);
      localHub.addClient(socket.ws, context);
      localHub.unicast(socket.ws, { type: "ping", ts: 1 } as never);

      expect(socket.close).toHaveBeenCalledWith(1008, E2EE_SEAL_FAILED);
      expect(
        httpLines.some(
          (line) =>
            line.includes('"code":"E2EE_SEAL_FAILED"') &&
            line.includes('"reported":"E2EE_SEQUENCE_VIOLATION"') &&
            line.includes('"detail":"synthetic send-side sequence code"'),
        ),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
      localHub.dispose();
    }
  });
});

describe("sealed-socket ownership failures", () => {
  it("does not expose registry invalidation on a returned context object", () => {
    const context = openServerContext("private-invalidation-device", Date.now());

    expect(contextCanSeal(context)).toBe(true);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(context))).not.toContain("invalidate");
  });

  it("the maintenance pass closes a cap-collected context without application traffic", async () => {
    // Production break: the registry invalidated and removed the oldest
    // context after its drain, but the hub retained the socket indefinitely
    // while a cooperative peer kept answering protocol pings.
    vi.useFakeTimers();
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const deviceId = "cap-maintenance-device";
    const contexts: E2eeContext[] = [];
    const sockets: ReturnType<typeof fakeServerSocket>[] = [];
    const startedAt = Date.now();

    try {
      for (let i = 0; i <= MAX_WS_CONTEXTS_PER_DEVICE; i++) {
        const context = openServerContext(deviceId, startedAt + i);
        context.markUsed(startedAt + i);
        const socket = fakeServerSocket();
        localHub.addClient(socket.ws, context);
        contexts.push(context);
        sockets.push(socket);
      }

      const afterDrain = startedAt + MAX_WS_CONTEXTS_PER_DEVICE + CONTEXT_DRAIN_MS + 1;
      const replacement = openServerContext(deviceId, afterDrain);
      replacement.markUsed(afterDrain);
      const replacementSocket = fakeServerSocket();
      localHub.addClient(replacementSocket.ws, replacement);

      expect(registry.get(contexts[0].ctxId, afterDrain)).toBeNull();
      expect(localHub.sealedCount).toBe(MAX_WS_CONTEXTS_PER_DEVICE + 2);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(sockets[0].ping).not.toHaveBeenCalled();
      expect(sockets[1].ping).not.toHaveBeenCalled();
      expect(sockets[0].close).toHaveBeenCalledWith(1008, E2EE_CTX_UNKNOWN);
      expect(sockets[1].close).toHaveBeenCalledWith(1008, E2EE_CTX_UNKNOWN);
      expect(localHub.sealedCount).toBe(MAX_WS_CONTEXTS_PER_DEVICE);
      expect(sockets[0].send).not.toHaveBeenCalled();
      expect(sockets[1].send).not.toHaveBeenCalled();
    } finally {
      localHub.dispose();
      vi.useRealTimers();
    }
  });

  it("does not destroy a replacement context when maintenance closes its stale socket owner", async () => {
    // Production break: maintenance correctly noticed that the hub retained a
    // different object for this ctxId, then stale-socket cleanup destroyed the
    // registry's replacement by identifier rather than the object it owned.
    vi.useFakeTimers();
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const socket = fakeServerSocket();
    const { raw, id } = newCtxId();
    const openedAt = Date.now();
    const keys = () =>
      ({
        clientToServer: randomBytes(32),
        serverToClient: randomBytes(32),
        handshakeHash: randomBytes(32),
      }) as never;
    const stale = registry.open({
      deviceId: "replacement-maintenance-device",
      kind: "ws",
      ctxIdRaw: raw,
      ctxId: id,
      keys: keys(),
      now: openedAt,
    });
    stale.markUsed(openedAt);

    try {
      localHub.addClient(socket.ws, stale);
      const replacement = registry.open({
        deviceId: "replacement-maintenance-device",
        kind: "ws",
        ctxIdRaw: raw,
        ctxId: id,
        keys: keys(),
        now: openedAt + 1,
      });
      replacement.markUsed(openedAt + 1);
      expect(registry.get(id)).toBe(replacement);
      expect(contextCanSeal(stale)).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(socket.ping).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, E2EE_CTX_UNKNOWN);
      expect(localHub.sealedCount).toBe(0);
      expect(registry.get(id)).toBe(replacement);
      expect(contextCanSeal(stale)).toBe(false);
      expect(contextCanSeal(replacement)).toBe(true);
    } finally {
      localHub.dispose();
      vi.useRealTimers();
    }
  });

  it("invalidates a cap-evicted socket and closes every device socket on revocation", async () => {
    // Production break: the registry forgets a drained Context without
    // invalidating the object retained by WSHub, then revocation closes only
    // the still-indexed ctxIds and omits that live socket entirely.
    const device = pairDevice();
    const contexts: E2eeContext[] = [];
    const sockets: ReturnType<typeof fakeServerSocket>[] = [];
    const startedAt = Date.now();

    for (let i = 0; i <= MAX_WS_CONTEXTS_PER_DEVICE; i++) {
      const context = openServerContext(device.deviceId, startedAt + i);
      context.markUsed(startedAt + i);
      const socket = fakeServerSocket();
      hub.addClient(socket.ws, context);
      contexts.push(context);
      sockets.push(socket);
    }

    const afterDrain = startedAt + MAX_WS_CONTEXTS_PER_DEVICE + CONTEXT_DRAIN_MS + 1;
    const replacement = openServerContext(device.deviceId, afterDrain);
    replacement.markUsed(afterDrain);
    const replacementSocket = fakeServerSocket();
    hub.addClient(replacementSocket.ws, replacement);
    contexts.push(replacement);
    sockets.push(replacementSocket);

    const evictedStillUsable = contextCanSeal(contexts[0]);
    const response = await fetch(`${baseUrl}/api/devices/${device.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const everyContextUnusable = contexts.every((context) => !contextCanSeal(context));

    expect({
      status: response.status,
      evictedStillUsable,
      policyCloses: sockets.filter((socket) =>
        socket.close.mock.calls.some(
          ([code, reason]) => code === 1008 && reason === E2EE_DEVICE_REVOKED,
        ),
      ).length,
      socketCount: sockets.length,
      everyContextUnusable,
      registryCount: registry.size,
      hubCount: hub.sealedCount,
    }).toEqual({
      status: 200,
      evictedStillUsable: false,
      policyCloses: sockets.length,
      socketCount: sockets.length,
      everyContextUnusable: true,
      registryCount: 0,
      hubCount: 0,
    });
  });

  it("closes and detaches when the transport throws after sealing", () => {
    // Production break: seal advances the send counter, but a synchronous
    // ws.send throw merely returns false, leaving the context attached for a
    // later scoped send to emit counter 1 while the peer still expects 0.
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const context = openServerContext("send-failure-device", Date.now());
    const socket = fakeServerSocket();
    socket.send.mockImplementationOnce(() => {
      throw new Error("synthetic transport failure");
    });

    try {
      localHub.addClient(socket.ws, context);
      localHub.unicast(socket.ws, { type: "ping", ts: 1 } as never);
      const afterFirstSend = {
        policyClosed: socket.close.mock.calls.some(
          ([code, reason]) => code === 1008 && reason === E2EE_SEAL_FAILED,
        ),
        contextDestroyed: registry.get(context.ctxId) === null,
        hubCount: localHub.sealedCount,
      };

      localHub.broadcastToClients([socket.ws], { type: "ping", ts: 2 } as never);

      expect({ afterFirstSend, transportAttempts: socket.send.mock.calls.length }).toEqual({
        afterFirstSend: { policyClosed: true, contextDestroyed: true, hubCount: 0 },
        transportAttempts: 1,
      });
    } finally {
      localHub.dispose();
    }
  });

  it("does not seal for a non-open transport and terminally drops its context", () => {
    // Production break: readyState was checked only after seal(), consuming
    // counter 0 without putting it on the wire and without lifecycle cleanup.
    const localHub = new WSHub({ firstFrameMs: 60_000 });
    const context = openServerContext("non-open-send-device", Date.now());
    const sendState = context.sendState(CHANNEL_WS);
    const socket = fakeServerSocket();
    (socket.ws as unknown as { readyState: number }).readyState = 2;

    try {
      localHub.addClient(socket.ws, context);
      localHub.unicast(socket.ws, { type: "ping", ts: 1 } as never);

      expect({
        counter: sendState.counter,
        transportAttempts: socket.send.mock.calls.length,
        policyClosed: socket.close.mock.calls.some(
          ([code, reason]) => code === 1008 && reason === E2EE_SEAL_FAILED,
        ),
        contextDestroyed: registry.get(context.ctxId) === null,
        hubCount: localHub.sealedCount,
      }).toEqual({
        counter: 0n,
        transportAttempts: 0,
        policyClosed: true,
        contextDestroyed: true,
        hubCount: 0,
      });
    } finally {
      localHub.dispose();
    }
  });
});

describe("upgrade cleanup before a raw socket exists", () => {
  it("destroys an attached context when onOpen receives a falsy ws.raw", async () => {
    const opened = await openContext(pairDevice());
    const context = registry.get(opened.ctxId);
    if (!context) throw new Error("context was not opened");
    expect(registry.consumeTicket(opened.ticket)).toBe(opened.ctxId);
    const handleWsOpen = vi.fn();
    const upgradeWebSocket = ((
      factory: (c: unknown) => {
        onOpen?: (event: unknown, ws: { raw: WebSocket | undefined }) => void;
      },
    ) =>
      async (c: { set: (key: string, value: unknown) => void; body: (body: null) => Response }) => {
        c.set("e2eeContext", context);
        factory(c).onOpen?.({}, { raw: undefined });
        return c.body(null);
      }) as never;
    const app = createWsRoutes(
      {
        devicesRepo: () => repo,
        handleWsOpen,
      } as unknown as ApiDeps,
      upgradeWebSocket,
    );

    const res = await app.request("/ws");
    expect(res.status).toBe(200);
    expect(handleWsOpen).not.toHaveBeenCalled();
    expect(registry.get(opened.ctxId) === null).toBe(true);
  });
});

describe("the client→server frame ceiling (§10)", () => {
  // FIXED sizes, deliberately not derived from the constant. A payload sized as
  // `repeat(WS_MAX_CLIENT_FRAME_BYTES)` grows with any mutation of the ceiling,
  // so raising the ceiling raises the frame too and the test stays green while
  // proving nothing. These two straddle the real bound, and the assertion below
  // is what fails loudly if the bound ever moves out from between them.
  const OVER = 100 * 1024;
  const UNDER = 32 * 1024;
  it("has fixtures that straddle the ceiling", () => {
    expect(WS_MAX_CLIENT_FRAME_BYTES).toBeGreaterThan(UNDER);
    expect(WS_MAX_CLIENT_FRAME_BYTES).toBeLessThan(OVER);
  });

  it("refuses a frame larger than the ceiling before the record layer ever sees it", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    client.ws.send(
      ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "x".repeat(OVER) }))),
    );

    // 1009 "message too big" — `ws` refuses it at the receiver, which is the
    // only place the bound can run BEFORE the allocation it exists to prevent.
    const close = await client.closed();
    expect(close.code).toBe(1009);
  });

  it("accepts a legitimate frame under the ceiling, so the bound is not the reason real traffic fails", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    client.ws.send(
      ctx.send.seal(Buffer.from(JSON.stringify({ type: "register", clientId: "x".repeat(UNDER) }))),
    );
    // Nothing closes: the frame was handled.
    await new Promise((r) => setTimeout(r, 200));
    expect(client.closes).toHaveLength(0);
  });
});

// ─── the dual path, and the socket/REST split ───────────────────────

describe("dual paths and context lifetime (§8)", () => {
  it("keeps a legacy `?key=` socket working in plaintext", async () => {
    const client = await connect({ authorization: `Bearer ${API_KEY}` });
    await client.until(2);
    expect(JSON.parse(client.frames[0].toString("utf-8")).type).toBe("session_list");
    // …and it can still send.
    client.ws.send(JSON.stringify({ type: "register", clientId: "legacy" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.closes).toHaveLength(0);
  });

  it("refuses a pinned device that presents `?key=` with no ticket, through refuseUnsealedIfPinned", async () => {
    const device = pairDevice();
    // `register` with a static key sets `e2ee_required = 1`, so this row is
    // pinned. `?key=` with the DEVICE token resolves to a device principal and
    // W1a's guard refuses it — no second pin check here.
    await expect(refusedStatus({}, `?key=${device.deviceToken}`)).resolves.toBe(426);
  });

  it("STATED LIMIT: a pinned device presenting the SHARED api key is not caught here", async () => {
    // The pin is per DEVICE, and the shared key resolves to `legacy` with no
    // device row, so the guard has nothing to look up. This is the stage-3
    // shared-key problem, named rather than papered over — asserted so that
    // closing it later is a deliberate change to a test, not a surprise.
    const client = await connect({}, `?key=${API_KEY}`);
    await client.until(1);
    expect(hub.sealedCount).toBe(0);
  });

  it("never puts a socket that consumed a ticket on the plaintext send path", async () => {
    const device = pairDevice();
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);
    const socket = serverSockets()[0];
    const before = client.frames.length;

    // Detach the context from a LIVE socket. No code path reaches this state
    // today — `forgetContext` only runs on close or error — which is exactly
    // why the guard must not rest on that: unreachability is not a guard, and a
    // future change that detaches a context from an open socket would otherwise
    // downgrade it silently.
    hubContexts().delete(socket);
    // POSITIVE CONTROL: the socket really is still open, so "nothing was sent"
    // is a statement about the send path and not about a dead connection.
    expect(socket.readyState).toBe(1);

    hub.unicast(
      socket as never,
      {
        type: "session_list",
        sessions: [{ id: "s1", projectPath: "/Users/someone/private-project" }],
      } as never,
    );

    // The leak assertion comes FIRST, with a settle in front of it, so that a
    // mutation restoring the fall-through fails on the sentence that names the
    // harm rather than on a close that happens not to arrive. Without the
    // settle it would pass vacuously — the frame simply would not have landed
    // yet.
    await new Promise((r) => setTimeout(r, 200));
    // NOTHING went out — in particular not a plaintext `session_list`, which
    // enumerates every session with its project path.
    expect(client.frames).toHaveLength(before);
    expect(Buffer.concat(client.frames).toString("latin1")).not.toContain("private-project");

    const close = await client.closed();
    expect(close.code).toBe(1008);
    expect(close.reason).toBe(E2EE_SEAL_FAILED);
  });

  it("a socket's close destroys its OWN context and never the device's REST context", async () => {
    const device = pairDevice();
    // A REST context for the same device — the one the 2 s HTTP replay fallback
    // depends on precisely when the socket is down.
    const restCtxId = await openRestContext(device);
    const ctx = await openContext(device);
    const client = await connect({ [TICKET_HEADER]: ctx.ticket });
    await client.until(2);

    client.ws.close();
    await client.closed();
    await poll(() => registry.get(ctx.ctxId) === null, 2000, "the socket context to die");
    // The REST context survives the socket, which is the whole reason there are
    // two contexts per device.
    expect(registry.get(restCtxId)?.kind).toBe("rest");
  });
});

/** A REST context for the same device — same handshake, `kind: "rest"`. */
async function openRestContext(device: Device): Promise<string> {
  const { message, state } = writeMessage1({
    staticKeyPair: device.staticKeyPair,
    responderStaticPub: serverStaticPub,
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: E2EE_PROTOCOL_VERSION, kind: "rest" }), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  const res = await fetch(`${baseUrl}/api/e2ee/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ e2ee: { v: E2EE_PROTOCOL_VERSION, noise: message.toString("base64") } }),
  });
  const outer = (await res.json()) as { e2ee: { noise: string } };
  const read = readMessage2(state, Buffer.from(outer.e2ee.noise, "base64"));
  const ctxId = (JSON.parse(read.payload.toString("utf-8")) as { ctxId: string }).ctxId;
  read.keys.consume();
  // A REST context is provisional until it is used; mark it so the socket's
  // close is the only thing that could remove it.
  registry.get(ctxId)?.markUsed();
  return ctxId;
}
