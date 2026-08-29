import { randomBytes } from "crypto";
import { MSG1_REPLAY_CACHE_ENTRIES, Msg1ReplayCache } from "../src/e2ee/replay-cache";

/**
 * The msg1 replay cache (adversary E-1/E-2).
 *
 * A Noise `IK` message 1 carries no freshness, so one captured message is
 * replayable for the life of the identity key. What makes a replay detectable
 * is that `e` travels in the clear and a legitimate client mints a fresh one
 * per handshake — so a repeated `e` is definitionally a replay.
 */

const ephemeral = () => randomBytes(32);

describe("Msg1ReplayCache", () => {
  it("recognises a repeat and nothing else", () => {
    const cache = new Msg1ReplayCache({ ttlMs: 60_000 });
    const e = ephemeral();

    expect(cache.has(e)).toBe(false);
    cache.record(e);
    expect(cache.has(e)).toBe(true);
    // A fresh ephemeral is never a replay — the positive control for every
    // legitimate client, which opens repeatedly.
    for (let i = 0; i < 100; i++) expect(cache.has(ephemeral())).toBe(false);
    // Byte-for-byte, not by reference.
    expect(cache.has(Buffer.from(e))).toBe(true);
  });

  it("evicts the oldest at capacity and still accepts a fresh ephemeral", () => {
    const capacity = 64;
    const cache = new Msg1ReplayCache({ capacity, ttlMs: 60_000 });
    const first = ephemeral();
    cache.record(first);
    for (let i = 0; i < capacity * 3; i++) cache.record(ephemeral());

    // Memory is flat: the bound is on entries and it holds however long the
    // flood runs.
    expect(cache.size).toBeLessThanOrEqual(capacity);
    // The oldest entry is gone — the accepted residual, stated in the module:
    // a capture replayed after eviction costs one more handshake.
    expect(cache.has(first)).toBe(false);
    // And a fresh one is still accepted rather than the cache jamming shut.
    const fresh = ephemeral();
    expect(cache.has(fresh)).toBe(false);
    cache.record(fresh);
    expect(cache.has(fresh)).toBe(true);
  });

  it("forgets an entry after its TTL", () => {
    const cache = new Msg1ReplayCache({ ttlMs: 1000 });
    const e = ephemeral();
    const t0 = Date.now();
    cache.record(e, t0);

    expect(cache.has(e, t0 + 999)).toBe(true);
    expect(cache.has(e, t0 + 1000)).toBe(false);
    // Expired entries are collected rather than merely refused.
    expect(cache.size).toBe(0);
  });

  it("keeps memory flat across a long run of expiring entries", () => {
    const cache = new Msg1ReplayCache({ capacity: 1024, ttlMs: 100 });
    let now = Date.now();
    for (let i = 0; i < 20_000; i++) {
      cache.record(ephemeral(), now);
      now += 1;
    }
    expect(cache.size).toBeLessThanOrEqual(1024);
  });

  it("defaults to the pinned capacity", () => {
    expect(MSG1_REPLAY_CACHE_ENTRIES).toBe(65_536);
    expect(new Msg1ReplayCache({ ttlMs: 1 }).size).toBe(0);
  });
});
