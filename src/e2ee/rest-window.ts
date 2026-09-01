// The REST request channel's replay window: an RFC-6479-style sliding bitmap
// over authenticated counters.
//
// Written against specs/end-to-end-encryption/NONCE-DESIGN.md §5, §9 and §13,
// and design.md §3.4. The two channels get genuinely different rules and this
// class is one half of that split:
//
//   - the WebSocket receiver stays STRICT — `counter == expected`, no window
//     (§5 R2). A window there would forfeit the property that makes replay
//     structurally impossible on the highest-volume channel, so nothing in this
//     file is reachable from `CHANNEL_WS`: `RecordState.unsealUnchecked`, the
//     only seam that hands a counter to this class, refuses every channel but
//     the REST request one;
//   - the REST receiver needs a window because HTTP requests are concurrent and
//     React Query issues them concurrently. A strict counter rejects a
//     perfectly legitimate out-of-order arrival (design.md §3.4).
//
// This class decides ACCEPTANCE and nothing else. It advances no counter, holds
// no key, and never sees a nonce, an AAD or a frame: it is handed a counter the
// AEAD has already authenticated, and answers "record it" or "throw". Ordering
// matters and is the caller's to get right — authenticate first, then decide
// (§5 R2 ordering) — because a pre-authentication counter check makes
// `E2EE_SEQUENCE_VIOLATION` an unauthenticated verdict about the peer and buys
// no protection at all.

import { E2EE_CTX_UNKNOWN, E2EE_SEQUENCE_VIOLATION } from "./protocol";
import { MAX_COUNTER, RecordError, RestResponseSealer } from "./record";

/**
 * The receive-side sliding window for one REST context's request channel.
 *
 * `admit(counter)` either returns — the counter is accepted and recorded — or
 * throws a `RecordError` carrying one of the two §9 codes that apply here:
 *
 *   - `E2EE_SEQUENCE_VIOLATION` for a counter this window can PROVE it has
 *     already seen, and for one outside the counter's own range. A claim about
 *     the peer, and true only because the frame was authenticated first;
 *   - `E2EE_CTX_UNKNOWN` for one that fell out of the window. It cannot be
 *     proven a replay — the bit that would say so has been reused by a counter
 *     1024 positions later — so it gets the RECOVERABLE code, which is what
 *     `RestResponseSealer.accept` already answers on its own below-window edge.
 *     A client that lags this far behind re-opens and retries rather than
 *     dead-ending.
 */
export class RestReceiveWindow {
  /**
   * The width, in counters. Deliberately the SAME width as the response
   * sealer's, and taken from it rather than repeated as a literal.
   *
   * §13(a) is what couples them: at most one sealed response per accepted
   * request counter, and a counter this window still accepts must therefore be
   * one the sealer can still answer. Two literals would let the widths drift in
   * a later edit, and the failure that drift produces is not a rejected request
   * — it is a request accepted here and refused there, i.e. an accepted request
   * that can never be answered.
   */
  static readonly WINDOW_COUNTERS = RestResponseSealer.WINDOW_COUNTERS;

  /**
   * `#private`, both of them, for the reason §13 states verbatim: *"The state
   * that makes a nonce unique is as sensitive as the key … with them as
   * ordinary properties, one assignment re-arms every answered counter, which
   * is keystream reuse."*
   *
   * TypeScript `private` is NOT sufficient — it is an ordinary own property at
   * runtime, and this module is consumed from a repository that has no types at
   * all. `window.highWater = -1n` would re-admit every counter this context has
   * ever seen, each of which the sealer would then be asked to answer a second
   * time under `(k_s2c, 2‖counter)`.
   */
  readonly #seenBits: Uint8Array;
  /** Highest counter ever admitted. `-1n` means "nothing yet". */
  #highWater = -1n;

  constructor() {
    this.#seenBits = new Uint8Array(RestReceiveWindow.WINDOW_COUNTERS / 8);
  }

