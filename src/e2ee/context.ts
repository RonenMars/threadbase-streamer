// Transport contexts: what a completed `/api/e2ee/open` handshake leaves
// behind, and the only place a `ctxId` ever resolves to keys.
//
// specs/end-to-end-encryption/NONCE-DESIGN.md §8 is the design of record here
// and it supersedes design.md §4.3 on two points that would otherwise have
// shipped a bug:
//
//   1. **Two contexts per device, not one.** A WebSocket context bound to
//      exactly one socket, and a long-lived REST context. A single device-wide
//      context that died with the socket would take the 2 s HTTP replay
//      fallback down with it — that fallback runs *precisely* when the socket
//      is unavailable — and, worse, a context SHARED by both would
//      sequence-violate itself into a close loop: frames in flight when a
//      socket drops are lost, so under the strict counter (§5 R2) the first
//      frame after a reconnect is a gap, the client closes, reconnects, gaps
//      again, and never recovers.
//   2. **No grace window.** A socket's context is destroyed at its close. A
//      reconnect opens a NEW context — new `ctxId`, new keys, counters
//      legitimately at 0 — which is not a counter reset: the invariant scopes
//      uniqueness per context.
//
// Contexts are IN-MEMORY ONLY. They do not survive a streamer restart, which is
// what stops an old capture from ever being replayed into a new run.
//
// A key is never REPLACED inside a context (§6): 24 h, 1 GiB and a foreground
// past threshold all mean "open a new context and retire the old one", so there
// is no rekey here, no `bytesSealed`, and no key generation for a concurrent
// REST receiver to have to guess at.

import { type KeyObject, randomBytes } from "crypto";
import { type DeviceRow, parseCapabilities } from "../db/repositories/devices.repository";
import type { Principal } from "../services/security/capabilities";
import type { TrafficKeys } from "./noise";
import { E2EE_CTX_UNKNOWN, own, redactKeyMaterial, unpooled } from "./protocol";
import {
  CHANNEL_REST_REQUEST,
  CHANNEL_WS,
  type Channel,
  CTX_ID_BYTES,
  createRecordState,
  DIRECTION_C2S,
  DIRECTION_S2C,
  RecordError,
  type RecordState,
  RestResponseSealer,
} from "./record";

/**
 * The header a client presents its single-use WebSocket ticket in.
 *
 * **A header, never a query parameter** (§10). `?ticket=` lands in every ingress
 * access log — Cloudflare logs full request URLs — and single-use plus thirty
 * seconds bounds that damage without removing it. React Native's `WebSocket`
 * takes custom headers, so the ticket never needs to touch a URL at all. The
 * property that buys is stronger than redaction: there is nothing to redact,
 * because `http.request` logs a method, a path and a summarised query, never a
 * header.
 *
 * It lives HERE rather than beside the route because `auth.middleware.ts` reads
 * it too — a ticketed upgrade authenticates by its ticket (§13) — and a route
 * module is not something the auth middleware should have to import.
 */
export const TICKET_HEADER = "x-tb-ticket";

/** §8: a provisional context, and its ticket, die at 30 s. */
export const TICKET_TTL_MS = 30_000;
/** A socket outlives this only if it is still open; it is a backstop. */
export const WS_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
/** §8: a REST context is destroyed at 24 h and the client re-opens. */
export const REST_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

/** §8: cap live contexts per device, evicting by usefulness. */
export const MAX_WS_CONTEXTS_PER_DEVICE = 4;
export const MAX_REST_CONTEXTS_PER_DEVICE = 2;

/**
 * How long an evicted context keeps answering before it is swept (§8).
 *
 * "Eviction honours the drain": a context destroyed the instant its
 * replacement registers kills a request that is in flight on it, which is the
 * opposite of the short drain §6 promises. Ten seconds is far longer than any
 * REST round trip on this product and far shorter than the 30 s provisional
 * TTL, so a drained context never outlives the window it was evicted in.
 * NONCE-DESIGN names the rule and not a number; this is the number.
 */
export const CONTEXT_DRAIN_MS = 10_000;

export type ContextKind = "ws" | "rest";

/**
 * A fresh context handle: 16 random bytes, base64url, 22 characters.
 *
 * **Server-assigned, never derived** (§12). The earlier
 * `HKDF(h_ss, "tb-e2ee-ctx-id", 16)` was fine as a server-side detail and wrong
 * as a contract: it pinned no salt/info/IKM roles, the client has no HKDF of
 * that shape, and since the server returns `ctxId` in msg2 anyway a deriving
 * client would hold a second source of truth to disagree with. It was also
 * circular in practice — the transcript hash a client would derive from is
 * computed over the very payload the `ctxId` has to travel in.
 */
