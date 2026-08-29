// The record layer: one sealed frame in, one plaintext out.
//
// Written against specs/end-to-end-encryption/NONCE-DESIGN.md, which is the
// design of record and outranks design.md wherever the two disagree. Every rule
// below names the section it comes from, because "why is it done this way" must
// be answerable without re-deriving the protocol.
//
// Four things this file deliberately does NOT do (NONCE-DESIGN §14):
//
//   - it does not reuse `chachaNonce` from noise.ts. That is Noise's own nonce
//     encoding (4 zero bytes then a LITTLE-endian counter, spec §12.3); this
//     layer's is `direction(4) || counter(8)` BIG-endian. Two layers, two
//     encodings, both correct for their own specification;
//   - it does not build on `CipherState`. That object's `n` belongs to the
//     handshake and is reset by every `MixKey`; the record layer owns a counter
//     that is never reset for any reason;
//   - it takes no counter from a caller. `seal(plaintext)` and `unseal(frame)`
//     are the only two ways the counter moves, so there is exactly one place
//     the invariant can be broken instead of one per call site (§5 R4). The one
//     sanctioned exception is `RestResponseSealer`, below, whose "counter" is
//     an echo of a request that was already accepted rather than a sequence
//     the sender chooses;
//   - it has no `rekey()`. A key is never replaced inside a context: a new key
//     is a new context (§6). The invariant that buys is one sentence — *one
//     counter value, once, per direction, per context* — with no epoch field
//     and no key generation for a receiver to guess at.

import { createCipheriv, createDecipheriv, createHash, type KeyObject } from "crypto";
import {
  assertBytes,
  E2EE_CTX_UNKNOWN,
  E2EE_PROTOCOL_VERSION,
  E2EE_SEAL_FAILED,
  E2EE_SEQUENCE_VIOLATION,
  type E2eeRejectionCode,
  importSecret,
  isBytes,
  own,
  redactKeyMaterial,
  unpooled,
} from "./protocol";

/** Client → server. The value is the first 4 bytes of every c2s nonce. */
export const DIRECTION_C2S = 0x00000001;
/** Server → client. */
export const DIRECTION_S2C = 0x00000002;
export type Direction = typeof DIRECTION_C2S | typeof DIRECTION_S2C;

export const CHANNEL_WS = 0x01;
export const CHANNEL_REST_REQUEST = 0x02;
export const CHANNEL_REST_RESPONSE = 0x03;
export type Channel =
  | typeof CHANNEL_WS
  | typeof CHANNEL_REST_REQUEST
  | typeof CHANNEL_REST_RESPONSE;

export const KEY_BYTES = 32;
export const CTX_ID_BYTES = 16;
export const TAG_BYTES = 16;
export const NONCE_BYTES = 12;
/** `version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)` (§4). */
export const HEADER_BYTES = 1 + CTX_ID_BYTES + 4 + 8 + 1;
/** The REST AAD suffix: `sha256(method || "\n" || path || "\n" || query)` (§4). */
export const TARGET_HASH_BYTES = 32;

/**
 * The counter ceiling. A sender AT this value refuses rather than wrapping (§7).
 *
 * Unreachable in practice — at D-3's measured ~1.6 MB/s budget it is on the
 * order of 10^11 years — and asserted precisely so it can never become a silent
 * wrap. The cost of refusing at `2^64 - 1` rather than after it is one unused
 * counter value out of 2^64.
 *
 * The refusal leaves the state unchanged, so there is no recovery that keeps
 * the context: the caller destroys it and the client opens a new one (§7).
 */
export const MAX_COUNTER = 2n ** 64n - 1n;

/**
 * Ceiling on a frame, checked before anything is parsed or decrypted.
 *
 * NONCE-DESIGN does not name a number; this one is a size no legitimate frame
 * reaches (the largest thing the hub sends is a terminal replay, tens of KB)
 * while staying far enough above it that a bound is never the reason a real
 * message fails. Same shape as `NOISE_MAX_MESSAGE_BYTES`: bound first, allocate
 * second, never allocate in proportion to an attacker-supplied length (D-9).
 *
 * §10 is explicit that on the WebSocket this is a check AFTER allocation —
 * `@hono/node-ws` assembles the frame with `ws`'s 100 MiB default before any of
 * this runs — and that closing that gap is W1b's, with its own per-direction
 * ceilings. This constant is not that bound and must not be mistaken for it.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export class RecordError extends Error {
  readonly code: E2eeRejectionCode;

  constructor(code: E2eeRejectionCode, message: string) {
    super(message);
    this.name = "RecordError";
    this.code = code;
  }
}

/**
 * `direction(4) || counter(8)`, big-endian, and never random (§2).
 *
 * A counter makes nonce reuse an invariant a test asserts on rather than a
 * birthday bound argued about in review (D-2). Each direction has its own key
 * AND its own label, so a record can never be reflected back at its sender: the
 * reflected frame is decrypted with the wrong key *and* carries the wrong
 * direction in both its nonce and its AAD.
 */
