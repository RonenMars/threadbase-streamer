// The `/api/e2ee/open` msg1 replay cache.
//
// A Noise `IK` message 1 carries NO freshness: no PSK, no responder challenge,
// no timestamp. Anyone who captures one valid msg1 can send it again for as
// long as the server's identity key lives, and every replay is a complete,
// authentic handshake — so it is neither a handshake failure nor a missing
// device row, and neither budget on the route charged it. An adversary replayed
// one captured message a thousand times and ran two thousand X25519 operations.
//
// Worse than the cost: because a replay AUTHENTICATES AS THE VICTIM, the
// per-device limiter §8 asks for is what makes the attack *targeted*. Five
// replays spent the victim's whole minute and pushed it past its four-socket
// cap, retiring a live context — from one captured message, against one chosen
// device, while every other device carried on.
//
// **What makes this detectable is the pattern itself.** In `IK`, `e` — the
// initiator's ephemeral public key — is transmitted in the clear at a fixed
// offset, and a legitimate client generates a fresh one for every handshake.
// So a repeated `e` is not a heuristic for a replay; it is definitionally one.
//
// The residual, stated rather than left to be discovered: a capture replayed
// after its entry is evicted, or past the TTL, still costs one DH pair and one
// per-device slot per attempt. That is bounded by the source and per-device
// budgets, and a one-minute per-device lockout per five such replays is the
// accepted floor. The real cure is client-side freshness — a nonce in the msg1
// payload, bound into the transcript — which is a protocol version away and
// deliberately not now.

import { own } from "./protocol";

/** ~2 MiB at 32-byte keys. The bound is on entries, not on bytes. */
export const MSG1_REPLAY_CACHE_ENTRIES = 65_536;

/**
 * How many expired entries one `record` call may collect.
 *
 * ponytail: amortised prune with a per-call ceiling, not a sweeper. Entries
 * share one TTL and are stored in first-seen order, so the expired ones are
 * always at the front and this is O(1) amortised; the ceiling is there so a
 * burst of simultaneous expiries cannot stall a request. Memory is bounded by
 * the capacity check regardless of how little pruning happens.
 */
const MAX_PRUNE_PER_CALL = 128;

/**
 * Remembers the ephemerals of message 1s that reached the handshake.
 *
 * Insertion-ordered and never refreshed on a hit — a hit is a replay, and
 * refreshing it would let an attacker pin a slot indefinitely with traffic that
 * is already being rejected. That is the one place this deliberately differs
 * from a textbook LRU: eviction is by first-seen age, which for entries that
 * are only ever written once is the same thing.
 */
export class Msg1ReplayCache {
  /** ephemeral (base64) → the moment the entry stops counting. */
  readonly #seen = new Map<string, number>();
  readonly #capacity: number;
  readonly #ttlMs: number;

  constructor(options: { capacity?: number; ttlMs: number }) {
    // Off the ARGUMENT: a polluted `Object.prototype.capacity` of 1 evicts a
    // captured msg1 back into replayability on the next open.
    this.#capacity = own(options, "capacity") ?? MSG1_REPLAY_CACHE_ENTRIES;
    this.#ttlMs = options.ttlMs;
  }

  /** Live entries. For tests and for a diagnostics line — never a key. */
  get size(): number {
    return this.#seen.size;
  }

  /** Whether this ephemeral has already been through the handshake. */
  has(ephemeral: Buffer, now: number = Date.now()): boolean {
    const key = ephemeral.toString("base64");
    const expiresAt = this.#seen.get(key);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.#seen.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Record an ephemeral that actually reached the handshake.
   *
   * Called only after `readMessage1` has succeeded, so garbage that never
   * parsed cannot fill the cache — the bound protects the thing the bound is
   * for.
   */
  record(ephemeral: Buffer, now: number = Date.now()): void {
    let pruned = 0;
    for (const [key, expiresAt] of this.#seen) {
      if (now < expiresAt || pruned >= MAX_PRUNE_PER_CALL) break;
      this.#seen.delete(key);
      pruned++;
    }
    while (this.#seen.size >= this.#capacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }
    this.#seen.set(ephemeral.toString("base64"), now + this.#ttlMs);
  }

  /** A streamer restart does this by existing; tests need a call. */
  clear(): void {
    this.#seen.clear();
  }
}
