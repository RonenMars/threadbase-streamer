import { serve } from "@hono/node-server";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import { request as httpRequest, type IncomingHttpHeaders } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import type { AppEnv } from "../src/api/app";
import { createHonoApp } from "../src/api/app";
import { readBody } from "../src/api/handlers/http-helpers";
import { authMiddleware } from "../src/api/middleware/auth.middleware";
import { corsMiddleware } from "../src/api/middleware/cors.middleware";
import { MAX_ENVELOPE_HEADER_CHARS } from "../src/api/middleware/e2ee-envelope.middleware";
import { errorMiddleware } from "../src/api/middleware/error.middleware";
import { createMiscRoutes } from "../src/api/routes/misc.routes";
import type { ApiDeps } from "../src/api/types/api-deps";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { contextRegistry } from "../src/e2ee/context";
import {
  generateKeyPair,
  type KeyPair,
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
  MAX_RECORD_BYTES,
  RecordError,
  restTargetHash,
  restTargetHashFromUrl,
} from "../src/e2ee/record";
import { loadOrCreateServerIdentity } from "../src/server-identity";
import vectors from "./fixtures/e2ee-record-vectors.json";

/**
 * The REST envelope middleware — NONCE-DESIGN §4, §5, §9, §10, §13; design.md
 * §3.2/§3.4/§3.6; D-7 and D-9.
 *
 * **Real path, throughout.** A real HTTP server, the real `createHonoApp`
 * chain (logging → CORS → envelope → auth → router), a real `devices` row in a
 * real runtime.db, a real `POST /api/e2ee/open` Noise `IK` handshake driven
 * from the client side, and real sealed records built by the record layer from
 * the traffic keys that handshake produced. Hono's test client is not used
 * anywhere: it provides neither `c.env.incoming` nor `c.env.outgoing`, and both
 * body-read paths and every direct-write route need them.
 *
 * **Two credential regimes, deliberately, and the difference is the point.**
 * The transport tests (ladder, framing, response paths, target binding) run
 * with `deps.localNoAuth` ON, because they predate §13(b) and are about bytes
 * rather than identity — loopback resolves a `legacy` principal so a sealed
 * request reaches a handler without the test having to care who it is.
 *
 * **The §13(b) block turns `localNoAuth` OFF** (`currentDeps.localNoAuth =
 * false` in its own `beforeEach`) and carries its own negative control proving
 * an unsealed request to the same route then 401s. That is the bar BRIEF-2b
 * §4 set and 2a could not meet: under the loopback bypass, "the context
 * authenticated this request" and "loopback did" are indistinguishable, so a
 * positive control that leaves it on is not a control. With it off, a sealed
 * request that reaches a handler reached it on the strength of its context and
 * nothing else.
 */

let dir: string;
let store: RuntimeStore;
let repo: DevicesRepository;
let port: number;
let server: ReturnType<typeof serve>;
let savedConfigDir: string | undefined;
let serverStaticPub: Buffer;
const registry = contextRegistry();

/** A body the probe route echoes back, so a plaintext read is observable. */
const PROBE_PATH = "/__e2ee_probe";
/** Reports the principal the chain resolved, so §13(b) is measurable. */
const WHOAMI_PATH = "/__e2ee_whoami";

beforeAll(() => {
  savedConfigDir = process.env.THREADBASE_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "tb-e2ee-envelope-"));
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

/** What the direct-write routes under test write, recorded per test. */
let directWrite: (res: import("http").ServerResponse) => void | Promise<void>;

/**
 * What `deps.devicesRepo()` answers, per test.
 *
 * `null` is the real thing. Anything else is the `no-device-store` family:
 * `deps.devicesRepo` is called ON EVERY REQUEST rather than captured, which is
 * what lets a test swap the store MID-FLIGHT — between the handshake that
 * created the context and the sealed request that uses it — without rebuilding
 * the server. That is the only honest way to drive §13(b)'s per-request
 * re-check, because a store swapped before the handshake would simply fail the
 * handshake instead.
 */
let devicesRepoOverride: (() => DevicesRepository | null) | null = null;

/** The deps object the running server holds, so a test can flip a flag mid-run. */
let currentDeps: ApiDeps;

function makeDeps(): ApiDeps {
  return {
    apiKey: "tb_0123456789abcdef0123456789abcdef",
    // Left ON for the pre-2b tests, which predate the middleware setting a
    // principal. **The device-credential tests below turn it OFF**
    // (`currentDeps.localNoAuth = false`), because a positive control that
    // could have passed through the loopback bypass is not a control at all —
    // it is the one thing BRIEF-2b §4 says the 2a control could not do.
    localNoAuth: true,
    logMenubarRequests: false,
    devicesRepo: () => (devicesRepoOverride ? devicesRepoOverride() : repo),
    featureFlagsConfig: () => ({ registry: [], values: { e2ee: true }, sources: {} }),
    // Three real routes, reached through the real router. Their handlers are
    // supplied through `ApiDeps` — the same seam `server-wiring.ts` uses in
    // production — because the real ones need a PTY manager and a conversation
    // cache. Each test sets `directWrite` to the EXACT write sequence of the
    // real handler it stands in for, quoted in the test.
    handleSessionsCount: (res) => {
      void directWrite(res);
    },
    handleStopSession: async (_id, res) => {
      await directWrite(res);
    },
    handleGetConversation: async (_id, _url, res) => {
      await directWrite(res);
    },
  } as unknown as ApiDeps;
}

/**
 * The probe: ONE handler that reads the body through BOTH paths this codebase
 * has, so "the plaintext reached the handler" is a measurement rather than a
 * claim.
 *
 * Mounted on the app `createHonoApp` returned, so it sits behind the real
 * middleware chain — the same `app.use("*")` stack every other route is behind.
 */
function mountProbe(app: ReturnType<typeof createHonoApp>): void {
  app.post(PROBE_PATH, async (c) => {
    // `?read=` picks which path to exercise. A request body can only be read
    // ONCE on the plaintext path — `readBody` drains the stream and Hono's
    // `arrayBuffer()` drains the same one — so the single-path spellings are
    // what make the unsealed CONTROLS possible at all. The sealed case can read
    // both, because the two sources are then independent: `c.env.incoming` is
    // the replacement stream and `arrayBuffer()` comes from the seeded cache,
    // which is exactly the property under test.
    const read = c.req.query("read") ?? "both";
    const out: Record<string, unknown> = {};
    if (read === "both" || read === "ab") {
      out.viaArrayBuffer = Buffer.from(await c.req.arrayBuffer()).toString("utf-8");
      out.viaText = await c.req.text();
    }
    if (read === "both" || read === "incoming") {
      out.viaIncoming = await readBody(c.env.incoming);
    }
    return c.json(out);
  });
  // Who did the chain decide this request is? Unclassified on purpose
  // (`requiredCapability` returns null for a non-`/api` path), so this reports
  // the principal without a capability gate standing in front of the answer.
  app.get(WHOAMI_PATH, (c) => c.json({ principal: c.get("principal") ?? null }));
}