export function newCtxId(): { raw: Buffer; id: string } {
  // UNPOOLED: `ctxId` is public by design and travels on every sealed record,
  // and a pooled public Buffer exposes the shared 8 KiB block it was carved
  // from — which is how a registry walk reached live traffic keys without
  // touching a key-bearing class at all (§13).
  const raw = unpooled(randomBytes(CTX_ID_BYTES));
  return { raw, id: raw.toString("base64url") };
}

/**
 * When a context of this kind, opened now, stops resolving — before it has been
 * used for anything.
 *
 * Every context starts PROVISIONAL and dies at the ticket TTL (§8). An `IK`
 * msg1 carries no freshness, so anyone who captured one valid `/open` msg1 can
 * replay it: each replay passes "fail closed on the device row", because the
 * static key genuinely is a known device, and allocates a context and a ticket
 * for two DH and one AEAD. The attacker never gets keys — msg2 needs `D_priv` —
 * so this is pure allocation, the D-9 class, on a public endpoint. Without this
 * rule a socket context whose ticket is never consumed has no end of life at
 * all.
 */
export function provisionalExpiresAt(now: number): number {
  return now + TICKET_TTL_MS;
}

/** When a context that HAS been used stops resolving. */
export function contextExpiresAt(kind: ContextKind, now: number): number {
  return now + (kind === "ws" ? WS_CONTEXT_TTL_MS : REST_CONTEXT_TTL_MS);
}

export interface E2eeContext {
  /** The wire handle: base64url, 22 characters. What `X-TB-Ctx` carries. */
  readonly ctxId: string;
  /** The same value as the 16 raw bytes the AAD binds. */
  readonly ctxIdRaw: Buffer;
  readonly deviceId: string;
  readonly kind: ContextKind;
  readonly createdAt: number;
  /** Moves out to the full lifetime once the context is first used (§8). */
  readonly expiresAt: number;
  /** True until the ticket is consumed or a request unseals under it (§8). */
  readonly provisional: boolean;
  /** Set when the context has been evicted and is draining; null otherwise (§8). */
  readonly retireAt: number | null;
  /** The moment this context stops resolving: its expiry, or its drain deadline. */
  deadline(): number;
  /** The sending half for a channel. Throws for a channel this kind does not carry. */
  sendState(channel: Channel): RecordState;
  /** The receiving half for a channel. Throws for a channel this kind does not carry. */
  receiveState(channel: Channel): RecordState;
  /** REST only: unseal a request and record its counter as answerable (§13(a)). */
  unsealRequest(frame: Buffer, target: Buffer): Buffer;
  /** REST only: seal the one response that request is owed (§13(a)). */
  sealResponse(requestCounter: bigint, plaintext: Buffer, target: Buffer): Buffer;
  /** First authenticated use. Promotes out of provisional. */
  markUsed(now?: number): void;
}

const contextInvalidators = new WeakMap<E2eeContext, () => void>();

class Context implements E2eeContext {
  readonly ctxId: string;
  readonly ctxIdRaw: Buffer;
  readonly deviceId: string;
  readonly kind: ContextKind;
  readonly createdAt: number;
  expiresAt: number;
  provisional = true;
  retireAt: number | null = null;

  // Receive state is keyed by (context, CHANNEL) rather than by context alone,
  // because the two channels have genuinely different rules: strict `expected`
  // on the WebSocket, a sliding window on REST (§8, design.md §3.4).
  readonly #send = new Map<Channel, RecordState>();
  readonly #receive = new Map<Channel, RecordState>();
  #responses: RestResponseSealer | null;