  /**
   * Judge one AUTHENTICATED counter. Returns on acceptance; throws otherwise.
   *
   * The four outcomes, in the order they are decided — and the order is
   * load-bearing. Below-window is tested BEFORE the bit, because a counter that
   * has fallen out of the window reads a bit that now belongs to the counter
   * 1024 positions later: whatever that bit says is about a different counter,
   * so the range check has to answer first.
   */
  admit(counter: bigint): void {
    // A counter outside the range a nonce can even encode. `unsealUnchecked`
    // reads its counter with `readBigUInt64BE`, so this is unreachable from the
    // wire and is here for every other caller: a bigint is not bounded by its
    // type the way a `uint64` field is.
    if (counter < 0n || counter > MAX_COUNTER) {
      throw new RecordError(
        E2EE_SEQUENCE_VIOLATION,
        `record counter ${counter} is outside the range of a record nonce`,
      );
    }

    if (counter > this.#highWater) {
      this.#advanceTo(counter);
      this.#markSeen(counter);
      return;
    }

    if (this.#belowWindow(counter)) {
      throw new RecordError(
        E2EE_CTX_UNKNOWN,
        `record counter ${counter} is further behind than this context tracks; re-open and retry`,
      );
    }

    if (this.#isSeen(counter)) {
      throw new RecordError(
        E2EE_SEQUENCE_VIOLATION,
        `record counter ${counter} has already been received`,
      );
    }

    this.#markSeen(counter);
  }

  // ── the window ───────────────────────────────────────────────────
  //
  // The same ARITHMETIC as `RestResponseSealer`'s answered bitmap, deliberately:
  // the two halves of §13 have to agree about what "inside the window" means,
  // and `#bit`, `#belowWindow` and `#advanceTo` agree by being the same
  // computation rather than by two independent derivations that happen to match
  // today.
  //
  // **The guard placement deliberately differs, and this is the one difference.**
  // `RestResponseSealer.isAnswered` re-tests the range itself and returns
  // `false` outside it; `#isSeen` does not, because `admit` has already
  // established both preconditions before it asks. Neither shape can fail open:
  // both rejection tests sit in front of `#markSeen`, so a counter failing
  // either one never reaches acceptance under any ordering of the two. What the
  // order decides is *which* §9 code a below-window counter with a stale set bit
  // receives — and §9 requires the recoverable `E2EE_CTX_UNKNOWN`, because a
  // counter whose slot now belongs to a counter 1024 positions later is one we
  // cannot prove anything about, and `E2EE_SEQUENCE_VIOLATION` is a claim about
  // the peer. `__tests__/e2ee-rest-window.test.ts::decides below-window before
  // it reads the bit` pins that.
  //
  // The helpers are `#private` as well as the state — `#advanceTo` clears bits,
  // so a reachable one is the same re-arming assignment the fields are private
  // to prevent.

  #bit(counter: bigint): { index: number; mask: number } {
    const position = Number(counter % BigInt(RestReceiveWindow.WINDOW_COUNTERS));
    return { index: position >> 3, mask: 1 << (position & 7) };
  }

  #belowWindow(counter: bigint): boolean {
    return (
      this.#highWater >= 0n &&
      counter + BigInt(RestReceiveWindow.WINDOW_COUNTERS) <= this.#highWater
    );
  }

  /**
   * Whether this counter is recorded as received.
   *
   * **Only meaningful at or below the high-water mark and inside the window.**
   * Bits are indexed modulo the width, so a counter outside that range reads a
   * bit belonging to a different counter entirely. `admit` establishes both
   * before it asks, and this deliberately does NOT re-test them the way
   * `RestResponseSealer.isAnswered` does — see the block comment above.
   */
  #isSeen(counter: bigint): boolean {
    const { index, mask } = this.#bit(counter);
    return (this.#seenBits[index] & mask) !== 0;
  }

  #markSeen(counter: bigint): void {
    const { index, mask } = this.#bit(counter);
    this.#seenBits[index] |= mask;
  }

  /**
   * Slide the window forward, CLEARING every position it newly covers.
   *
   * The clear is the load-bearing half. Bits are indexed modulo the width, so
   * without it counter `c + 1024` reads the bit `c` set and is refused as a
   * replay it has nothing to do with — a legitimate request rejected, and one
   * that stays rejected for as long as the client keeps counting.
   *
   * The cost is O(min(delta, width)), never O(delta): an advance of more than
   * one full width has overwritten every position anyway, so it clears the
   * whole bitmap in one call instead of looping. A context whose client jumps
   * 10^9 counters must not spend 10^9 iterations proving that.
   */
  #advanceTo(counter: bigint): void {
    const width = BigInt(RestReceiveWindow.WINDOW_COUNTERS);
    if (this.#highWater < 0n || counter - this.#highWater >= width) {
      this.#seenBits.fill(0);
    } else {
      for (let c = this.#highWater + 1n; c <= counter; c++) {
        const { index, mask } = this.#bit(c);
        this.#seenBits[index] &= ~mask;
      }
    }
    this.#highWater = counter;
  }
}