export function recordNonce(direction: Direction, counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(direction, 0);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/**
 * The REST AAD suffix (§4): `sha256(method || "\n" || path || "\n" || query)`.
 *
 * Paths and query stay plaintext (D-7), so without this nothing in the AAD
 * binds *what a sealed body is for*: an on-path attacker re-points a sealed
 * `POST /api/sessions/A/input` at session B, the body authenticates, and the
 * server runs the user's own keystrokes against a different session. Same for
 * `/cancel`, `/stop`, `/permission/answer` and `prune_all`.
 *
 * It is computed by both sides from the request line and never transmitted, so
 * the wire header stays 30 bytes.
 *
 * `query` is the raw query string WITHOUT the leading `?`, empty when there is
 * none — the two sides must agree on that spelling exactly or every sealed
 * request fails to authenticate with no other diagnostic.
 */
export function restTargetHash(method: string, path: string, query: string): Buffer {
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n${query}`, "utf-8")
    .digest();
}

/**
 * The target hash for a request, taken from the RAW wire request-target.
 *
 * **This is the `ctxId`-encoding trap one layer down** (§4), so the inputs are
 * pinned rather than described: an implementation that normalises anything here
 * rejects a legitimate request with `E2EE_SEAL_FAILED` and nothing else to
 * debug it.
 *
 *   method  upper-case ASCII, as sent
 *   path    the raw request-target path — percent-encoding PRESERVED, never
 *           decoded, never normalised. `/api/conversations/a%2Fb` and
 *           `/api/conversations/a/b` are different targets and hash differently
 *   query   the raw substring after `?`, verbatim: original parameter order,
 *           original `+` vs `%20`, duplicates kept, nothing sorted or
 *           re-serialised. The empty string when there is no `?`
 *
 * The server MUST read this from `c.env.incoming.url` — the bytes Node received
 * — and NEVER from Hono's `c.req.path`, which is percent-decoded, nor from a
 * re-serialised `URLSearchParams`, whose ordering and escaping do not round
 * trip.
 *
 * **The client hashes the ORIGIN-FORM target, not the absolute URL it fetches.**
 * That is `/api/sessions?limit=50`, never `https://host/api/sessions?limit=50`:
 * scheme, host and port are not in the hash. A client that passes the URL it is
 * about to fetch produces a different digest for every request, and each one
 * fails with `E2EE_SEAL_FAILED` and nothing else to debug — the precise trap §4
 * exists to prevent, reintroduced by a sentence. The fixture pins it:
 * `restTargetCanonicalization.hashInputUtf8` in
 * `__tests__/fixtures/e2ee-record-vectors.json` begins with the method and a
 * bare `/`.
 */
export function restTargetHashFromUrl(method: string, rawUrl: string): Buffer {
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? "" : rawUrl.slice(q + 1);
  return restTargetHash(method, path, query);
}

export interface RecordHeader {
  version: number;
  /**
   * Any byte view, not only a `Buffer`. A `@stablelib`-based client hands over
   * plain `Uint8Array`s and §13 has it calling this builder directly.
   */
  ctxId: Uint8Array;
  direction: Direction;
  counter: bigint;
  channel: Channel;
}

/**
 * The AAD: the 30-byte plaintext header, plus the 32-byte target hash on the
 * REST channels (§4).
 *
 * The header travels in the clear and is authenticated, so an intermediary can
 * neither rewrite a sequence number nor re-point a record at another context.
 *
 * Exported because the interop fixtures publish it and a client implementation
 * has to reproduce it byte for byte.
 */
export function recordHeader(header: RecordHeader): Buffer {
  assertBytes(header.ctxId, CTX_ID_BYTES, "ctxId", (m) => new RecordError(E2EE_SEAL_FAILED, m));
  const wire = Buffer.alloc(HEADER_BYTES);
  wire.writeUInt8(header.version, 0);
  // `.set`, not `.copy`: `copy` is Buffer-only, so a correct-length plain
  // `Uint8Array` — exactly what the client track produces — threw
  // `TypeError: target.copy is not a function` AFTER passing the guard. Right
  // input, wrong crash, outside §9's taxonomy.
  wire.set(header.ctxId, 1);
  wire.writeUInt32BE(header.direction, 17);
  wire.writeBigUInt64BE(header.counter, 21);
  wire.writeUInt8(header.channel, 29);
  return wire;
}

/**
 * The AAD: the 30-byte header, plus the 32-byte target hash on the REST
 * channels (§4).
 *
 * **This function enforces the target rule itself.** The client track consumes
 * the AAD BUILDER, not the wrapper one layer up, so a rule checked only in
 * `assertTarget` is a rule that implementation never receives — and a forgotten
 * target then yields a silently unbound AAD on the two channels that exist to
 * bind one. `recordHeader` above is the wire bytes and carries no such rule,
 * because a header is not an AAD.
 */
export function recordAad(header: RecordHeader, target?: Uint8Array): Buffer {
  validateTarget(header.channel, target);
  const wire = recordHeader(header);
  if (!target) return wire;
  const aad = Buffer.alloc(HEADER_BYTES + TARGET_HASH_BYTES);
  aad.set(wire, 0);
  aad.set(target, HEADER_BYTES);
  return aad;
}

/**
 * A target is required, and exactly 32 bytes, on the REST channels; forbidden
 * on the socket.
 *
 * Byte LENGTH, not `.length`: `new Float64Array(32)` has `.length === 32` and
 * 256 bytes behind it, and a 32-character string has neither. `isBytes` is the
 * one place that distinction lives (§11).
 */
function validateTarget(channel: Channel, target: Uint8Array | undefined): void {
  if (!channelBindsTarget(channel)) {
    if (target !== undefined) {
      throw new RecordError(E2EE_SEAL_FAILED, `channel ${channel} takes no request target`);
    }
    return;
  }
  if (!isBytes(target, TARGET_HASH_BYTES)) {
    throw new RecordError(
      E2EE_SEAL_FAILED,
      `channel ${channel} requires a ${TARGET_HASH_BYTES}-byte request target`,
    );
  }
}

/** Whether a channel's records bind a request target (§4). */
export function channelBindsTarget(channel: Channel): boolean {
  return channel === CHANNEL_REST_REQUEST || channel === CHANNEL_REST_RESPONSE;
}

/**
 * A target is required on REST and forbidden on the socket.
 *
 * Both directions of the mistake are refused rather than defaulted: a missing
 * target on REST would silently unbind the request line the suffix exists to
 * bind, and a target on the socket would be a value the peer has no way to
 * reproduce.
 */
function assertTarget(channel: Channel, target: Uint8Array | undefined): void {
  // A thin wrapper over the builder's own rule, kept only so a refusal happens
  // BEFORE any state moves — the response sealer spends an acceptance it can
  // never re-arm, so a check that fires deep inside `recordAad` would fire too
  // late. Same function, so the two can never disagree.
  validateTarget(channel, target);
}

export interface RecordStateOptions {
  /** 32-byte traffic key for THIS direction, or one already imported. */
  key: Buffer | KeyObject;
  /** The context handle, raw 16 bytes. */
  ctxId: Buffer;
  direction: Direction;
  channel: Channel;
  /**
   * INTERNAL — tests only. A construction-time counter seed, and the one narrow
   * exception NONCE-DESIGN §5 R4 states explicitly: the §7 exhaustion test has
   * to place a counter near `2^64 - 1`, which it cannot do a frame at a time.
   *
   * This is not the forbidden shape. The seed sets a starting point ONCE, at
   * construction; `seal` and `unseal` still take no counter and remain the sole
   * advancers. A `seal(counter, …)` signature stays forbidden.
   */
  initialCounter?: bigint;
}

/**
 * One direction of one channel of one context: a key, a label, and the counter
 * that belongs to them.
 *
 * A state both seals and unseals with its single counter, because a state is
 * one direction — the sending side calls `seal`, the receiving side calls
 * `unseal`, and neither ever calls the other. Two states per channel, built by
 * `context.ts`, is what keeps the two counters independent.
 */
export class RecordState {
  /** `#private`: not a property, so no rendering mode can reach it. */
  /** OpenSSL-side, not a JS Buffer: there is nothing left on the heap to find. */
  readonly #k: KeyObject;
  /**
   * `#private`, because the counter is as sensitive as the key.
   *
   * It was TypeScript-`private`, i.e. an ordinary property at runtime, so
   * `(state as any).n = 0n` performed the counter reset §14 forbids — and this
   * ships as an untyped artefact, where `as any` is just how you write it. We
   * moved the key material and stopped; the state that makes a nonce unique
   * never moved.
   */
  #n: bigint;
  /**
   * Public by design — the AAD binds it and callers read it.
   *
   * UNPOOLED, therefore. A pooled public Buffer hands out a window onto the
   * shared 8 KiB allocation its neighbours live in, which is how a registry
   * walk reached live key bytes without touching a key-bearing class at all.
   */
  readonly ctxId: Buffer;
  readonly direction: Direction;
  readonly channel: Channel;

  constructor(options: RecordStateOptions) {
    const fail = (m: string) => new RecordError(E2EE_SEAL_FAILED, m);
    assertBytes(options.ctxId, CTX_ID_BYTES, "ctxId", fail);
    this.#k = toSecret(options.key, fail);
    redactKeyMaterial(
      this,
      () =>
        `RecordState { channel: ${this.channel}, direction: ${this.direction}, counter: ${this.#n}, key: <#private> }`,
    );
    this.ctxId = unpooled(options.ctxId);
    this.direction = options.direction;
    this.channel = options.channel;
    this.#n = own(options, "initialCounter") ?? 0n;
  }

  /** The next counter this state will use. Read-only: nothing outside sets it. */
  get counter(): bigint {
    return this.#n;
  }

  /**
   * Seal one record. The counter advances by exactly 1 AFTER success, never
   * before (§5 R1).
   *
   * Returns `header(30) || ciphertext || tag(16)`.
   */
  seal(plaintext: Buffer, target?: Buffer): Buffer {
    assertTarget(this.channel, target);
    // Refuse rather than wrap (§7). Checked before the header is built, so a
    // refusal costs nothing and leaves the state exactly as it was — which is
    // what lets the caller destroy the context rather than repair it.
    if (this.#n >= MAX_COUNTER) {
      throw new RecordError(
        E2EE_SEAL_FAILED,
        "record counter exhausted; refusing to send rather than reuse a nonce",
      );
    }
    const frame = sealWith(
      this.#k,
      this.ctxId,
      this.direction,
      this.channel,
      this.#n,
      plaintext,
      target,
    );
    this.#n += 1n;
    return frame;
  }

  /**
   * Unseal one record, or throw.
   *
   * **Authenticate first, then compare the counter (§5 R2 ordering).** The
   * nonce is built from the header either way, so the AEAD can run before the
   * sequence check — and it must. Checking the counter first would make
   * `E2EE_SEQUENCE_VIOLATION` an *unauthenticated verdict about the peer*:
   * anyone who can inject a frame reads `ctxId` from a previous plaintext
   * header, sends garbage with a wrong counter, and the server logs a sequence
   * violation naming a device that did nothing and closes its socket. It buys
   * no DoS protection either — the same attacker can as cheaply send a frame
   * with the *right* counter, which is authenticated anyway.
   *
   * Strict once authenticated: `counter == expected` exactly, no window (§5 R2).
   * A WebSocket runs over one TCP connection, so it is ordered and gap-free by
   * construction; a repeat, a gap or a reorder is a protocol violation.
   *
   * A rejected frame advances NOTHING (§5 R3).
   */
  unseal(frame: Buffer, target?: Buffer): Buffer {
    const { plaintext, counter } = this.openFrame(frame, target);

    // Only now — the frame is proven to come from the peer, so a sequence
    // violation is a true claim about the peer rather than about an injector.
    if (counter !== this.#n) {
      throw new RecordError(
        E2EE_SEQUENCE_VIOLATION,
        `record counter ${counter} is not the expected ${this.#n}`,
      );
    }
    this.#n += 1n;
    return plaintext;
  }

  /**
   * The AEAD step WITHOUT the sequence check — the sanctioned seam for the REST
   * sliding-window receiver (§13).
   *
   * `unseal` enforces strict `expected`, which is right for the socket and
   * wrong for a channel React Query drives concurrently. The REST track needs
   * the authenticated plaintext *and* the counter the frame claimed so its
   * 1024-bit window can decide acceptance. Exposing that here rather than
   * leaving it to be improvised is the whole point: the alternative is a second
   * implementation of nonce and AAD assembly in another module, which is
   * exactly how two implementations come to disagree.
   *
   * Three properties this deliberately keeps:
   *
   *   - it is the REST REQUEST channel only. On the socket a window is a
   *     protocol violation (§5 R2), and a seam that could relax it there would
   *     be a hole in the rule this layer exists to hold;
   *   - it advances NOTHING. The window owns acceptance and replay bookkeeping,
   *     so a state that advanced here would be two authorities on one counter;
   *   - every other check still runs — bounds, version, `ctxId`, direction,
   *     channel, the target hash and the tag. Only the sequence rule is the
   *     caller's.
   *
   * The caller must therefore still refuse a counter its window rejects, and
   * must never seal a response for one (§13(a)).
   */
  unsealUnchecked(frame: Buffer, target: Buffer): { plaintext: Buffer; counter: bigint } {
    if (this.channel !== CHANNEL_REST_REQUEST) {
      throw new RecordError(
        E2EE_SEAL_FAILED,
        "unsealUnchecked is the REST request channel's seam; the socket's counter is strict",
      );
    }
    return this.openFrame(frame, target);
  }

  /**
   * Everything both receive paths share: bounds, header checks, and the AEAD.
   *
   * One parser, two policies. The sequence rule is the only thing that differs
   * between the socket and REST, so it is the only thing left to the callers —
   * a second copy of the header checks is how the two channels would drift into
   * disagreeing about what a frame even is.
   */
  private openFrame(frame: Buffer, target?: Buffer): { plaintext: Buffer; counter: bigint } {
    assertTarget(this.channel, target);
    // Bounds first, on the length of the buffer we were handed — nothing is
    // parsed until the frame could plausibly be one (D-9).
    // `byteLength`, not `.length` — the units this module insists on everywhere
    // else. For a `Buffer` they agree; for any other byte view handed to a
    // public entry point they need not, and this is the D-9 bound.
    if (frame.byteLength < HEADER_BYTES + TAG_BYTES) {
      throw new RecordError(E2EE_SEAL_FAILED, "record shorter than its header and tag");
    }
    if (frame.byteLength > MAX_RECORD_BYTES) {
      throw new RecordError(E2EE_SEAL_FAILED, "record too large");
    }

    const header = frame.subarray(0, HEADER_BYTES);
    const version = header.readUInt8(0);
    if (version !== E2EE_PROTOCOL_VERSION) {
      throw new RecordError(E2EE_SEAL_FAILED, `unsupported record version ${version}`);
    }
    // The context check stays FIRST, before the AEAD and before any allocation:
    // a frame addressed elsewhere is the cheapest possible rejection and must
    // not cost a ChaCha20 pass over an attacker-sized buffer (§10). It is
    // observable from outside as the CODE — `E2EE_CTX_UNKNOWN`, not
    // `E2EE_SEAL_FAILED`, which is what a check placed after the AEAD would
    // produce. §9: the log line for this says *misaddressed*, not "unknown" —
    // the frame names a context, just not this one.
    if (!header.subarray(1, 1 + CTX_ID_BYTES).equals(this.ctxId)) {
      throw new RecordError(E2EE_CTX_UNKNOWN, "record is addressed to another context");
    }
    if (header.readUInt32BE(17) !== this.direction) {
      throw new RecordError(E2EE_SEAL_FAILED, "record carries the wrong direction");
    }
    if (header.readUInt8(29) !== this.channel) {
      throw new RecordError(E2EE_SEAL_FAILED, "record carries the wrong channel");
    }

    const counter = header.readBigUInt64BE(21);
    return {
      plaintext: openWith(this.#k, this.direction, counter, frame, header, target),
      counter,
    };
  }
}

/**
 * Seals a REST response under the counter of the request it answers (§13(a)).
 *
 * **This is the one sanctioned `seal(counter, …)` shape** and §5 R4 says why it
 * is not the forbidden one: R4 governs *sequence* counters — a value the sender
 * chooses and advances — and a response echo is not one. The value is dictated
 * by a request that was already accepted, and this is a distinct class from
 * `RecordState`, so a caller cannot reach a sequence counter through it.
 *
 * Nonce uniqueness for `(k_s2c, 2‖counter)` rests entirely on the rule below:
 *
 * > **At most one sealed response per accepted request counter.** A request
 * > rejected by the window or by the AEAD gets a PLAINTEXT error and never a
 * > sealed body — including through the framework's error path.
 *
 * So `accept()` is called only by a successful request unseal, and `seal()`
 * spends that acceptance. A response for a counter that was never accepted, or
 * a second response for one, is refused here rather than trusted to a caller.
 *
 * The alternative — a second sender counter for responses — was rejected: the
 * response would then not be bound to its request at all, and because the
 * client issues concurrent requests an on-path attacker could swap two in-flight
 * sealed responses within one context, both authenticating with fresh counters.
 */
export class RestResponseSealer {
  /** `#private`: not a property, so no rendering mode can reach it. */
  readonly #k: KeyObject;
  readonly #ctxId: Buffer;
  /** Counters accepted and not yet answered. Bounded by the window below. */
  readonly #outstanding = new Set<bigint>();
  /**
   * RFC-6479-style bitmap of counters already ANSWERED, over the last
   * `WINDOW_COUNTERS` positions ending at `acceptedHighWater`.
   *
   * This is the class's own memory of what it has done, and it is the whole
   * reason the nonce invariant holds here. Until it existed, `accept()` armed
   * unconditionally and `seal()` recorded nothing, so
   * `accept(7) → seal(7) → accept(7) → seal(7)` produced two records under
   * `(k_s2c, 2‖7)`: keystream reuse, demonstrated by an adversary as
   * `xor(c1, c2) === xor(p1, p2)`. What made it unreachable in practice was the
   * STRICT receive counter one layer up — precisely the code §13 schedules the
   * sliding window to replace. An invariant held by a layer scheduled for
   * replacement is not held.
   *
   * A bitmap rather than a capped Set for two reasons: it is bounded by
   * construction, so there is no overflow table to shed entries into a
   * non-recoverable dead end (the earlier `evicted` Set did exactly that); and
   * it is the shape the REST track needs for the receive window, so the two
   * halves of §13 agree instead of being invented twice.
   */
  readonly #answeredBits: Uint8Array;
  /** Highest counter ever accepted. `-1n` means "nothing yet". */
  /**
   * `#private` with the rest of the window state: an attacker who can write
   * `sealer.acceptedHighWater = -1n; sealer.answeredBits.fill(0)` re-arms every
   * answered counter, which is keystream reuse under `(k_s2c, 2‖counter)` —
   * the one failure this design exists to prevent, reached without touching a
   * key at all.
   */
  #acceptedHighWater = -1n;

  /**
   * How far behind the high-water mark a counter is still tracked.
   *
   * Well above any realistic concurrency, and the same width as the 1024-bit
   * REST receive window — deliberately, because a counter that window will
   * still accept must be one this can still answer.
   */
  static readonly WINDOW_COUNTERS = 1024;
  /** @deprecated Kept as the old name for one release; same number. */
  static readonly MAX_OUTSTANDING = RestResponseSealer.WINDOW_COUNTERS;

  constructor(options: { key: Buffer | KeyObject; ctxId: Buffer }) {
    const fail = (m: string) => new RecordError(E2EE_SEAL_FAILED, m);
    assertBytes(options.ctxId, CTX_ID_BYTES, "ctxId", fail);
    this.#k = toSecret(options.key, fail);
    this.#ctxId = unpooled(options.ctxId);
    this.#answeredBits = new Uint8Array(RestResponseSealer.WINDOW_COUNTERS / 8);
    redactKeyMaterial(
      this,
      () =>
        `RestResponseSealer { outstanding: ${this.#outstanding.size}, highWater: ${this.#acceptedHighWater}, key: <#private> }`,
    );
  }

  /**
   * Arm exactly one response for a request counter that was just accepted.
   *
   * A second acceptance of one counter is an upstream bug, and it must never
   * mint a second nonce: it is refused here rather than trusted to whatever
   * sits above.
   */
  accept(counter: bigint): void {
    if (this.#outstanding.has(counter)) {
      throw new RecordError(
        E2EE_SEAL_FAILED,
        "that request counter is already accepted and awaiting its one response",
      );
    }
    if (this.belowWindow(counter)) {
      // Cannot prove it was never answered, so it is refused — but as the
      // RECOVERABLE code: this is the saturation edge, and a dead end here is
      // the failure §13(a) forbids.
      throw new RecordError(
        E2EE_CTX_UNKNOWN,
        "that request counter is further behind than this context tracks; re-open and retry",
      );
    }
    if (this.isAnswered(counter)) {
      throw new RecordError(
        E2EE_SEAL_FAILED,
        "that request counter has already been answered; it can never be answered again",
      );
    }
    this.advanceTo(counter);
    this.#outstanding.add(counter);
  }

  /** Whether a response may still be sealed for this counter. */
  isOutstanding(counter: bigint): boolean {
    return this.#outstanding.has(counter);
  }

  seal(requestCounter: bigint, plaintext: Buffer, target: Buffer): Buffer {
    // The response channel binds its request target too (§4), and this class
    // never checked it: a caller could seal a REST response with no target or a
    // short one, and the binding was silently absent on the one path nothing
    // exercised — the path the REST middleware track will call. `target` is
    // non-optional in the signature AND checked at runtime, because a type is
    // not a check for a module another repository consumes.
    assertTarget(CHANNEL_REST_RESPONSE, target);
    if (!this.#outstanding.delete(requestCounter)) {
      if (this.belowWindow(requestCounter)) {
        throw new RecordError(
          E2EE_CTX_UNKNOWN,
          "that request counter is further behind than this context tracks; re-open and retry",
        );
      }
      if (this.isAnswered(requestCounter)) {
        throw new RecordError(
          E2EE_SEAL_FAILED,
          "that request counter has already been answered; sealing again would reuse a nonce",
        );
      }
      if (requestCounter <= this.#acceptedHighWater) {
        // Accepted at some point and no longer tracked: recoverable.
        throw new RecordError(
          E2EE_CTX_UNKNOWN,
          "no accepted request is waiting on that counter; re-open and retry",
        );
      }
      throw new RecordError(
        E2EE_SEAL_FAILED,
        "no accepted request is waiting on that counter; a rejected request gets a plaintext error",
      );
    }
    // Marked BEFORE the record exists, so no ordering leaves the counter
    // re-armable if `sealWith` throws.
    this.markAnswered(requestCounter);
    return sealWith(
      this.#k,
      this.#ctxId,
      DIRECTION_S2C,
      CHANNEL_REST_RESPONSE,
      requestCounter,
      plaintext,
      target,
    );
  }

  // ── the window ───────────────────────────────────────────────────
  //
  // Bits are indexed modulo the window width, so sliding forward must CLEAR the
  // positions the window newly covers or a wrapped index reads as a stale
  // "answered". Everything that falls out of the window is refused rather than
  // forgotten, which is what makes bounded memory safe here.

  private bit(counter: bigint): { index: number; mask: number } {
    const position = Number(counter % BigInt(RestResponseSealer.WINDOW_COUNTERS));
    return { index: position >> 3, mask: 1 << (position & 7) };
  }

  private belowWindow(counter: bigint): boolean {
    return (
      this.#acceptedHighWater >= 0n &&
      counter + BigInt(RestResponseSealer.WINDOW_COUNTERS) <= this.#acceptedHighWater
    );
  }

  /**
   * Whether this counter is recorded as answered.
   *
   * **Only meaningful at or below the high-water mark.** Bits are indexed
   * modulo the window width and are cleared as the window slides forward, so a
   * counter ABOVE the mark reads a bit belonging to a position the window has
   * not reached yet — 1024 counters ago, not this one. Reading it unguarded is
   * how the first draft of this class refused a perfectly fresh counter as
   * "already answered", which its own test caught.
   */
  private isAnswered(counter: bigint): boolean {
    if (counter > this.#acceptedHighWater || this.belowWindow(counter)) return false;
    const { index, mask } = this.bit(counter);
    return (this.#answeredBits[index] & mask) !== 0;
  }

  private markAnswered(counter: bigint): void {
    const { index, mask } = this.bit(counter);
    this.#answeredBits[index] |= mask;
  }

  private advanceTo(counter: bigint): void {
    if (counter <= this.#acceptedHighWater) return;
    const width = BigInt(RestResponseSealer.WINDOW_COUNTERS);
    if (this.#acceptedHighWater < 0n || counter - this.#acceptedHighWater >= width) {
      this.#answeredBits.fill(0);
    } else {
      for (let c = this.#acceptedHighWater + 1n; c <= counter; c++) {
        const { index, mask } = this.bit(c);
        this.#answeredBits[index] &= ~mask;
      }
    }
    this.#acceptedHighWater = counter;
    // Outstanding entries that fell out of the window are dropped, so this set
    // is bounded too. Dropping is safe because `accept` refuses to re-arm them
    // and `seal` answers them with the recoverable code.
    for (const pending of this.#outstanding) {
      if (this.belowWindow(pending)) this.#outstanding.delete(pending);
    }
  }
}

/**
 * Build a record state.
 *
 * The factory rather than the constructor is what callers use, so the
 * `initialCounter` seam stays visible as a named option in one place
 * (NONCE-DESIGN §5 R4) instead of spreading through `new RecordState(...)` call
 * sites.
 */
export function createRecordState(options: RecordStateOptions): RecordState {
  return new RecordState(options);
}

// ─── shared primitives ──────────────────────────────────────────────

/**
 * A traffic key as a `KeyObject`, from either a Buffer or an already-imported
 * key.
 *
 * Accepting a Buffer keeps every existing call site working while guaranteeing
 * that what the object STORES is never a JS Buffer: the caller's bytes are
 * copied, imported, and the copy wiped, so no key survives on the heap for a
 * pool walk to find.
 */
function toSecret(key: Buffer | KeyObject, fail: (m: string) => Error): KeyObject {
  if (typeof key === "object" && key !== null && !isBytes(key, KEY_BYTES)) {
    // An already-imported key, or a mistake. A secret KeyObject is accepted only
    // at the right WIDTH: `type === "secret"` is the presence-vs-length class
    // surviving in the one guard that does not route through `isBytes`, and a
    // 16-byte secret would otherwise be installed as a traffic key.
    const imported = key as KeyObject;
    if ("type" in key && imported.type === "secret") {
      if (imported.symmetricKeySize !== KEY_BYTES) {
        throw fail(`traffic key must be exactly ${KEY_BYTES} bytes`);
      }
      return imported;
    }
    throw fail(`traffic key must be exactly ${KEY_BYTES} bytes`);
  }
  assertBytes(key, KEY_BYTES, "traffic key", fail);
  return importSecret(key);
}

function sealWith(
  key: KeyObject,
  ctxId: Buffer,
  direction: Direction,
  channel: Channel,
  counter: bigint,
  plaintext: Buffer,
  target: Buffer | undefined,
): Buffer {
  const framing = { version: E2EE_PROTOCOL_VERSION, ctxId, direction, counter, channel };
  // The 30-byte plaintext header is what goes on the wire; the AAD is that plus
  // the 32-byte target hash on the REST channels. Both come from `recordAad`,
  // and the target is passed INTO it rather than concatenated beside it —
  // otherwise `recordAad`'s "target hash must be 32 bytes" check is unreachable
  // from every seal path, which is exactly how a short or absent target got
  // through on channel 0x03.
  const header = recordHeader(framing);
  const aad = recordAad(framing, target);
  const cipher = createCipheriv("chacha20-poly1305", key, recordNonce(direction, counter), {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const body = cipher.update(plaintext);
  const rest = cipher.final();
  const tag = cipher.getAuthTag();
  // Assembled UNPOOLED. `Buffer.concat` carves out of the shared pool, and a
  // frame is public: handing one out would hand out a window onto whatever the
  // pool holds next to it (§13).
  const frame = Buffer.allocUnsafeSlow(header.length + body.length + rest.length + tag.length);
  header.copy(frame, 0);
  body.copy(frame, header.length);
  rest.copy(frame, header.length + body.length);
  tag.copy(frame, header.length + body.length + rest.length);
  return frame;
}

function openWith(
  key: KeyObject,
  direction: Direction,
  counter: bigint,
  frame: Buffer,
  header: Buffer,
  target: Buffer | undefined,
): Buffer {
  const body = frame.subarray(HEADER_BYTES, frame.length - TAG_BYTES);
  const tag = frame.subarray(frame.length - TAG_BYTES);
  const decipher = createDecipheriv("chacha20-poly1305", key, recordNonce(direction, counter), {
    authTagLength: TAG_BYTES,
  });
  // The AAD is the header AS RECEIVED — that is what makes the header
  // authenticated rather than merely present — plus the target the receiver
  // computed from the request line it is actually serving. Built through
  // `recordAad` on both sides, so the 32-byte target check is reachable here
  // too rather than only on the seal path.
  decipher.setAAD(
    target
      ? recordAad(
          {
            version: header.readUInt8(0),
            ctxId: header.subarray(1, 1 + CTX_ID_BYTES),
            direction: header.readUInt32BE(17) as Direction,
            counter: header.readBigUInt64BE(21),
            channel: header.readUInt8(29) as Channel,
          },
          target,
        )
      : header,
    { plaintextLength: body.length },
  );
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Nothing advances. §5 R3.
    throw new RecordError(E2EE_SEAL_FAILED, "record failed authentication");
  }
}