beforeEach(async () => {
  registry.clear();
  devicesRepoOverride = null;
  directWrite = () => {
    throw new Error("no direct-write handler set by this test");
  };
  currentDeps = makeDeps();
  const app = createHonoApp(currentDeps);
  mountProbe(app);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

// ─── the wire ───────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One HTTP request with the request-target written EXACTLY as given.
 *
 * `fetch` runs its target through the WHATWG URL parser; the target hash is
 * defined over the raw bytes Node received (§4), so the `%2F` case has to be
 * driven from something that does not normalise.
 */
function raw(args: {
  method: string;
  target: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Flush the headers and never send the body — proves a pre-read refusal. */
  withholdBody?: boolean;
  /** Bound an intentional withheld-body probe so a missing early refusal fails. */
  timeoutMs?: number;
  host?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: args.method, path: args.target, headers: args.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (args.timeoutMs !== undefined) {
      req.setTimeout(args.timeoutMs, () => req.destroy(new Error("request timed out")));
    }
    if (args.withholdBody) {
      req.flushHeaders();
      return;
    }
    if (args.body) req.write(args.body);
    req.end();
  });
}

// ─── the client half ────────────────────────────────────────────────

interface ClientContext {
  ctxId: string;
  ctxIdRaw: Buffer;
  keys: TrafficKeys;
  /** The device row this context names — the invariant's left-hand side. */
  deviceId: string;
  deviceToken: string;
}

/** The device row a handshake will attach to, and the token that names it. */
let lastRegistered: { deviceId: string; deviceToken: string };

function pairDevice(preset: "full" | "read-only" = "full"): KeyPair {
  const staticKeyPair = generateKeyPair();
  const reg = repo.register({
    publicKey: `legacy-${staticKeyPair.publicKeyRaw.toString("base64")}`,
    e2eeStaticPub: staticKeyPair.publicKeyRaw.toString("base64"),
    e2eeVersion: 1,
    preset,
  });
  lastRegistered = { deviceId: reg.deviceId, deviceToken: reg.deviceToken };
  return staticKeyPair;
}

/** A real `POST /api/e2ee/open` handshake for a real REST context. */
async function openRestContext(preset: "full" | "read-only" = "full"): Promise<ClientContext> {
  const staticKeyPair = pairDevice(preset);
  const { message, state } = writeMessage1({
    staticKeyPair,
    responderStaticPub: serverStaticPub,
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "rest" }), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  const res = await raw({
    method: "POST",
    target: "/api/e2ee/open",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } })),
  });
  expect(res.status).toBe(200);
  const outer = JSON.parse(res.body.toString("utf-8")) as { e2ee: { noise: string } };
  const { payload, keys } = readMessage2(state, Buffer.from(outer.e2ee.noise, "base64"));
  const ctxId = (JSON.parse(payload.toString("utf-8")) as { ctxId: string }).ctxId;
  return {
    ctxId,
    ctxIdRaw: Buffer.from(ctxId, "base64url"),
    keys: keys.consume(),
    deviceId: lastRegistered.deviceId,
    deviceToken: lastRegistered.deviceToken,
  };
}

/** Seal a request record the way the client will: raw target, C2S, channel 2. */
function sealRequest(
  ctx: ClientContext,
  method: string,
  target: string,
  counter: bigint,
  body: string,
): Buffer {
  return createRecordState({
    key: ctx.keys.clientToServer,
    ctxId: ctx.ctxIdRaw,
    direction: DIRECTION_C2S,
    channel: CHANNEL_REST_REQUEST,
    initialCounter: counter,
  }).seal(Buffer.from(body, "utf-8"), restTargetHashFromUrl(method, target));
}

/** Unseal the one response that request is owed. */
function unsealResponse(
  ctx: ClientContext,
  method: string,
  target: string,
  counter: bigint,
  res: RawResponse,
): string {
  const header = res.headers["x-tb-env"];
  const record = typeof header === "string" ? Buffer.from(header, "base64url") : res.body;
  return createRecordState({
    key: ctx.keys.serverToClient,
    ctxId: ctx.ctxIdRaw,
    direction: DIRECTION_S2C,
    channel: CHANNEL_REST_RESPONSE,
    initialCounter: counter,
  })
    .unseal(record, restTargetHashFromUrl(method, target))
    .toString("utf-8");
}

/** A complete sealed exchange. `carrier` picks which half of the frozen rule. */
async function sealedCall(
  ctx: ClientContext,
  args: {
    method: string;
    target: string;
    counter: bigint;
    body?: string;
    carrier?: "body" | "header";
    extraHeaders?: Record<string, string>;
    frameOverride?: Buffer;
  },
): Promise<RawResponse> {
  const frame =
    args.frameOverride ?? sealRequest(ctx, args.method, args.target, args.counter, args.body ?? "");
  const carrier = args.carrier ?? (args.method === "GET" ? "header" : "body");
  const headers: Record<string, string> = {
    "X-TB-E2EE": "1",
    "X-TB-Ctx": ctx.ctxId,
    "X-TB-Seq": String(args.counter),
    ...args.extraHeaders,
  };
  if (carrier === "header") headers["X-TB-Env"] = frame.toString("base64url");
  else headers["content-type"] = "application/octet-stream";
  return raw({
    method: args.method,
    target: args.target,
    headers,
    body: carrier === "body" ? frame : undefined,
  });
}

function codeOf(res: RawResponse): string {
  try {
    return (JSON.parse(res.body.toString("utf-8")) as { code?: string }).code ?? "no code";
  } catch {
    return `unparseable: ${res.body.toString("utf-8").slice(0, 40)}`;
  }
}

// ─── the controls ───────────────────────────────────────────────────

