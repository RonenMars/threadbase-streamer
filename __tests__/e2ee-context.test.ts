import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspect } from "util";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import {
  CONTEXT_DRAIN_MS,
  contextExpiresAt,
  type E2eeContext,
  E2eeContextRegistry,
  MAX_REST_CONTEXTS_PER_DEVICE,
  MAX_WS_CONTEXTS_PER_DEVICE,
  newCtxId,
  provisionalExpiresAt,
  REST_CONTEXT_TTL_MS,
  refuseUnsealedIfPinned,
  TICKET_TTL_MS,
  WS_CONTEXT_TTL_MS,
} from "../src/e2ee/context";
import {
  generateKeyPair,
  OPEN_PROLOGUE,
  respond,
  type TrafficKeys,
  writeMessage1,
} from "../src/e2ee/noise";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_WS,
  createRecordState,
  DIRECTION_C2S,
  restTargetHash,
} from "../src/e2ee/record";
import { legacyPrincipal, type Principal } from "../src/services/security/capabilities";

/**
 * The context registry (Phase 3, W1a), against NONCE-DESIGN §8, §9, §10 and §12.
 *
 * The keys here come out of a REAL psk-less `IK` handshake rather than
 * `randomBytes`, because "two contexts, each from its own handshake" is the
 * property under test and a pair of invented buffers would model it away.
 */

/** One complete `/open` handshake: psk-less IK, the open prologue (§11). */
function handshakeKeys(): TrafficKeys {
  const server = generateKeyPair();
  const client = generateKeyPair();
  const { message } = writeMessage1({
    staticKeyPair: client,
    responderStaticPub: server.publicKeyRaw,
    pattern: "IK",
    payload: Buffer.from(JSON.stringify({ v: 1, kind: "ws" }), "utf-8"),
    prologue: OPEN_PROLOGUE,
  });
  return respond({
    staticKeyPair: server,
    pattern: "IK",
    message1: message,
    prologue: OPEN_PROLOGUE,
    buildPayload: () => Buffer.from("{}", "utf-8"),
  }).keys.consume();
}

const opened = new Map<string, TrafficKeys>();

function open(
  registry: E2eeContextRegistry,
  kind: "ws" | "rest",
  deviceId = "device-1",
  now?: number,
) {
  const { raw, id } = newCtxId();
  const keys = handshakeKeys();
  opened.set(id, keys);
  return registry.open({ deviceId, kind, ctxIdRaw: raw, ctxId: id, keys, now });
}

/**
 * The client half of a REST request, built from the SAME handshake keys the
 * context holds — a real peer rather than a shape assertion.
 */
function clientRequest(context: E2eeContext, target: Buffer, counter = 0n): Buffer {
  const keys = opened.get(context.ctxId) as TrafficKeys;
  return createRecordState({
    key: keys.clientToServer,
    ctxId: context.ctxIdRaw,
    direction: DIRECTION_C2S,
    channel: CHANNEL_REST_REQUEST,
    initialCounter: counter,
  }).seal(Buffer.from('{"q":1}'), target);
}

describe("ctxId (§12)", () => {
  it("is 16 server-assigned random bytes, 22 base64url characters, never derived", () => {
    const a = newCtxId();
    const b = newCtxId();
    expect(a.raw).toHaveLength(16);
    expect(a.id).toHaveLength(22);
    expect(a.id).toBe(a.raw.toString("base64url"));
    // Unpadded, and not the padded base64 spelling.
    expect(a.id).not.toContain("=");
    expect(a.id).not.toBe(b.id);
  });
});