  constructor(args: {
    ctxIdRaw: Buffer;
    ctxId: string;
    deviceId: string;
    kind: ContextKind;
    keys: TrafficKeys;
    now: number;
  }) {
    this.ctxIdRaw = unpooled(args.ctxIdRaw);
    this.ctxId = args.ctxId;
    this.deviceId = args.deviceId;
    this.kind = args.kind;
    this.createdAt = args.now;
    this.expiresAt = provisionalExpiresAt(args.now);

    const state = (key: KeyObject, direction: Direction, channel: Channel) =>
      createRecordState({ key, ctxId: this.ctxIdRaw, direction, channel });

    if (args.kind === "ws") {
      this.#send.set(CHANNEL_WS, state(args.keys.serverToClient, DIRECTION_S2C, CHANNEL_WS));
      this.#receive.set(CHANNEL_WS, state(args.keys.clientToServer, DIRECTION_C2S, CHANNEL_WS));
      this.#responses = null;
    } else {
      // ─── SEAM: the REST sliding window goes here ──────────────────────
      // This receive state is STRICT today, which is correct for a channel
      // nothing concurrent uses yet and wrong the moment React Query issues two
      // requests at once (design.md §3.4: an RFC-6479-style 1024-bit bitmap,
      // accept above the window and advance, accept inside it with the bit
      // clear, reject below or already set). The REST track replaces the
      // acceptance rule on THIS state and nothing else — the WebSocket's
      // strictness (§5 R2) must not be relaxed to share an implementation.
      this.#receive.set(
        CHANNEL_REST_REQUEST,
        state(args.keys.clientToServer, DIRECTION_C2S, CHANNEL_REST_REQUEST),
      );
      // Responses have NO counter of their own: each echoes the counter of the
      // request it answers (§13(a)).
      this.#responses = new RestResponseSealer({
        key: args.keys.serverToClient,
        ctxId: this.ctxIdRaw,
      });
    }

    contextInvalidators.set(this, () => {
      this.#send.clear();
      this.#receive.clear();
      this.#responses = null;
    });

    // Holds record states, which hold traffic keys. Redacted through the same
    // helper as everything else that carries key material, so a fifth
    // key-bearing object cannot be added with a fourth private convention.
    redactKeyMaterial(
      this,
      () =>
        `E2eeContext { ctxId: ${this.ctxId}, kind: ${this.kind}, provisional: ${this.provisional}, keys: <#private, in its record states> }`,
    );
  }

  sendState(channel: Channel): RecordState {
    const s = this.#send.get(channel);
    if (!s) throw new RecordError(E2EE_CTX_UNKNOWN, `no send state for channel ${channel}`);
    return s;
  }

  receiveState(channel: Channel): RecordState {
    const s = this.#receive.get(channel);
    if (!s) throw new RecordError(E2EE_CTX_UNKNOWN, `no receive state for channel ${channel}`);
    return s;
  }

  unsealRequest(frame: Buffer, target: Buffer): Buffer {
    const sealer = this.requireRest();
    const state = this.receiveState(CHANNEL_REST_REQUEST);
    const counter = state.counter;
    const plaintext = state.unseal(frame, target);
    // Acceptance is recorded ONLY on the success path, which is what makes
    // §13(a) enforceable rather than a rule a middleware has to remember: a
    // request the window or the AEAD rejected can never be answered with a
    // sealed body, because no counter was ever accepted for it.
    sealer.accept(counter);
    this.markUsed();
    return plaintext;
  }

  sealResponse(requestCounter: bigint, plaintext: Buffer, target: Buffer): Buffer {
    return this.requireRest().seal(requestCounter, plaintext, target);
  }

  deadline(): number {
    return this.retireAt === null ? this.expiresAt : Math.min(this.expiresAt, this.retireAt);
  }

  /** Evicted: keep answering for the drain, then go (§8). */
  retire(at: number): void {
    this.retireAt = this.retireAt === null ? at : Math.min(this.retireAt, at);
  }

  markUsed(now: number = Date.now()): void {
    if (!this.provisional) return;
    this.provisional = false;
    // Measured from first use, not from the open: a ticket consumed at 29 s
    // should not leave a socket 29 seconds short of its day.
    this.expiresAt = contextExpiresAt(this.kind, now);
  }

  private requireRest(): RestResponseSealer {
    if (!this.#responses) {
      throw new RecordError(E2EE_CTX_UNKNOWN, "not a REST context");
    }
    return this.#responses;
  }
}

function invalidateContext(context: E2eeContext): void {
  contextInvalidators.get(context)?.();
}

type Direction = typeof DIRECTION_C2S | typeof DIRECTION_S2C;

/** What registry destruction reports to the caller (§8). */
export interface DestroyedContexts {
  /** WS contexts that were still indexed when destruction began. */
  socketCtxIds: string[];
  restCtxIds: string[];
  /** Unconsumed tickets dropped, so a revoked device cannot still upgrade. */
  tickets: number;
}

/**
 * Every live context on this process, and the WS tickets bound to them.
 *
 * In-memory by design (§8). One instance per server — `contextRegistry()` below
 * — because the `/api/e2ee/open` route writes to it and the WebSocket upgrade
 * and the REST middleware read from it, and a second registry would mean a
 * context that exists for one of them and not the others.
 */
export class E2eeContextRegistry {
  readonly #contexts = new Map<string, Context>();
  readonly #byDevice = new Map<string, Set<string>>();
  /**
   * Live WS tickets, `#private` for the same reason the traffic keys are.
   *
   * A ticket is a credential by §10's own reasoning — single-use, 30 seconds,
   * and the thing that authorises a socket upgrade — and this table rendered in
   * full under `inspect(registry, { customInspect: false, showHidden: true })`:
   * every live ticket in the process, in one call, from the object a
   * diagnostics dump is most likely to reach for.
   */
  readonly #tickets = new Map<string, { ctxId: string; expiresAt: number }>();