describe("REST envelope: the controls", () => {
  it("POSITIVE CONTROL — a sealed request round-trips through a real handler", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    // `GET /api/profiles` is a real, untouched Hono-piped route: `c.json([])`.
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });

    expect(res.status).toBe(200);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    // The wire carries no plaintext of the answer. Asserted structurally — the
    // sealed body is not the plaintext — rather than by scanning the body for a
    // marker: a substring scan against ciphertext is unsound in principle, since
    // ciphertext is uniform bytes and any short marker eventually appears in it
    // by chance (`[]` did, on CI — #762). A longer marker only shrinks the odds.
    expect(res.body.equals(Buffer.from("[]"))).toBe(false);
    // …and the client's own keys recover exactly what the handler returned.
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe("[]");
  });

  it("NEGATIVE CONTROL — with the middleware out of the chain the same request is served in the clear", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";

    // The same chain minus exactly one middleware. If the harness would pass
    // either way, this is where it says so.
    const bare = new Hono<AppEnv>();
    const deps = makeDeps();
    bare.use("*", corsMiddleware(undefined));
    bare.use("*", authMiddleware(deps));
    bare.onError(errorMiddleware);
    bare.route("/", createMiscRoutes(deps));
    const bareServer = serve({ fetch: bare.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => bareServer.once("listening", r));
    const barePort = (bareServer.address() as AddressInfo).port;

    try {
      const frame = sealRequest(ctx, "GET", target, 0n, "");
      const res = await new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: barePort,
            method: "GET",
            path: target,
            headers: {
              "X-TB-E2EE": "1",
              "X-TB-Ctx": ctx.ctxId,
              "X-TB-Seq": "0",
              "X-TB-Env": frame.toString("base64url"),
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () =>
              resolve({
                status: r.statusCode ?? 0,
                headers: r.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });

      // Served in the CLEAR: no envelope marker, and the answer is readable on
      // the wire by anyone.
      expect(res.headers["x-tb-e2ee"]).toBeUndefined();
      expect(res.body.toString("utf-8")).toBe("[]");
      // And the client's unseal — the assertion the positive control passes on
      // — cannot be satisfied by this response.
      expect(() => unsealResponse(ctx, "GET", target, 0n, res)).toThrow(RecordError);
    } finally {
      await new Promise((r) => bareServer.close(r));
    }
  });

  it("serves a request without X-TB-E2EE exactly as today (the old-client guarantee)", async () => {
    await openRestContext();
    const res = await raw({ method: "GET", target: "/api/profiles" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["x-tb-e2ee"]).toBeUndefined();
    expect(res.headers["x-tb-env"]).toBeUndefined();
    expect(res.body.toString("utf-8")).toBe("[]");
  });
});

// ─── both body-read paths ───────────────────────────────────────────

describe("REST envelope: the plaintext reaches both body-read paths", () => {
  it("hands the plaintext to c.env.incoming AND to c.req.arrayBuffer()", async () => {
    const ctx = await openRestContext();
    const plaintext = JSON.stringify({ text: "ls -la", n: 7 });
    const res = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 0n,
      body: plaintext,
    });
    expect(res.status).toBe(200);

    const seen = JSON.parse(unsealResponse(ctx, "POST", PROBE_PATH, 0n, res)) as {
      viaIncoming: unknown;
      viaArrayBuffer: string;
      viaText: string;
    };
    // Path 1 — `readBody(c.env.incoming)`, the ~15-site path. It JSON.parses,
    // so a ciphertext body cannot produce this object at all.
    expect(seen.viaIncoming).toEqual({ text: "ls -la", n: 7 });
    // Path 2 — Hono's request, byte for byte.
    expect(seen.viaArrayBuffer).toBe(plaintext);
    // …and `text()`/`json()` derive from the same seeded cache.
    expect(seen.viaText).toBe(plaintext);
  });

  it("CONTROL — each path on its own reads the real bytes of an UNSEALED request", async () => {
    // The probe is not rigged to answer with whatever it was asked. Without the
    // envelope each path reports exactly the bytes that were sent — which is
    // also what proves the sealed assertions above are about a substitution
    // this middleware performed and not about a probe that always agrees.
    const body = JSON.stringify({ text: "plain" });
    for (const read of ["ab", "incoming"]) {
      const res = await raw({
        method: "POST",
        target: `${PROBE_PATH}?read=${read}`,
        headers: { "content-type": "application/json" },
        body: Buffer.from(body),
      });
      const seen = JSON.parse(res.body.toString("utf-8")) as {
        viaArrayBuffer?: string;
        viaIncoming?: unknown;
      };
      if (read === "ab") expect(seen.viaArrayBuffer).toBe(body);
      else expect(seen.viaIncoming).toEqual({ text: "plain" });
    }
  });
});

// ─── the rejection ladder ───────────────────────────────────────────