describe("two contexts per device (§8)", () => {
  let registry: E2eeContextRegistry;
  beforeEach(() => {
    registry = new E2eeContextRegistry();
  });

  it("gives one device a socket context and a REST context with different ids", () => {
    const ws = open(registry, "ws");
    const rest = open(registry, "rest");

    expect(ws.ctxId).not.toBe(rest.ctxId);
    expect(registry.get(ws.ctxId)?.kind).toBe("ws");
    expect(registry.get(rest.ctxId)?.kind).toBe("rest");
    expect(registry.forDevice("device-1")).toHaveLength(2);
  });

  it("keys receive state by (context, channel), not by context alone", () => {
    const ws = open(registry, "ws");
    const rest = open(registry, "rest");

    expect(ws.receiveState(CHANNEL_WS).channel).toBe(CHANNEL_WS);
    // A socket context carries no REST channel and a REST context no socket
    // channel — asking is a bug, not a fallback.
    expect(() => ws.receiveState(CHANNEL_REST_REQUEST)).toThrow();
    expect(() => ws.sealResponse(0n, Buffer.from("x"), restTargetHash("GET", "/", ""))).toThrow();
    expect(rest.receiveState(CHANNEL_REST_REQUEST).channel).toBe(CHANNEL_REST_REQUEST);
    expect(() => rest.sendState(CHANNEL_WS)).toThrow();
  });

  it("destroys the socket context at close with no grace window, and issues a new id on reconnect", () => {
    const first = open(registry, "ws");
    expect(registry.get(first.ctxId)).not.toBeNull();

    // The socket closed.
    expect(registry.destroy(first.ctxId)).toBe(true);
    // Immediately — there is no window in which the old id still resolves.
    expect(registry.get(first.ctxId)).toBeNull();

    const second = open(registry, "ws");
    expect(second.ctxId).not.toBe(first.ctxId);
    expect(registry.get(first.ctxId)).toBeNull();
    expect(registry.get(second.ctxId)).not.toBeNull();
  });

  it("keeps the REST context working while no socket is open (§8)", () => {
    const ws = open(registry, "ws");
    const rest = open(registry, "rest");

    registry.destroy(ws.ctxId);

    // The 2 s HTTP replay fallback runs exactly here, so this must still work —
    // and "work" means a real sealed round trip, not merely still resolving.
    const live = registry.get(rest.ctxId);
    expect(live).not.toBeNull();
    const target = restTargetHash("GET", "/api/sessions", "limit=50");
    expect(live?.unsealRequest(clientRequest(rest, target), target).toString()).toBe('{"q":1}');
    const response = live?.sealResponse(0n, Buffer.from('{"lines":[]}'), target);
    expect(response?.length).toBeGreaterThan(0);
  });

  it("lets each socket have its own context and never replaces a live one", () => {
    // Two sockets briefly overlapping during a reconnect is ordinary, and the
    // older one must keep working until IT closes — replacing here would break
    // the connection being replaced.
    const first = open(registry, "ws");
    const second = open(registry, "ws");
    expect(registry.get(first.ctxId)).not.toBeNull();
    expect(registry.get(second.ctxId)).not.toBeNull();
  });
});