  constructor() {
    // Inspecting the registry used to print every live context's traffic keys
    // in ONE call — the widest version of the same leak, and the reason this is
    // redacted at the container as well as at the leaves.
    redactKeyMaterial(
      this,
      () =>
        `E2eeContextRegistry { contexts: ${this.#contexts.size}, devices: ${this.#byDevice.size}, tickets: ${this.#tickets.size} }`,
    );
  }

  /** Live contexts. For tests and for a future diagnostics line — never a key. */
  get size(): number {
    return this.#contexts.size;
  }

  /** Unconsumed, unexpired tickets. Tests only. */
  get ticketCount(): number {
    return this.#tickets.size;
  }

  open(args: {
    deviceId: string;
    kind: ContextKind;
    ctxIdRaw: Buffer;
    ctxId: string;
    keys: TrafficKeys;
    now?: number;
  }): E2eeContext {
    // Off the ARGUMENT: a polluted `Object.prototype.now` in the past makes
    // every provisional context outlive the 30 s TTL that is §8's whole bound.
    const now = own(args, "now") ?? Date.now();
    // Sweep this device's dead contexts FIRST, and the ticket table with them.
    //
    // Nothing else collects them. `get()` prunes only the one `ctxId` it was
    // asked for, so a context nobody ever looks up — which is exactly what a
    // replayed msg1 produces, since the attacker cannot read msg2 and so never
    // presents the ticket — stayed in both maps for good. The cap `retire()`d
    // the older ones and they lingered anyway: memory growing without ceiling,
    // defeating the very bound §8 wrote the provisional TTL to provide.
    this.sweepDevice(args.deviceId, now);
    this.sweepTickets(now);

    // §8: cap per device, and **the context being opened is never an eviction
    // candidate**. It is provisional by definition, so a naive "provisional
    // first" ordering sorted it to the front of its own queue and the open
    // evicted itself: a device holding four live sockets got a fifth that died
    // at the drain deadline and could never open a usable one — consuming the
    // ticket could not save it, because `deadline()` is
    // `min(expiresAt, retireAt)`. The candidates are therefore computed from
    // the OTHER live contexts, before the new one is inserted.
    //
    // A re-open storm after a restart, or a foreground racing a silence-timer
    // reconnect, both legitimately produce a second context — the newer wins
    // and the older is retired here rather than accumulating. Not a
    // replace-on-open: two sockets briefly overlapping during a reconnect is
    // ordinary, and destroying the live one would turn a reconnect into a
    // failure of the connection it was replacing.
    //
    // **Eviction is by usefulness, not by age.** Sorting on `createdAt` alone
    // picks the context that has been serving traffic all session and keeps two
    // opened a second ago and never used — precisely inverted in the case that
    // matters, a replay storm. Provisional (never authenticated) goes first;
    // only then the oldest live one.
    //
    // And it honours the drain: the victim is marked for deletion at
    // `now + CONTEXT_DRAIN_MS` rather than destroyed under a request already in
    // flight on it. A draining context no longer counts against the cap, so the
    // cap bounds *live* contexts and the overhang is bounded by the drain.
    const cap = args.kind === "ws" ? MAX_WS_CONTEXTS_PER_DEVICE : MAX_REST_CONTEXTS_PER_DEVICE;
    const candidates = (this.forDevice(args.deviceId) as Context[])
      .filter((c) => c.kind === args.kind && c.retireAt === null)
      .sort((a, b) => {
        if (a.provisional !== b.provisional) return a.provisional ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
    // `+ 1` is the context about to be inserted: it counts against the cap, and
    // is not in the list it could be evicted from.
    for (const evicted of candidates.slice(0, Math.max(0, candidates.length + 1 - cap))) {
      evicted.retire(now + CONTEXT_DRAIN_MS);
    }

    const context = new Context({
      ctxIdRaw: args.ctxIdRaw,
      ctxId: args.ctxId,
      deviceId: args.deviceId,
      kind: args.kind,
      keys: args.keys,
      now,
    });
    this.#contexts.set(context.ctxId, context);
    let ids = this.#byDevice.get(args.deviceId);
    if (!ids) {
      ids = new Set();
      this.#byDevice.set(args.deviceId, ids);
    }
    ids.add(context.ctxId);
    return context;
  }

  /**
   * Resolve a `ctxId`, or `null` for one that is unknown, expired, or lost to a
   * restart — all three of which the caller reports as `E2EE_CTX_UNKNOWN`,
   * because all three are recoverable by one transparent re-handshake and none
   * of them is a revocation the client must surface (§9).
   *
   * The map lookup IS the first thing that runs, and nothing is allocated on
   * the way to a rejection (§10). This is called before authentication, on a
   * value an attacker chose.
   */
  get(ctxId: string, now: number = Date.now()): E2eeContext | null {
    const context = this.#contexts.get(ctxId);
    if (!context) return null;
    if (now >= context.deadline()) {
      this.destroy(ctxId);
      return null;
    }
    return context;
  }

  /** Every live context for a device. */
  forDevice(deviceId: string): E2eeContext[] {
    const ids = this.#byDevice.get(deviceId);
    if (!ids) return [];
    const out: E2eeContext[] = [];
    for (const id of ids) {
      const context = this.#contexts.get(id);
      if (context) out.push(context);
    }
    return out;
  }

  /**
   * Destroy one context and any ticket bound to it.
   *
   * The socket's close calls this for its own context and NOTHING else: a
   * device's REST context is unaffected by its socket going away, which is the
   * whole reason there are two (§8).
   */
  destroy(ctxId: string): boolean {
    // Tickets go FIRST and unconditionally. `/api/e2ee/open` issues a ticket
    // before it can register the context — the traffic keys do not exist until
    // msg2 has been written — so its failure path calls this for a `ctxId` the
    // map has never seen. Returning early there would leave a live ticket
    // bound to a context that will never exist, which is precisely what that
    // call site calls this to prevent.
    for (const [ticket, entry] of this.#tickets) {
      if (entry.ctxId === ctxId) this.#tickets.delete(ticket);
    }
    const context = this.#contexts.get(ctxId);
    if (!context) return false;
    invalidateContext(context);
    this.#contexts.delete(ctxId);
    this.#byDevice.get(context.deviceId)?.delete(ctxId);
    return true;
  }

  /**
   * Release one exact context owner without deleting a replacement that reused
   * the same identifier.
   */
  destroyOwned(context: E2eeContext): boolean {
    if (this.#contexts.get(context.ctxId) !== context) {
      invalidateContext(context);
      return false;
    }
    return this.destroy(context.ctxId);
  }

  /**
   * Destroy every context for a device and report what the caller must finish.
   *
   * `POST /api/devices/:id/revoke` calls this before the socket owner closes
   * every hub reference for the device (design.md §4.4, point 3). The returned
   * ids are accounting, not the close list: a drained context can already be
   * absent here while its socket is still attached to the hub.
   */
  destroyDevice(deviceId: string): DestroyedContexts {
    const out: DestroyedContexts = { socketCtxIds: [], restCtxIds: [], tickets: 0 };
    for (const context of this.forDevice(deviceId)) {
      out.tickets += this.ticketsFor(context.ctxId);
      if (this.destroy(context.ctxId)) {
        (context.kind === "ws" ? out.socketCtxIds : out.restCtxIds).push(context.ctxId);
      }
    }
    this.#byDevice.delete(deviceId);
    return out;
  }

  /**
   * Mint a single-use, 30-second WS ticket bound to a `ctxId`.
   *
   * Issued INSIDE the encrypted msg2 payload, so the long-term credential never
   * appears in a URL again — and §10 asks the client to carry it in a WebSocket
   * header rather than a query parameter, because a URL lands in every ingress
   * access log.
   *
   * Deliberately independent of whether the context is registered yet:
   * `/api/e2ee/open` has to name the ticket in the payload it is about to seal,
   * and the traffic keys the context needs only exist once that message has
   * been written. A ticket whose context never materialised resolves to a
   * `ctxId` the registry does not know, which is the ordinary
   * `E2EE_CTX_UNKNOWN` path.
   */
  issueTicket(ctxId: string, now: number = Date.now()): string {
    this.sweepTickets(now);
    // 16 bytes → exactly 22 base64url characters, the §12 encoding.
    const ticket = randomBytes(16).toString("base64url");
    this.#tickets.set(ticket, { ctxId, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  }

  /**
   * Spend a ticket. Returns its `ctxId` exactly once; every later call — and
   * every concurrent one, since this is synchronous and Node runs it to
   * completion — gets `null`.
   *
   * Consuming a ticket IS the socket context's first authenticated use, so it
   * promotes the context out of provisional (§8).
   */
  consumeTicket(ticket: string, now: number = Date.now()): string | null {
    const entry = this.#tickets.get(ticket);
    if (!entry) return null;
    // Deleted whether or not it was still valid: a presented ticket is spent.
    this.#tickets.delete(ticket);
    if (now >= entry.expiresAt) return null;
    this.#contexts.get(entry.ctxId)?.markUsed(now);
    return entry.ctxId;
  }

  /** Drop everything. A streamer restart does this by existing; tests need a call. */
  clear(): void {
    for (const context of this.#contexts.values()) invalidateContext(context);
    this.#contexts.clear();
    this.#byDevice.clear();
    this.#tickets.clear();
  }

  private ticketsFor(ctxId: string): number {
    let n = 0;
    for (const entry of this.#tickets.values()) if (entry.ctxId === ctxId) n++;
    return n;
  }

  /** Drop every context of one device whose deadline has passed. */
  private sweepDevice(deviceId: string, now: number): void {
    for (const context of this.forDevice(deviceId)) {
      if (now >= context.deadline()) this.destroy(context.ctxId);
    }
  }

  private sweepTickets(now: number): void {
    for (const [ticket, entry] of this.#tickets) {
      if (now >= entry.expiresAt) this.#tickets.delete(ticket);
    }
  }
}

// One registry per process. `/api/e2ee/open` writes to it; the WebSocket
// upgrade and the REST middleware (both later PRs) read from it. It is a module
// singleton rather than an `ApiDeps` field because contexts are process-local
// by definition and threading it through the server wiring would put a
// non-serialisable, restart-scoped object into the dependency record for no
// gain — the route factory takes an override so a test uses its own.
let shared: E2eeContextRegistry | null = null;

export function contextRegistry(): E2eeContextRegistry {
  if (!shared) shared = new E2eeContextRegistry();
  return shared;
}

export interface E2eeRequiredRefusal {
  status: 426;
  body: { error: string; code: "E2EE_REQUIRED" };
}

/**
 * The 426 answer, in ONE place.
 *
 * A device that has once paired encrypted is pinned (`e2ee_required`), and a
 * pinned device must never be served plaintext: it gets `426`, never a `401`
 * and never a plaintext answer (design.md §6.3, §8). The WebSocket upgrade and
 * the REST unseal middleware are both later PRs and both consume this — neither
 * re-implements it, because two copies of a downgrade rule is one copy that can
 * be forgotten.
 *
 * Returns `null` when the request is fine: it was sealed, or the caller is not
 * a pinned device. An unpinned device and the legacy shared key keep working
 * exactly as they do today.
 *
 * **The limit, stated rather than discovered later.** The pin is per DEVICE, so
 * this can only enforce it against a caller that resolved to a device
 * principal. A pinned phone that presents the SHARED api key resolves to
 * `legacy` — indistinguishable from the owner's laptop — and is let through
 * here. Closing that is the WebSocket upgrade's job, where `?key=` and a ticket
 * are separable, and the REST middleware's, where a pinned device has an
 * `X-TB-Ctx` to be absent.
 */
export function refuseUnsealedIfPinned(args: {
  principal: Principal | null | undefined;
  /** Just the lookup — the caller already holds the repository. */
  devicesRepo: { get(deviceId: string): DeviceRow | null } | null | undefined;
  /** The context this request resolved to; `null` means the request was plaintext. */
  context: E2eeContext | null | undefined;
}): E2eeRequiredRefusal | null {
  if (args.context) return null;

  const deviceId = args.principal?.kind === "device" ? args.principal.deviceId : undefined;
  if (!deviceId) return null;

  // **Fail closed from here down.** This used to end in `row?.e2ee_required !== 1`
  // over `devicesRepo?.get(id) ?? null`, which answered "serve it in the clear"
  // for a null repository, a missing row, and every value other than the exact
  // number 1 — `true`, `"1"`, `undefined`. A pinned device got plaintext in all
  // of them, from the one guard two other tracks consume for exactly this
  // decision. A downgrade guard that defaults to allowing the downgrade is not
  // a guard.
  //
  // So: unpinned is a POSITIVE answer that the store must give. Anything else —
  // no store, an unreadable store, no row, a value that is not the number 0 —
  // is a refusal.
  let row: DeviceRow | null;
  try {
    row = args.devicesRepo?.get(deviceId) ?? null;
  } catch {
    // An unreadable registry cannot prove this device is unpinned.
    return refusal();
  }
  if (!args.devicesRepo || !row) return refusal();
  // `Object.hasOwn`, then the value. Reading `row.e2ee_required` bare is a
  // prototype-chain read — the last one left in `src/e2ee/*`, and it is in the
  // downgrade guard: `Object.prototype.e2ee_required = 0` would answer "unpinned"
  // for every device whose row does not carry the column. Absent still refuses.
  if (!Object.hasOwn(row, "e2ee_required")) return refusal();
  return row.e2ee_required === 0 ? null : refusal();
}

function refusal(): E2eeRequiredRefusal {
  return {
    status: 426,
    body: {
      error:
        "This device is paired for end-to-end encryption and cannot be served in the clear. " +
        "Open an encrypted context with POST /api/e2ee/open and retry.",
      code: "E2EE_REQUIRED",
    },
  };
}

/**
 * What a caller needs from `devicesRepo` to authenticate a context.
 *
 * Structural, not the concrete repository: the two callers hold it through
 * different dependency records, and a narrow shape is also what lets a test
 * drive the refusals without a database.
 */
export interface DeviceLookup {
  get(deviceId: string): DeviceRow | null;
  authenticate(credential: string): DeviceRow | null;
}

/**
 * A `Principal` with its `deviceId` present.
 *
 * `Principal.deviceId` is optional, because a `legacy` principal has none. A
 * context always names a device, so this is the honest return type — and it is
 * what lets a caller read `principal.deviceId` without a cast or a `?.`, which
 * matters because that field is the one the invariant is stated over.
 */
export type DevicePrincipal = Principal & { kind: "device"; deviceId: string };

/**
 * The verdict `authenticateContext` returns. **Frozen at W1b's merge**: the
 * REST unseal middleware is built against this exact text, so a variant renamed
 * here is a coordinated change in two tracks, not a refactor.
 *
 * A failure carries a `reason` and nothing else — no status, no body, no
 * message. The two callers answer the same verdict differently: REST maps it to
 * an HTTP status, the WebSocket upgrade maps it to a close reason. Putting HTTP
 * policy inside a two-consumer helper is how one caller's answer silently
 * becomes the other's.
 *
 * The reasons, and what each one covers — stated because each is a fail-open
 * path a consumer cannot close from its own side once this freezes:
 *
 * - **`device-revoked`** — the context names a device whose row is **missing**
 *   OR whose `revoked_at` is set. §10: absent is not the same as invalid, and
 *   neither is success. Do not read "revoked" narrowly and add a row-not-found
 *   success path; a context whose device has vanished authenticates nobody.
 * - **`credential-mismatch`** — a credential was presented beside the context
 *   and does not name the context's device. **Including one that names NO
 *   device**: the shared API key is a mismatch, not an exemption. "Names
 *   another device" read literally would exclude the case that matters most.
 * - **`no-device-store`** — there is no device registry, or reading it threw.
 *   A refusal, never a success: *a downgrade guard that defaults to allowing
 *   the downgrade is not a guard.*
 *
 *   **Its own arm, deliberately, and not folded into `device-revoked`.** The
 *   two are not the same fact: "this device is revoked" is a statement about
 *   the DEVICE, and "I could not consult the store" is a statement about US.
 *   Collapsing them tells the caller — and every log built from the caller —
 *   that a device was revoked when what actually happened is that our own
 *   storage was unreadable. That is precisely the defect §9 split
 *   `E2EE_SEAL_FAILED` from `E2EE_SEQUENCE_VIOLATION` to prevent: a
 *   server-side fault reported as a claim about the peer. Both arms still
 *   refuse and both are terminal, so nothing about behaviour changes — only
 *   what the caller is told, which is the entire point.
 *
 * "No such context" is deliberately NOT a reason. Both callers resolve the
 * context before calling, so a not-found is theirs to answer — and taking the
 * resolved object also closes a race the `ctxId` shape had, where a context
 * could expire between the caller's own lookup and the helper's.
 */
export type E2eeContextAuth =
  | { ok: true; principal: DevicePrincipal }
  | { ok: false; reason: "device-revoked" | "credential-mismatch" | "no-device-store" };

/**
 * Turn a resolved context into the principal the request runs as — or refuse.
 *
 * **The tail every sealed entry point shares**, in one place because it has two
 * callers: the WebSocket upgrade resolves its context from a single-use
 * `X-TB-Ticket`, the REST unseal middleware resolves its from `X-TB-Ctx`, and
 * from that point on the decision is identical. Forking a copy is how the two
 * would come to disagree about which of them re-checks `revoked_at`.
 *
 * The property it exists to create, stated so a test can assert it:
 *
 * > **A context-attached connection's `principal.deviceId` always equals its
 * > `context.deviceId`**, and a credential presented beside a context must name
 * > that same device or the connection is refused.
 *
 * The principal is therefore built from the CONTEXT's own device row and never
 * from the credential — there is no path here on which the two can differ,
 * which is stronger than checking that they agree.
 *
 * Three refusals, all fail-closed:
 *
 *   - **no row, or `revoked_at` set** → `403 E2EE_DEVICE_REVOKED`. Re-checked
 *     per connection rather than trusted from the handshake: a device revoked
 *     between `/api/e2ee/open` and its next request holds a handle that is
 *     still valid on its face (§10). Absent and revoked are the same refusal
 *     and neither is success;
 *   - **a credential naming another device** → `401`. "Header device ≠ context
 *     device" must not be undefined behaviour at a trust boundary: two answers
 *     to "who is this" is not a request to resolve by preferring one;
 *   - **the SHARED api key beside a context** → `401` too. It names no device,
 *     so it is a mismatch rather than an exemption — the one reading of this
 *     rule that would otherwise let the stage-3 shared-key problem through a
 *     door that had just been closed.
 *
 * **This function has no side effects: it returns a verdict and never applies
 * one.** The rule its callers follow, which is the reason and not merely the
 * behaviour:
 *
 * > **Destroy a context only when the trigger is a fact in our own database
 * > that an attacker cannot forge — `revoked_at`. Never on a mismatched
 * > credential, which is an attacker-supplied header.**
 *
 * `X-TB-Ctx` carries the `ctxId` in a PLAINTEXT header on every sealed request,
 * so it is visible to exactly the on-path party this design assumes exists.
 * Destroying on a mismatch would let anyone who sees one request kill that
 * device's context over and over: forge a credential beside the observed id,
 * watch the victim re-open, read the new id, repeat. The safeguard becomes the
 * weapon.
 *
 * The property has to hold at ANY placement on EITHER channel, so it is this
 * function's job not to destroy rather than each caller's job to remember. A
 * refusal reports its `reason`, and a caller destroys on `device-revoked` and
 * on nothing else.
 */
export function authenticateContext(args: {
  /** Already resolved by the caller — from a spent ticket, or from `X-TB-Ctx`. */
  context: E2eeContext;
  devicesRepo: DeviceLookup | null | undefined;
  /**
   * The credential presented beside the context, if any.
   *
   * `undefined` is the ORDINARY case and an ordinary success: §13(b) says a
   * sealed REST request carries no `Authorization` at all, and a ticketed
   * upgrade carries none either. The mismatch check is conditional on a
   * credential being present; its absence is never a special case.
   */
  presented: string | undefined;
}): E2eeContextAuth {
  // Never throws out of here. A store that is missing, or that throws on read,
  // cannot prove this device is live, and "could not check" must not resolve to
  // "let it through" — the same rule `refuseUnsealedIfPinned` learned.
  if (!args.devicesRepo) return { ok: false, reason: "no-device-store" };

  // **Every read of the store is inside this `try`, including the reads OF the
  // row it returns.** `DeviceLookup` is a structural contract another
  // repository implements, so a conforming-but-hostile lookup is the ordinary
  // case to survive, not an exotic one: a row whose `revoked_at` is an accessor
  // that throws puts the throw at the property read, not at the call. A `try`
  // around only `get()` leaves that read bare, and "never throws" then holds
  // against the store we happen to have rather than against the contract we
  // published.
  let live: { deviceId: string; capabilities: string } | null;
  try {
    const row: DeviceRow | null = args.devicesRepo.get(args.context.deviceId) ?? null;
    // Absent and revoked are the same refusal, and neither is success (§10).
    // `Object.hasOwn` before the value, like its sibling: a row that does not
    // carry the column must not read as live through a prototype-chain hit.
    // Both the `hasOwn` and the value read are inside the `try`.
    live =
      !row || !Object.hasOwn(row, "revoked_at") || row.revoked_at != null
        ? null
        : { deviceId: row.device_id, capabilities: row.capabilities };
  } catch {
    return { ok: false, reason: "no-device-store" };
  }
  if (!live) return { ok: false, reason: "device-revoked" };

  if (args.presented !== undefined) {
    let namedDeviceId: string | undefined;
    try {
      namedDeviceId = args.devicesRepo.authenticate(args.presented)?.device_id;
    } catch {
      return { ok: false, reason: "no-device-store" };
    }
    // The credential must name the CONTEXT's device. Compared against the
    // context and not against the row, for the same reason the principal is
    // built from the context below.
    //
    // A credential naming NO device — the shared API key — lands here too. It
    // is a mismatch, not an exemption.
    if (namedDeviceId !== args.context.deviceId) {
      return { ok: false, reason: "credential-mismatch" };
    }
  }

  // **The invariant: `principal.deviceId === context.deviceId`, by
  // CONSTRUCTION.**
  //
  // The id comes from the context itself, never from the row and never from the
  // credential. §13 claims "there is no path on which the two can differ, which
  // is stronger than checking that they agree" — and while this read
  // `row.device_id` that claim was only true as long as
  // `get(id).device_id === id`, which is a property of whichever store is
  // plugged in rather than of this function. A conforming `DeviceLookup` that
  // returns a row for a different device was enough to break it. The row is
  // still what proves the device is live and still supplies the capabilities;
  // it just does not get to name who this is.
  return {
    ok: true,
    principal: {
      kind: "device",
      deviceId: args.context.deviceId,
      capabilities: parseCapabilities(live.capabilities),
    },
  };
}