describe("REST envelope: the rejection ladder (§9, §10, D-9)", () => {
  it("rung 2 — an X-TB-Ctx that is not 22 base64url characters", async () => {
    for (const bad of ["", "short", "a".repeat(23), "aaaaaaaaaaaaaaaaaaaa+/"]) {
      const res = await raw({
        method: "GET",
        target: "/api/profiles",
        headers: { "X-TB-E2EE": "1", "X-TB-Ctx": bad, "X-TB-Seq": "0" },
      });
      expect([res.status, codeOf(res)]).toEqual([409, "E2EE_CTX_UNKNOWN"]);
    }
  });

  it("rung 3 — an unknown ctxId, and the body is never read", async () => {
    // Well-formed, unknown. The D-9 property: one `Map.get`, no allocation, and
    // the request body is never touched — which is what makes this answerable
    // while the sender is still withholding a body it claims is enormous.
    const res = await raw({
      method: "POST",
      target: PROBE_PATH,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": "AAAAAAAAAAAAAAAAAAAAAA",
        "X-TB-Seq": "0",
        // Well under the size bound, and NEVER SENT. The bound is not what
        // answers this request — the lookup is. If anything above rung 3
        // touched the stream, this call would hang until the suite tore the
        // server down, which is the shape this assertion is really making.
        "content-length": "1024",
      },
      withholdBody: true,
      timeoutMs: 250,
    });
    expect([res.status, codeOf(res)]).toEqual([409, "E2EE_CTX_UNKNOWN"]);
  });

  it("rung 4 — a socket context cannot serve REST", async () => {
    const staticKeyPair = pairDevice();
    const { message, state } = writeMessage1({
      staticKeyPair,
      responderStaticPub: serverStaticPub,
      pattern: "IK",
      payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
      prologue: OPEN_PROLOGUE,
    });
    const opened = await raw({
      method: "POST",
      target: "/api/e2ee/open",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ e2ee: { v: 1, noise: message.toString("base64") } })),
    });
    const outer = JSON.parse(opened.body.toString("utf-8")) as { e2ee: { noise: string } };
    const { payload } = readMessage2(state, Buffer.from(outer.e2ee.noise, "base64"));
    const wsCtxId = (JSON.parse(payload.toString("utf-8")) as { ctxId: string }).ctxId;

    // Refused on the `kind` field alone: a declared body that is never sent,
    // so an answer arriving at all proves nothing downstream read the stream.
    const res = await raw({
      method: "POST",
      target: PROBE_PATH,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": wsCtxId,
        "X-TB-Seq": "0",
        "content-length": "1024",
      },
      withholdBody: true,
      timeoutMs: 250,
    });
    expect([res.status, codeOf(res)]).toEqual([409, "E2EE_CTX_UNKNOWN"]);
  });

  it("rung 5 — an X-TB-Seq that is not a decimal counter", async () => {
    const ctx = await openRestContext();
    // `" 1"` is deliberately absent: Node's HTTP parser strips optional
    // whitespace from header values, so it can never reach the middleware.
    for (const bad of ["", "-1", "1e3", "0x1", "01", "18446744073709551616"]) {
      const res = await raw({
        method: "GET",
        target: "/api/profiles",
        headers: { "X-TB-E2EE": "1", "X-TB-Ctx": ctx.ctxId, "X-TB-Seq": bad },
      });
      expect([bad, res.status, codeOf(res)]).toEqual([bad, 400, "E2EE_SEQUENCE_VIOLATION"]);
    }
  });

  it("rung 5a — a body-carried envelope AND an X-TB-Env is refused", async () => {
    const ctx = await openRestContext();
    const frame = sealRequest(ctx, "POST", PROBE_PATH, 0n, "{}");
    const res = await raw({
      method: "POST",
      target: PROBE_PATH,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "X-TB-Env": frame.toString("base64url"),
      },
      body: frame,
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("rung 5a — neither source is refused too", async () => {
    const ctx = await openRestContext();
    const res = await raw({
      method: "GET",
      target: "/api/profiles",
      headers: { "X-TB-E2EE": "1", "X-TB-Ctx": ctx.ctxId, "X-TB-Seq": "0" },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("rung 6 — an oversized X-TB-Env, refused before any base64url decode", async () => {
    const ctx = await openRestContext();
    const res = await raw({
      method: "GET",
      target: "/api/profiles",
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "X-TB-Env": "A".repeat(MAX_ENVELOPE_HEADER_CHARS + 1),
      },
    });
    expect([res.status, codeOf(res)]).toEqual([413, "E2EE_SEAL_FAILED"]);

    // The CONTROL: one character shorter is not refused by the bound. It is a
    // valid-length base64url string of the wrong bytes, so it reaches the AEAD
    // and dies there — a different rung, with a different status.
    const under = await raw({
      method: "GET",
      target: "/api/profiles",
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "X-TB-Env": "A".repeat(MAX_ENVELOPE_HEADER_CHARS),
      },
    });
    expect([under.status, codeOf(under)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("rung 6 — an oversized Content-Length, refused before a byte is read", async () => {
    const ctx = await openRestContext();
    // The headers are flushed and the body is NEVER sent. If the bound were on
    // the bytes rather than the declaration, this request would hang until the
    // test timed out; the answer arriving at all is the assertion.
    const res = await raw({
      method: "POST",
      target: PROBE_PATH,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "content-length": String(MAX_RECORD_BYTES + 1),
      },
      withholdBody: true,
      timeoutMs: 250,
    });
    expect([res.status, codeOf(res)]).toEqual([413, "E2EE_SEAL_FAILED"]);
  });

  it("rung 7 — a sender that lies about its length is cut off at the cap", async () => {
    const ctx = await openRestContext();
    // Chunked: no `Content-Length` to check, so only the running total can
    // refuse this. 5 MiB against a 4 MiB cap.
    const res = await raw({
      method: "POST",
      target: PROBE_PATH,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "transfer-encoding": "chunked",
      },
      body: Buffer.alloc(5 * 1024 * 1024, 0x41),
    });
    expect([res.status, codeOf(res)]).toEqual([413, "E2EE_SEAL_FAILED"]);
  });

  it("rung 8 — a frame the AEAD refuses", async () => {
    const ctx = await openRestContext();
    const frame = sealRequest(ctx, "POST", PROBE_PATH, 0n, "{}");
    frame[frame.length - 1] ^= 0xff; // one bit of the tag
    const res = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 0n,
      frameOverride: frame,
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("rung 9 — an X-TB-Seq that disagrees with the authenticated counter", async () => {
    const ctx = await openRestContext();
    const res = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 3n,
      body: "{}",
      extraHeaders: { "X-TB-Seq": "4" },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEQUENCE_VIOLATION"]);
    // A counter was ACCEPTED for this request — the AEAD and the window both
    // passed — so this is the one rejection that COULD have been sealed. §13(a)
    // says it must not be: a refusal is plaintext, and spending the response
    // counter here is a record the client will never be able to place.
    expect(res.headers["x-tb-e2ee"]).toBeUndefined();
    expect(res.headers["x-tb-env"]).toBeUndefined();
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("§5 ORDERING — an unauthenticated frame is a seal failure, never a sequence violation", async () => {
    // The case that tells the two orders apart. A frame the AEAD will reject,
    // carrying an `X-TB-Seq` that also disagrees with its header counter.
    //
    // Authenticate-then-compare answers `E2EE_SEAL_FAILED`: the frame is not
    // from the peer, so there is no claim about the peer to make. Compare-first
    // answers `E2EE_SEQUENCE_VIOLATION` — an UNAUTHENTICATED verdict naming a
    // device that did nothing, which is exactly what §5's ordering rule and
    // §9's frozen semantics forbid. Both refuse the request; only one of them
    // says something true.
    const ctx = await openRestContext();
    const frame = sealRequest(ctx, "POST", PROBE_PATH, 0n, "{}");
    frame[frame.length - 1] ^= 0xff;
    const res = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 0n,
      frameOverride: frame,
      extraHeaders: { "X-TB-Seq": "5" },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("refuses a replayed sealed request, and the refusal carries no sealed body", async () => {
    const ctx = await openRestContext();
    const frame = sealRequest(ctx, "POST", PROBE_PATH, 0n, JSON.stringify({ text: "ls" }));

    const first = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 0n,
      frameOverride: frame,
    });
    expect(first.status).toBe(200);

    const replay = await sealedCall(ctx, {
      method: "POST",
      target: PROBE_PATH,
      counter: 0n,
      frameOverride: frame,
    });
    expect([replay.status, codeOf(replay)]).toEqual([400, "E2EE_SEQUENCE_VIOLATION"]);
    // §13(a): a request the window refused never gets a sealed body, because a
    // second record under `(k_s2c, 2‖0)` is keystream reuse.
    expect(replay.headers["x-tb-e2ee"]).toBeUndefined();
    expect(replay.headers["x-tb-env"]).toBeUndefined();
    expect(replay.headers["content-type"]).toContain("application/json");
    expect(() => unsealResponse(ctx, "POST", PROBE_PATH, 0n, replay)).toThrow(RecordError);
  });
});

// ─── the frozen carrier rule ────────────────────────────────────────

describe("REST envelope: the frozen carrier rule", () => {
  it("accepts a bodiless sealed GET through X-TB-Env", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n, carrier: "header" });
    expect(res.status).toBe(200);
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe("[]");
  });

  it("accepts out-of-order concurrent requests, which is why the window exists", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    const second = await sealedCall(ctx, { method: "GET", target, counter: 1n });
    const first = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(unsealResponse(ctx, "GET", target, 1n, second)).toBe("[]");
    expect(unsealResponse(ctx, "GET", target, 0n, first)).toBe("[]");
  });
});

/**
 * Rung 5a's framing decision under a polluted `Object.prototype`.
 *
 * Node builds `IncomingMessage.headers` with `Object.prototype`, and a header
 * absent from the wire is absent as an OWN property, so `headers["x"]` is a
 * prototype-chain read. The framing decision at rung 5a asks exactly two
 * absence questions — "is there a `transfer-encoding`?" and "is there a
 * non-zero `content-length`?" — and both are asked of headers that are
 * routinely absent, which is what puts them on the prototype's reach.
 *
 * **Denial is the finding here, not bypass.** Nothing below rung 5a is
 * weakened: the AEAD still runs and the window still runs. What moves is which
 * requests get to reach them, and a sealed channel that refuses every
 * legitimate request is not a lesser outcome than one that accepts an
 * illegitimate one — the app is off the air either way, and this vector is
 * reachable from any prototype-pollution sink anywhere in the process, by an
 * attacker who never touches the crypto.
 *
 * The remedy under test is that both reads go through `c.req.header`, which
 * `@hono/node-server` gates on `Object.hasOwn` (`RequestHeaders#lookupHttp1`,
 * `dist/index.mjs:84`), falling back to a scan of the raw wire header array on
 * the paths it declines. Reverting either read to a bracket read on
 * `incoming.headers` must turn one of these two red — that is the mutation,
 * and each test covers one of the two reads so neither can hide behind the
 * other.
 *
 * Every test here restores `Object.prototype` in a `finally` and then ASSERTS
 * the restoration, because a pollution test that leaks is a test that quietly
 * rewrites the rest of the file.
 */
describe("REST envelope: rung 5a survives a polluted Object.prototype", () => {
  /** Run `fn` with `Object.prototype[key] = value`, then prove the cleanup. */
  async function polluted<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    // Guard the guard: if the key were already an own property of the
    // prototype, `delete` in the `finally` would remove something this test did
    // not add, and the "cleanup" would itself be the pollution.
    expect(Object.hasOwn(proto, key)).toBe(false);
    try {
      // Non-enumerable, so the spread in `replaceBody` and every `for…in` in
      // the process behave as they do in production. An ENUMERABLE property
      // would be a bigger hammer than the real threat and would make a pass
      // here mean less than it looks.
      Object.defineProperty(proto, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      // Positive control for the pollution itself: prove an ordinary
      // prototype-less-looking object really does read the poisoned value
      // through the chain. Without this, a `defineProperty` that silently
      // failed would make every assertion below pass for the wrong reason.
      expect(({} as Record<string, unknown>)[key]).toBe(value);
      return await fn();
    } finally {
      delete proto[key];
      expect(Object.hasOwn(proto, key)).toBe(false);
      expect(({} as Record<string, unknown>)[key]).toBeUndefined();
    }
  }

  it("a polluted transfer-encoding does not refuse a bodiless sealed GET as carrying two envelopes", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    // A bodiless GET carries neither framing header on the wire, so BOTH
    // absence questions are prototype-chain reads for this request. Polluting
    // `transfer-encoding` makes the bracket read answer "there is a body",
    // which collides with the `X-TB-Env` this request really does carry, and
    // rung 5a refuses it as carrying two envelopes.
    const res = await polluted("transfer-encoding", "chunked", () =>
      sealedCall(ctx, { method: "GET", target, counter: 0n, carrier: "header" }),
    );
    expect(res.status).toBe(200);
    expect(codeOf(res)).not.toBe("E2EE_SEAL_FAILED");
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe("[]");
  });

  it("a polluted content-length does not refuse a chunked sealed POST as oversized", async () => {
    const ctx = await openRestContext();
    const target = `${PROBE_PATH}?read=ab`;
    const frame = sealRequest(ctx, "POST", target, 0n, "hello");
    // Node sends this chunked: `content-length` is omitted from the wire
    // because none is set, so it too is absent as an own property and the
    // bracket read at rung 6 falls through to the poisoned value. A declared
    // length over `MAX_ENVELOPE_BODY_BYTES` is a 413 before a byte is read —
    // which is the correct behaviour for a real oversized declaration and a
    // total denial for a forged one.
    const res = await polluted("content-length", "999999999", () =>
      raw({
        method: "POST",
        target,
        headers: {
          "X-TB-E2EE": "1",
          "X-TB-Ctx": ctx.ctxId,
          "X-TB-Seq": "0",
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
        body: frame,
      }),
    );
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
    expect(JSON.parse(unsealResponse(ctx, "POST", target, 0n, res))).toEqual({
      viaArrayBuffer: "hello",
      viaText: "hello",
    });
  });
});

/**
 * §13(b): the principal comes from the CONTEXT — slice 2b.
 *
 * **`localNoAuth` is off in every test here.** That is the whole point. 2a's
 * positive control ran under the loopback bypass, which resolves a `legacy`
 * principal for any local caller, so it could not distinguish "the context
 * authenticated this request" from "loopback did". Turning it off means a
 * sealed request that reaches a handler reached it on the strength of its
 * context and nothing else.
 *
 * The invariant under test, stated as one sentence:
 *
 * > A sealed request runs as the device its CONTEXT names; any credential
 * > presented beside the context must name that same device or the request is
 * > refused; and every one of those refusals is SEALED, because the counter was
 * > already accepted.
 */
describe("REST envelope: the principal comes from the context (§13(b))", () => {
  beforeEach(() => {
    currentDeps.localNoAuth = false;
  });

  /** Unseal a refusal body. Sealed refusals are the point, so this is not optional. */
  function sealedJson(
    ctx: ClientContext,
    method: string,
    target: string,
    counter: bigint,
    res: RawResponse,
  ): unknown {
    return JSON.parse(unsealResponse(ctx, method, target, counter, res));
  }

  it("NEGATIVE CONTROL — with localNoAuth off, an unsealed request to the same route 401s", async () => {
    // Proves the tests below are measuring the context and not a bypass that
    // would have let anything through. Without this, every pass in this block
    // would be consistent with the middleware doing nothing at all.
    const res = await raw({ method: "GET", target: "/api/profiles" });
    expect(res.status).toBe(401);
  });

  it("POSITIVE CONTROL — a sealed request with NO Authorization authenticates from the context alone", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(200);
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe("[]");
  });

  it("resolves principal.deviceId from the context, and the capability check still sees it", async () => {
    const ctx = await openRestContext();
    const target = WHOAMI_PATH;
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(200);
    const { principal } = sealedJson(ctx, "GET", target, 0n, res) as {
      principal: { kind: string; deviceId: string; capabilities: string[] };
    };
    expect(principal.kind).toBe("device");
    expect(principal.deviceId).toBe(ctx.deviceId);
    expect(principal.capabilities).toContain("session:control");
  });

  it("keeps principal.deviceId from the CONTEXT even when the device row names another device", async () => {
    // The invariant is "by construction", not "checked": a conforming but
    // wrong store must not be able to rename the caller. A `DeviceLookup` that
    // answers with a live row carrying a DIFFERENT `device_id` is the smallest
    // shape that tells the two apart — if the principal were built from the
    // row, this would come back as "someone-else".
    const ctx = await openRestContext();
    devicesRepoOverride = () =>
      ({
        get: () => ({
          device_id: "someone-else",
          capabilities: JSON.stringify(["history:read"]),
          revoked_at: null,
        }),
        authenticate: () => null,
        touch: () => {},
      }) as unknown as DevicesRepository;
    const target = WHOAMI_PATH;
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    const { principal } = sealedJson(ctx, "GET", target, 0n, res) as {
      principal: { deviceId: string };
    };
    expect(principal.deviceId).toBe(ctx.deviceId);
    expect(principal.deviceId).not.toBe("someone-else");
  });

  it("refuses a credential naming another device with a SEALED 401, and the context survives", async () => {
    // The Q1 denial-of-service, from the caller's side. `X-TB-Ctx` is a
    // plaintext header, so if this destroyed the context, anyone who read one
    // request could kill that device's channel on repeat.
    const ctx = await openRestContext();
    pairDevice(); // a second, unrelated device
    const otherToken = lastRegistered.deviceToken;
    const target = "/api/profiles";
    const res = await sealedCall(ctx, {
      method: "GET",
      target,
      counter: 0n,
      extraHeaders: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({ error: "Unauthorized" });
    // The context is still there AND still usable — a survival test that only
    // checked the registry map would pass against a context that had been
    // invalidated in place.
    expect(registry.get(ctx.ctxId)).not.toBeNull();
    const after = await sealedCall(ctx, { method: "GET", target, counter: 1n });
    expect(after.status).toBe(200);
    expect(unsealResponse(ctx, "GET", target, 1n, after)).toBe("[]");
  });

  it("refuses the SHARED API key beside a context the same way — it names no device", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    const res = await sealedCall(ctx, {
      method: "GET",
      target,
      counter: 0n,
      extraHeaders: { authorization: "Bearer tb_0123456789abcdef0123456789abcdef" },
    });
    expect(res.status).toBe(401);
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({ error: "Unauthorized" });
    expect(registry.get(ctx.ctxId)).not.toBeNull();
  });

  it("refuses a device revoked MID-FLIGHT with a sealed 403, and destroys the context", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    // Revoked AFTER the handshake: the context's handle is still valid on its
    // face, which is exactly why §13(b) re-checks per request rather than
    // trusting the open.
    expect(repo.revoke(ctx.deviceId)).toBe(true);
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(403);
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({
      error: "This device is not paired",
      code: "E2EE_DEVICE_REVOKED",
    });
    expect(registry.get(ctx.ctxId)).toBeNull();
  });

  /**
   * **The seal-before-destroy ordering, as a BLACK BOX — and it is now a real
   * failure mode rather than an order pin.**
   *
   * PLAN-X-server §5 and BRIEF-2b §6 both specified a call-order assertion
   * here, spying on `sealResponse` and `destroy`, with an explicit caveat that
   * it pinned an order and proved no failure mode — because at `v1.71.0`
   * `destroy()` was unmapping and a held context sealed identically either way.
   *
   * **That caveat expired at `v1.72.0`.** W1b shipped real invalidation
   * (streamer #743): `destroy()` runs `contextInvalidators`, which nulls the
   * context's response sealer, and `sealResponse` throws through
   * `requireRest()` once it is null. So the order is now observable end to end,
   * and BRIEF-2b §6's own contingency — "if #743 ships, a black-box test
   * replaces this one" — is what this test is.
   *
   * Inverting the two lines in the middleware no longer produces a byte-
   * identical response; it produces a body the phone cannot decrypt, on the one
   * code §9 tells the client never to retry.
   */
  it("seals the revocation refusal BEFORE destroying, so the phone can actually read it", async () => {
    const ctx = await openRestContext();
    const target = "/api/profiles";
    repo.revoke(ctx.deviceId);
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    // Not "a 403 came back" — a 403 whose body UNSEALS. Destroying first makes
    // `sealResponse` throw, the seal fails closed to a plaintext 500, and this
    // line is where that shows up.
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(() => unsealResponse(ctx, "GET", target, 0n, res)).not.toThrow();
    expect(sealedJson(ctx, "GET", target, 0n, res)).toMatchObject({
      code: "E2EE_DEVICE_REVOKED",
    });
    // And the destroy really did happen — otherwise this test would pass
    // against a middleware that had simply forgotten to destroy at all.
    expect(registry.get(ctx.ctxId)).toBeNull();
  });

  it("answers an ABSENT device registry with a sealed 503 STORE_UNAVAILABLE, context INTACT", async () => {
    const ctx = await openRestContext();
    devicesRepoOverride = () => null;
    const target = "/api/profiles";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(503);
    // The exact bytes, asserted rather than the shape: §9 makes
    // `E2EE_DEVICE_REVOKED` a hard failure the client must never retry, and a
    // registry we could not read says nothing about the pairing. Byte-identical
    // to `auth.middleware.ts`'s WS answer and to `devices.routes.ts`.
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({
      error: "Device registry is unavailable",
      code: "STORE_UNAVAILABLE",
    });
    // A store fault is a statement about US. The pairing is untouched, so the
    // context must survive — and must work again the moment the store returns.
    expect(registry.get(ctx.ctxId)).not.toBeNull();
    devicesRepoOverride = null;
    const after = await sealedCall(ctx, { method: "GET", target, counter: 1n });
    expect(after.status).toBe(200);
  });

  it("answers a THROWING device registry the same way, and does not let the throw escape", async () => {
    const ctx = await openRestContext();
    devicesRepoOverride = () =>
      ({
        get: () => {
          throw new Error("disk fault");
        },
        authenticate: () => null,
        touch: () => {},
      }) as unknown as DevicesRepository;
    const target = "/api/profiles";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(503);
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({
      error: "Device registry is unavailable",
      code: "STORE_UNAVAILABLE",
    });
    expect(registry.get(ctx.ctxId)).not.toBeNull();
  });

  it("survives a CONFORMING BUT HOSTILE row whose revoked_at accessor throws", async () => {
    // The realistic shape of the last one. `DeviceLookup` is a structural
    // contract another repository implements, so the throw lands on the
    // PROPERTY READ rather than on the call — a `try` around only `get()`
    // would leave it bare and the exception would escape into the middleware,
    // where it becomes a 500 with a stack trace instead of a sealed 503.
    const ctx = await openRestContext();
    devicesRepoOverride = () =>
      ({
        get: () => ({
          device_id: ctx.deviceId,
          capabilities: JSON.stringify(["history:read"]),
          get revoked_at(): number | null {
            throw new Error("hostile accessor");
          },
        }),
        authenticate: () => null,
        touch: () => {},
      }) as unknown as DevicesRepository;
    const target = "/api/profiles";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(503);
    expect(sealedJson(ctx, "GET", target, 0n, res)).toEqual({
      error: "Device registry is unavailable",
      code: "STORE_UNAVAILABLE",
    });
    expect(registry.get(ctx.ctxId)).not.toBeNull();
  });

  it("refuses a PINNED device's plaintext request with 426, never 401", async () => {
    // The downgrade rule (design.md §6.3), on the REST channel. `pairDevice`
    // registers with a Noise static key, which is what sets `e2ee_required`, so
    // this device has completed a handshake once and may never be served in the
    // clear again.
    const ctx = await openRestContext();
    const res = await raw({
      method: "GET",
      target: "/api/profiles",
      headers: { authorization: `Bearer ${ctx.deviceToken}` },
    });
    // 426, and specifically NOT 401: `docs/compatibility/tb-mobile.md` maps 401
    // onto the re-authentication UI, so a 401 here would send a correctly
    // paired phone to a login screen it cannot satisfy. The credential is fine;
    // the transport is not.
    expect(res.status).toBe(426);
    expect(res.status).not.toBe(401);
    expect(codeOf(res)).toBe("E2EE_REQUIRED");
    // Plaintext, deliberately: there is no context to seal with — that is the
    // whole complaint — so this is one of the refusals that stays readable.
    expect(res.headers["x-tb-e2ee"]).toBeUndefined();
  });

  it("POSITIVE CONTROL for the pin — an UNPINNED device's plaintext request is served", async () => {
    // Proves the 426 above is the pin firing and not "plaintext is refused
    // generally". A device registered with no Noise static key is unpinned and
    // keeps working exactly as it does today — the compatibility promise.
    const reg = repo.register({ publicKey: `legacy-plain-${Date.now()}` });
    const res = await raw({
      method: "GET",
      target: "/api/profiles",
      headers: { authorization: `Bearer ${reg.deviceToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf-8")).toBe("[]");
  });

  it("refuses a READ-ONLY device an admin route with a sealed 403, and keeps its context", async () => {
    // A context authenticates; it does not authorize. `/api/devices` requires
    // `admin`; a read-only device holds only `history:read`.
    const ctx = await openRestContext("read-only");
    const target = "/api/devices";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(403);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(sealedJson(ctx, "GET", target, 0n, res)).toMatchObject({
      code: "MISSING_CAPABILITY",
      required: "admin",
    });
    // Unlike the WS caller, which destroys here because its ticket is spent,
    // a REST context is long-lived: a read-only device that touched one route
    // it may not use must not lose the channel it is entitled to.
    expect(registry.get(ctx.ctxId)).not.toBeNull();
    const allowed = await sealedCall(ctx, { method: "GET", target: "/api/profiles", counter: 1n });
    expect(allowed.status).toBe(200);
  });
});

// ─── the two response paths ─────────────────────────────────────────

describe("REST envelope: both response paths are sealed", () => {
  it("seals a Hono-piped route (c.json)", async () => {
    const ctx = await openRestContext();
    const res = await sealedCall(ctx, { method: "GET", target: "/api/profiles", counter: 0n });
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    expect(unsealResponse(ctx, "GET", "/api/profiles", 0n, res)).toBe("[]");
  });

  it("seals a direct-write route (c.env.outgoing + the 597 sentinel)", async () => {
    const ctx = await openRestContext();
    // `GET /api/sessions/count`, whose real handler ends in `json(res, 200, …)`
    // — `res.writeHead(status, { "Content-Type": "application/json" })` then
    // `res.end(JSON.stringify(data))` (api/handlers/http-helpers.ts).
    directWrite = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 3 }));
    };
    const target = "/api/sessions/count";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(200);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(res.body.toString("utf-8")).not.toContain("count");
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe('{"count":3}');
  });

  it("seals a bodiless 304 into X-TB-Env, not into a body it cannot have", async () => {
    const ctx = await openRestContext();
    // The one `writeHead(304, …)` in the tree, quoted from
    // `api/handlers/conversations.handlers.ts`:
    //   res.writeHead(304, { ETag: etag, "Access-Control-Expose-Headers": "ETag" });
    //   res.end();
    directWrite = (res) => {
      res.writeHead(304, { ETag: '"abc"', "Access-Control-Expose-Headers": "ETag" });
      res.end();
    };
    const target = "/api/conversations/c1";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });

    expect(res.status).toBe(304);
    expect(res.body.length).toBe(0);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(typeof res.headers["x-tb-env"]).toBe("string");
    // Metadata stays plaintext by design (§3.2) — the validator still works.
    expect(res.headers.etag).toBe('"abc"');
    // The record is real, is the one this counter is owed, and unseals to the
    // empty body a 304 carries.
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe("");
  });

  it("marks every sealed response no-store, in both framings", async () => {
    // A sealed record is owed to ONE accepted counter (§13(a)), so a shared
    // HTTP cache holding a copy holds something nothing can unseal. The bite is
    // not the stale body: a cache that revalidates the `304` below applies its
    // headers onto the stored `200` and hands the client THAT status with the
    // empty payload a `304` carries — which is how the app's messages query
    // came back `JSON Parse error: Unexpected end of input` on iOS build 219.
    // The route says nothing about caching (`conversations.handlers.ts` sets an
    // `ETag` and no `Cache-Control`), so this header has to come from here.
    const body = await openRestContext();
    directWrite = (res) => {
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"abc"' });
      res.end(JSON.stringify({ count: 3 }));
    };
    const bodyRes = await sealedCall(body, {
      method: "GET",
      target: "/api/conversations/c1",
      counter: 0n,
    });
    expect(bodyRes.status).toBe(200);
    expect(bodyRes.headers["cache-control"]).toBe("no-store");

    // The other framing: the record rides in `X-TB-Env`, and is just as
    // single-use for travelling in a header.
    const bodiless = await openRestContext();
    directWrite = (res) => {
      res.writeHead(304, { ETag: '"abc"', "Access-Control-Expose-Headers": "ETag" });
      res.end();
    };
    const bodilessRes = await sealedCall(bodiless, {
      method: "GET",
      target: "/api/conversations/c1",
      counter: 0n,
    });
    expect(bodilessRes.status).toBe(304);
    expect(bodilessRes.headers["cache-control"]).toBe("no-store");
  });

  it("seals the ndjson stop stream as ONE record", async () => {
    const ctx = await openRestContext();
    // Quoted from `api/handlers/sessions.handlers.ts`: the ndjson header, an
    // early `stopping` line, then the terminal line.
    directWrite = async (res) => {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      res.write(`${JSON.stringify({ event: "stopping", sessionId: "s1" })}\n`);
      await new Promise((r) => setTimeout(r, 5));
      res.write(`${JSON.stringify({ event: "stopped", sessionId: "s1" })}\n`);
      res.end();
    };
    const target = "/api/sessions/s1/stop";
    const res = await sealedCall(ctx, { method: "POST", target, counter: 0n, body: "{}" });

    expect(res.headers["content-type"]).toBe("application/octet-stream");
    // Multi-record is not available: the AAD is fixed-width with no index field
    // and the sealer permits one seal per accepted counter, so per-line sealing
    // IS nonce reuse. One record, both lines.
    const plaintext = unsealResponse(ctx, "POST", target, 0n, res);
    expect(plaintext).toBe(
      '{"event":"stopping","sessionId":"s1"}\n{"event":"stopped","sessionId":"s1"}\n',
    );
    // And it decrypts as exactly one record: a second unseal of the same bytes
    // under the next counter is not a thing that exists.
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("makes a second end() a no-op, not a second seal", async () => {
    const ctx = await openRestContext();
    // A handler that ends twice. The counter is accepted exactly once, so a
    // second seal is refused by the sealer — and by then the first response is
    // already on the wire.
    //
    // **What this test pins is the CLIENT-VISIBLE half, and it is not the whole
    // safeguard.** With the guard removed the bytes below are still correct;
    // what breaks is an unhandled `ERR_HTTP_HEADERS_SENT` from the second
    // `writeHead`, which `@hono/node-server` raises on EVERY direct-write route
    // (it writes and ends the 597 sentinel itself). The suite catches that as a
    // non-zero exit with every assertion green, which is recorded in the
    // mutation table rather than papered over here.
    directWrite = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ once: true }));
      res.end(JSON.stringify({ twice: true }));
    };
    const target = "/api/sessions/count";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(200);
    expect(unsealResponse(ctx, "GET", target, 0n, res)).toBe('{"once":true}');
  });

  it("seals the response a thrown handler owes", async () => {
    const ctx = await openRestContext();
    directWrite = () => {
      throw Object.assign(new Error("session is busy"), { statusCode: 409, code: "BUSY" });
    };
    const target = "/api/sessions/count";
    const res = await sealedCall(ctx, { method: "GET", target, counter: 0n });
    expect(res.status).toBe(409);
    expect(res.headers["x-tb-e2ee"]).toBe("1");
    expect(res.body.toString("utf-8")).not.toContain("busy");
    expect(JSON.parse(unsealResponse(ctx, "GET", target, 0n, res))).toEqual({
      error: "session is busy",
      code: "BUSY",
    });
  });
});

// ─── target binding ─────────────────────────────────────────────────

describe("REST envelope: the AAD binds the raw request target (§4, D-7)", () => {
  it("drives the committed canonicalization vector", () => {
    const v = vectors.restTargetCanonicalization;
    const query = "since=2026-08-29&limit=50&limit=10&q=hello+world";
    const rawTarget = `/api/conversations/a%2Fb?${query}`;
    // The hash is over the raw wire target, method upper-cased, `\n`-joined.
    expect(restTargetHashFromUrl("POST", rawTarget)).toEqual(
      createHash("sha256").update(v.hashInputUtf8, "utf-8").digest(),
    );
    // …and the percent-DECODED path is a different target, as the fixture pins.
    expect(
      restTargetHashFromUrl("POST", `/api/conversations/a/b?${query}`).toString("base64"),
    ).toBe(v.decodedPathMustDiffer.hash);
  });

  it("refuses a sealed body re-pointed at another path", async () => {
    const ctx = await openRestContext();
    const frame = sealRequest(ctx, "POST", PROBE_PATH, 0n, "{}");
    // The identical record, delivered to a different target.
    const res = await raw({
      method: "POST",
      target: `${PROBE_PATH}?evil=1`,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "content-type": "application/octet-stream",
      },
      body: frame,
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });

  it("refuses a record sealed to the decoded path when the wire carries %2F", async () => {
    const ctx = await openRestContext();
    const encoded = "/api/conversations/a%2Fb";
    // Sealed against the DECODED spelling — which is what a server reading
    // Hono's `c.req.path` would compute, and what the client must not do.
    const frame = createRecordState({
      key: ctx.keys.clientToServer,
      ctxId: ctx.ctxIdRaw,
      direction: DIRECTION_C2S,
      channel: CHANNEL_REST_REQUEST,
      initialCounter: 0n,
    }).seal(Buffer.from("{}"), restTargetHash("GET", "/api/conversations/a/b", ""));

    const res = await raw({
      method: "GET",
      target: encoded,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "X-TB-Env": frame.toString("base64url"),
      },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);

    // The CONTROL: the same record sealed to the RAW spelling is accepted, so
    // the refusal above is about the encoding and not about the path existing.
    directWrite = (r) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end(JSON.stringify({ ok: true }));
    };
    const ok = await raw({
      method: "GET",
      target: encoded,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "1",
        "X-TB-Env": sealRequest(ctx, "GET", encoded, 1n, "{}").toString("base64url"),
      },
    });
    expect(ok.status).toBe(200);
    expect(unsealResponse(ctx, "GET", encoded, 1n, ok)).toBe('{"ok":true}');
  });

  it("refuses a record sealed to a percent-decoded space when the wire keeps %20", async () => {
    const ctx = await openRestContext();
    const encoded = "/api/conversations/a%20b";
    const frame = createRecordState({
      key: ctx.keys.clientToServer,
      ctxId: ctx.ctxIdRaw,
      direction: DIRECTION_C2S,
      channel: CHANNEL_REST_REQUEST,
      initialCounter: 0n,
    }).seal(Buffer.from("{}"), restTargetHash("GET", "/api/conversations/a b", ""));

    const res = await raw({
      method: "GET",
      target: encoded,
      headers: {
        "X-TB-E2EE": "1",
        "X-TB-Ctx": ctx.ctxId,
        "X-TB-Seq": "0",
        "X-TB-Env": frame.toString("base64url"),
      },
    });
    expect([res.status, codeOf(res)]).toEqual([400, "E2EE_SEAL_FAILED"]);
  });
});