describe("provisional contexts (§8)", () => {
  it("dies at the ticket TTL when nothing ever authenticates under it", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    const ws = open(registry, "ws", "device-1", now);

    expect(ws.provisional).toBe(true);
    expect(ws.expiresAt).toBe(provisionalExpiresAt(now));
    expect(registry.get(ws.ctxId, now + TICKET_TTL_MS - 1)).not.toBeNull();
    // A replayed `IK` msg1 costs an attacker two DH and allocates this; 30 s
    // later it is gone rather than resident for a day.
    expect(registry.get(ws.ctxId, now + TICKET_TTL_MS)).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("is promoted to the full lifetime when its ticket is consumed", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    const ws = open(registry, "ws", "device-1", now);
    const ticket = registry.issueTicket(ws.ctxId, now);

    expect(registry.consumeTicket(ticket, now + 10_000)).toBe(ws.ctxId);

    expect(ws.provisional).toBe(false);
    expect(ws.expiresAt).toBe(contextExpiresAt("ws", now + 10_000));
    // The 30 s deadline is gone: the socket is live and may run all day.
    expect(registry.get(ws.ctxId, now + TICKET_TTL_MS + 1)).not.toBeNull();
    expect(WS_CONTEXT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is promoted by a REST request unsealing under it", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    const rest = open(registry, "rest", "device-1", now);
    const target = restTargetHash("POST", "/api/sessions/a/input", "");

    rest.unsealRequest(clientRequest(rest, target), target);

    expect(rest.provisional).toBe(false);
    expect(rest.expiresAt).toBeGreaterThan(provisionalExpiresAt(now));
    expect(REST_CONTEXT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("never evicts the context it is opening (§8, adversary C)", () => {
    const registry = new E2eeContextRegistry();
    const t0 = Date.now();

    // FOUR LIVE, IN-USE socket contexts. The fixture must hold them in use:
    // with four *unused* ones the "provisional first" ordering picks one of
    // them and the bug hides, which is exactly how this shipped.
    const inUse = [];
    for (let i = 0; i < MAX_WS_CONTEXTS_PER_DEVICE; i++) {
      const context = open(registry, "ws", "device-1", t0 + i);
      const ticket = registry.issueTicket(context.ctxId, t0 + i);
      registry.consumeTicket(ticket, t0 + i);
      expect(context.provisional).toBe(false);
      inUse.push(context);
    }

    const fifth = open(registry, "ws", "device-1", t0 + 100);
    const ticket = registry.issueTicket(fifth.ctxId, t0 + 100);

    // The fifth is USABLE: it was provisional, so a naive "provisional first"
    // ordering sorted it to the front of its own eviction queue and it died at
    // the drain deadline — a device with four live sockets could then never
    // open a working one, and consuming the ticket could not save it because
    // `deadline()` is `min(expiresAt, retireAt)`.
    expect(fifth.retireAt).toBeNull();
    expect(registry.consumeTicket(ticket, t0 + 101)).toBe(fifth.ctxId);
    expect(registry.get(fifth.ctxId, t0 + CONTEXT_DRAIN_MS + 1_000)).not.toBeNull();
    expect(registry.get(fifth.ctxId, t0 + 60 * 60 * 1000)).not.toBeNull();

    // And the oldest live one is the one retired, with its drain.
    expect(inUse[0].retireAt).toBe(t0 + 100 + CONTEXT_DRAIN_MS);
    expect(registry.get(inUse[0].ctxId, t0 + 100 + CONTEXT_DRAIN_MS - 1)).not.toBeNull();
    expect(registry.get(inUse[0].ctxId, t0 + 100 + CONTEXT_DRAIN_MS + 1)).toBeNull();
    // The other three are untouched.
    for (const survivor of inUse.slice(1)) expect(survivor.retireAt).toBeNull();
  });

  it("evicts the UNUSED before the used, not simply the oldest (§8)", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    // The oldest context is the one actually carrying traffic. Evicting by
    // `createdAt` alone would destroy exactly this one and keep three that were
    // opened seconds ago and never authenticated — inverted in the case that
    // matters, a replay storm.
    const workhorse = open(registry, "ws", "device-1", now);
    workhorse.markUsed(now);
    const idle = [];
    for (let i = 1; i < MAX_WS_CONTEXTS_PER_DEVICE; i++) {
      idle.push(open(registry, "ws", "device-1", now + i));
    }

    open(registry, "ws", "device-1", now + 100);

    // The session that is live keeps working; the oldest never-used one goes.
    expect(registry.get(workhorse.ctxId, now + 200)).not.toBeNull();
    expect(registry.get(idle[0].ctxId, now + 200 + CONTEXT_DRAIN_MS)).toBeNull();
  });

  it("drains an evicted context rather than killing a request in flight (§8)", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    const rests = [];
    for (let i = 0; i <= MAX_REST_CONTEXTS_PER_DEVICE; i++) {
      rests.push(open(registry, "rest", "device-1", now + i));
    }

    const evicted = rests[0];
    // Still answering during the drain: a request already in flight on it must
    // not die mid-transaction because its replacement registered.
    expect(registry.get(evicted.ctxId, now + CONTEXT_DRAIN_MS - 1)).not.toBeNull();
    expect(evicted.retireAt).toBe(now + MAX_REST_CONTEXTS_PER_DEVICE + CONTEXT_DRAIN_MS);
    // And then it is gone, well inside the 30 s provisional window.
    expect(registry.get(evicted.ctxId, now + CONTEXT_DRAIN_MS + 10)).toBeNull();
    expect(CONTEXT_DRAIN_MS).toBeLessThan(TICKET_TTL_MS);
  });

  it("caps LIVE contexts per device, counting a draining one as gone (§8)", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    for (let i = 0; i <= MAX_WS_CONTEXTS_PER_DEVICE + 2; i++) {
      open(registry, "ws", "device-1", now + i);
    }
    const live = registry
      .forDevice("device-1")
      .filter((c) => c.kind === "ws" && c.retireAt === null);
    expect(live).toHaveLength(MAX_WS_CONTEXTS_PER_DEVICE);
  });
});

describe("collection (§8)", () => {
  it("sweeps dead contexts and their tickets on the next open", () => {
    const registry = new E2eeContextRegistry();
    const t0 = Date.now();

    // Twenty replayed msg1s. Each allocates a provisional context and a ticket
    // that NOBODY will ever present — the attacker cannot read msg2, so it
    // never learns the ticket, and `get()` is never called for these ids. They
    // are exactly the objects nothing else collects.
    for (let i = 0; i < 20; i++) {
      const context = open(registry, "ws", "device-1", t0 + i);
      registry.issueTicket(context.ctxId, t0 + i);
    }

    // Live contexts stay at the cap throughout: the rest are retired and
    // draining, which is the bounded overhang §8 allows.
    const live = registry.forDevice("device-1").filter((c) => c.retireAt === null);
    expect(live).toHaveLength(MAX_WS_CONTEXTS_PER_DEVICE);

    // And once their deadlines pass, the next open collects every one of them
    // — maps and tickets both. Without this the two maps grow forever, which
    // is the bound the provisional TTL was written to provide being defeated by
    // the very thing it was written for.
    // Past every deadline — the retired ones at their 10 s drain, the four
    // live ones at their 30 s provisional TTL.
    open(registry, "ws", "device-1", t0 + TICKET_TTL_MS + 100);
    expect(registry.size).toBe(1);
    expect(registry.ticketCount).toBe(0);
  });

  it("drops a ticket bound to a context that was never registered", () => {
    // `/api/e2ee/open` mints the ticket before it can register the context —
    // the traffic keys do not exist until msg2 is written — so its failure path
    // destroys a `ctxId` the map has never seen. A live ticket left pointing at
    // a context that will never exist is the leak that path exists to prevent.
    const registry = new E2eeContextRegistry();
    const ticket = registry.issueTicket("a-context-that-never-existed");

    expect(registry.destroy("a-context-that-never-existed")).toBe(false);

    expect(registry.ticketCount).toBe(0);
    expect(registry.consumeTicket(ticket)).toBeNull();
  });
});

describe("context lifetime (§8)", () => {
  it("expires and stops resolving, and a restart takes every context with it", () => {
    const registry = new E2eeContextRegistry();
    const now = Date.now();
    const rest = open(registry, "rest", "device-1", now);
    rest.markUsed(now);

    expect(contextExpiresAt("rest", now)).toBe(now + REST_CONTEXT_TTL_MS);
    expect(registry.get(rest.ctxId, rest.expiresAt - 1)).not.toBeNull();
    expect(registry.get(rest.ctxId, rest.expiresAt)).toBeNull();
    // Expiry evicts rather than merely refusing, so a dead context is not still
    // holding traffic keys in memory.
    expect(registry.size).toBe(0);

    // A restart is a fresh registry: nothing captured earlier can be replayed
    // into the new run.
    expect(new E2eeContextRegistry().get(rest.ctxId)).toBeNull();
  });

  it("destroys every context for a revoked device and reports the sockets to terminate", () => {
    const registry = new E2eeContextRegistry();
    const ws = open(registry, "ws", "device-A");
    const alsoWs = open(registry, "ws", "device-A");
    const rest = open(registry, "rest", "device-A");
    registry.issueTicket(ws.ctxId);
    const other = open(registry, "ws", "device-B");

    const destroyed = registry.destroyDevice("device-A");

    // The registry holds no sockets, so it names them and W1b terminates them —
    // a live encrypted socket must not outlive its revocation.
    expect(new Set(destroyed.socketCtxIds)).toEqual(new Set([ws.ctxId, alsoWs.ctxId]));
    expect(destroyed.restCtxIds).toEqual([rest.ctxId]);
    expect(destroyed.tickets).toBe(1);
    expect(registry.get(ws.ctxId)).toBeNull();
    expect(registry.get(rest.ctxId)).toBeNull();
    // Revoking one device is not collateral against another.
    expect(registry.get(other.ctxId)).not.toBeNull();
  });
});

describe("WS ticket (§8, §12)", () => {
  it("is single-use: two concurrent upgrades with one ticket, exactly one accepted", async () => {
    const registry = new E2eeContextRegistry();
    const ws = open(registry, "ws");
    const ticket = registry.issueTicket(ws.ctxId);
    expect(ticket).toHaveLength(22);

    const results = await Promise.all([
      Promise.resolve().then(() => registry.consumeTicket(ticket)),
      Promise.resolve().then(() => registry.consumeTicket(ticket)),
    ]);

    expect(results.filter((r) => r === ws.ctxId)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(registry.ticketCount).toBe(0);
  });

  it("expires after 30 seconds and is spent even when presented late", () => {
    const registry = new E2eeContextRegistry();
    const ws = open(registry, "ws");
    const now = Date.now();
    const ticket = registry.issueTicket(ws.ctxId, now);

    expect(registry.consumeTicket(ticket, now + TICKET_TTL_MS)).toBeNull();
    expect(registry.consumeTicket(ticket, now)).toBeNull();
  });

  it("drops the ticket when its context is destroyed", () => {
    const registry = new E2eeContextRegistry();
    const ws = open(registry, "ws");
    const ticket = registry.issueTicket(ws.ctxId);

    registry.destroy(ws.ctxId);

    expect(registry.consumeTicket(ticket)).toBeNull();
  });
});

describe("the registry never renders a live ticket (round 4)", () => {
  it("keeps the ticket table out of every rendering mode", () => {
    // A ticket is a credential by §10's own reasoning — single-use, 30 seconds,
    // and the thing that authorises a socket upgrade. The table rendered in
    // full under `inspect(registry, { customInspect: false, showHidden: true })`:
    // every live ticket in the process, in one call, from the object a
    // diagnostics dump reaches for first.
    const registry = new E2eeContextRegistry();
    const ws = open(registry, "ws");
    const ticket = registry.issueTicket(ws.ctxId);

    const modes = [
      inspect(registry),
      inspect(registry, { showHidden: true, depth: 12 }),
      inspect(registry, { customInspect: false, depth: 12 }),
      inspect(registry, { customInspect: false, showHidden: true, depth: 12 }),
      inspect({ wrapped: registry }, { customInspect: false, showHidden: true, depth: 12 }),
      inspect(Object.getOwnPropertyDescriptors(registry), { showHidden: true, depth: 12 }),
      String(JSON.stringify(registry)),
      inspect({ ...registry }, { showHidden: true, depth: 12 }),
    ];
    expect(modes.some((m) => m.includes(ticket))).toBe(false);

    // The control: the same string in a plain container IS found, so the
    // assertion is about the registry and not about a search that cannot match.
    expect(inspect({ t: ticket }, { showHidden: true })).toContain(ticket);

    // And the ticket still works.
    expect(registry.consumeTicket(ticket)).toBe(ws.ctxId);
  });
});

describe("public buffers share no allocation (§13, round 5, finding 2)", () => {
  /** True when a buffer owns its whole backing store — i.e. is not pooled. */
  const standsAlone = (b: Buffer) => b.byteOffset === 0 && b.buffer.byteLength === b.byteLength;

  it("keeps every public buffer out of the shared pool", () => {
    // Node pool-allocates small Buffers, and a Buffer's `.buffer` exposes the
    // whole 8 KiB block. So a PUBLIC buffer carved from the pool hands out a
    // window onto whatever was allocated beside it — which is how a registry
    // walk reached live traffic keys through `ctxId`, without touching a
    // key-bearing class at all. `#private` closes nothing against that.
    const registry = new E2eeContextRegistry();
    const { raw, id } = newCtxId();
    const keys = handshakeKeys();
    const context = registry.open({
      deviceId: "device-1",
      kind: "ws",
      ctxIdRaw: raw,
      ctxId: id,
      keys,
    });

    expect(standsAlone(raw)).toBe(true);
    expect(standsAlone(context.ctxIdRaw)).toBe(true);
    expect(standsAlone(context.receiveState(CHANNEL_WS).ctxId)).toBe(true);
    // A sealed frame is public too, and `Buffer.concat` would have pooled it.
    expect(standsAlone(context.sendState(CHANNEL_WS).seal(Buffer.from("hello")))).toBe(true);

    // The control: an ordinary small allocation IS pooled, so the assertions
    // above are about these buffers and not about a check that always passes.
    expect(standsAlone(Buffer.allocUnsafe(16))).toBe(false);
    expect(standsAlone(Buffer.from("some short string"))).toBe(false);
  });
});

describe("no key bytes leave src/ (§13, round 5)", () => {
  it("has no production caller of KeyObject.export()", () => {
    // The traffic keys are `KeyObject`s so that no bytes exist to render, walk
    // or pool-share. That property is only true while nothing in `src/` asks
    // for them back — tests may, to obtain needles, and this is what keeps that
    // exception from spreading.
    // Scoped to the E2EE module and its route: `server-identity.ts` exports the
    // PUBLIC half of the identity key as a JWK, which is a different thing
    // entirely and predates this rule.
    let out = "";
    try {
      out = execFileSync(
        "/usr/bin/grep",
        ["-rn", "\\.export(", "src/e2ee/", "src/api/routes/e2ee.routes.ts"],
        { cwd: join(__dirname, ".."), encoding: "utf8" },
      ).trim();
    } catch {
      // grep exits 1 with no matches, which is the passing case.
      out = "";
    }
    // The one permitted match is `rawPublicKey`'s JWK export of a PUBLIC
    // X25519 key, which is not secret material. Every other `.export(` is a
    // traffic key leaving OpenSSL, which is the thing this rule forbids.
    const offenders = out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !line.includes('format: "jwk"'));
    expect(offenders).toEqual([]);
  });
});

describe("the 426 refusal (design.md §6.3)", () => {
  let dir: string;
  let store: RuntimeStore;
  let repo: DevicesRepository;
  let registry: E2eeContextRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-e2ee-ctx-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
    repo = new DevicesRepository(store.getDatabase());
    registry = new E2eeContextRegistry();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const principalFor = (deviceId: string): Principal => ({
    kind: "device",
    deviceId,
    capabilities: [],
  });

  it("refuses a pinned device that arrives in the clear", () => {
    const pinned = repo.register({ publicKey: "pk", e2eeStaticPub: "static-key", e2eeVersion: 1 });

    const refusal = refuseUnsealedIfPinned({
      principal: principalFor(pinned.deviceId),
      devicesRepo: repo,
      context: null,
    });

    expect(refusal?.status).toBe(426);
    expect(refusal?.body.code).toBe("E2EE_REQUIRED");
  });

  it("fails CLOSED on every answer that is not a positive unpinned (round 5, finding 1)", () => {
    // The old guard was `row?.e2ee_required !== 1` over `repo?.get(id) ?? null`,
    // which answered "serve it in the clear" for a null repository, a missing
    // row, and every value other than the exact number 1 — `true`, `"1"`,
    // `undefined`. A downgrade guard that defaults to allowing the downgrade is
    // not a guard, and this is the one two other tracks consume.
    const principal = principalFor("device-that-may-not-exist");
    const cases: Array<[string, Parameters<typeof refuseUnsealedIfPinned>[0]["devicesRepo"]]> = [
      ["no repository at all", null],
      ["an undefined repository", undefined],
      ["a repository with no such row", { get: () => null }],
      ["a row whose flag is undefined", { get: () => ({}) as never }],
      ["a row whose flag is the string 1", { get: () => ({ e2ee_required: "1" }) as never }],
      ["a row whose flag is true", { get: () => ({ e2ee_required: true }) as never }],
      ["a row whose flag is null", { get: () => ({ e2ee_required: null }) as never }],
      ["a row whose flag is 2", { get: () => ({ e2ee_required: 2 }) as never }],
      [
        "a repository that throws",
        {
          get: () => {
            throw new Error("runtime.db is unreadable");
          },
        },
      ],
    ];
    for (const [name, devicesRepo] of cases) {
      const refusal = refuseUnsealedIfPinned({ principal, devicesRepo, context: null });
      expect(refusal?.status, name).toBe(426);
      expect(refusal?.body.code, name).toBe("E2EE_REQUIRED");
    }

    // The last prototype-chain read in `src/e2ee/*`, and it was in this guard: a
    // row that simply lacks the column must refuse, and a polluted
    // `Object.prototype.e2ee_required = 0` must not answer for it.
    const proto = Object.prototype as Record<string, unknown>;
    proto.e2ee_required = 0;
    try {
      const refusal = refuseUnsealedIfPinned({
        principal,
        devicesRepo: { get: () => ({}) as never },
        context: null,
      });
      expect(refusal?.status).toBe(426);
    } finally {
      delete proto.e2ee_required;
    }

    // Unpinned is a POSITIVE answer the store has to give: exactly the number 0.
    expect(
      refuseUnsealedIfPinned({
        principal,
        devicesRepo: { get: () => ({ e2ee_required: 0 }) as never },
        context: null,
      }),
    ).toBeNull();
  });

  it("lets the same device through once it is sealed", () => {
    const pinned = repo.register({ publicKey: "pk", e2eeStaticPub: "static-key", e2eeVersion: 1 });
    const context = open(registry, "rest", pinned.deviceId);

    expect(
      refuseUnsealedIfPinned({
        principal: principalFor(pinned.deviceId),
        devicesRepo: repo,
        context,
      }),
    ).toBeNull();
  });

  it("leaves an unpinned device and the shared key untouched", () => {
    const plain = repo.register({ publicKey: "pk-2" });

    expect(
      refuseUnsealedIfPinned({
        principal: principalFor(plain.deviceId),
        devicesRepo: repo,
        context: null,
      }),
    ).toBeNull();
    expect(
      refuseUnsealedIfPinned({ principal: legacyPrincipal(), devicesRepo: repo, context: null }),
    ).toBeNull();
  });
});
