import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_TTL_MS,
  IdempotencyStore,
  readIdempotencyKey,
} from "../src/services/sessions/idempotency";

/**
 * Session-input idempotency (C4).
 *
 * Before this, a retried POST /api/sessions/:id/input submitted the same prompt
 * to the agent twice, and nothing could distinguish the retry from a deliberate
 * repeat. The rate limiter does not help — 500/min targets floods, and a real
 * retry sits comfortably inside it.
 */

const OK = { status: 200, body: { ok: true, promptCount: 3 } };

describe("IdempotencyStore", () => {
  it("replays the recorded result for a repeated key", () => {
    const store = new IdempotencyStore();
    store.set("sess-1", "key-a", OK);

    expect(store.get("sess-1", "key-a")).toEqual(OK);
  });

  it("treats an unseen key as new", () => {
    const store = new IdempotencyStore();
    store.set("sess-1", "key-a", OK);

    expect(store.get("sess-1", "key-b")).toBeNull();
  });

  // A key is only meaningful against the conversation it was minted for.
  // Matching across sessions would silently drop a genuinely different prompt.
  it("scopes keys per session", () => {
    const store = new IdempotencyStore();
    store.set("sess-1", "key-a", OK);

    expect(store.get("sess-2", "key-a")).toBeNull();
  });

  it("expires a key after the TTL", () => {
    const store = new IdempotencyStore();
    const t0 = 1_000_000;
    store.set("sess-1", "key-a", OK, t0);

    expect(store.get("sess-1", "key-a", t0 + IDEMPOTENCY_TTL_MS - 1)).toEqual(OK);
    expect(store.get("sess-1", "key-a", t0 + IDEMPOTENCY_TTL_MS + 1)).toBeNull();
  });

  it("bounds memory by evicting the oldest keys", () => {
    const store = new IdempotencyStore(IDEMPOTENCY_TTL_MS, 3);
    for (const k of ["a", "b", "c", "d"]) store.set("sess-1", k, OK);

    expect(store.size("sess-1")).toBe(3);
    // Evicted rather than remembered — the request is simply treated as new,
    // which is the safe direction to fail.
    expect(store.get("sess-1", "a")).toBeNull();
    expect(store.get("sess-1", "d")).toEqual(OK);
  });

  it("does not duplicate an entry when the same key is recorded twice", () => {
    const store = new IdempotencyStore();
    store.set("sess-1", "key-a", OK);
    store.set("sess-1", "key-a", { status: 200, body: { ok: true, promptCount: 4 } });

    expect(store.size("sess-1")).toBe(1);
    expect(store.get("sess-1", "key-a")).toEqual({
      status: 200,
      body: { ok: true, promptCount: 4 },
    });
  });

  it("drops everything for a cleared session", () => {
    const store = new IdempotencyStore();
    store.set("sess-1", "key-a", OK);
    store.clear("sess-1");

    expect(store.get("sess-1", "key-a")).toBeNull();
  });

  it("prunes expired entries when recording a new one", () => {
    const store = new IdempotencyStore();
    const t0 = 1_000_000;
    store.set("sess-1", "old", OK, t0);
    store.set("sess-1", "new", OK, t0 + IDEMPOTENCY_TTL_MS + 1);

    expect(store.size("sess-1")).toBe(1);
  });
});

describe("readIdempotencyKey", () => {
  it("returns the key when present", () => {
    expect(readIdempotencyKey({ idempotencyKey: "abc" })).toBe("abc");
  });

  // Optional, so existing clients keep working unchanged.
  it("returns undefined when absent", () => {
    expect(readIdempotencyKey({})).toBeUndefined();
    expect(readIdempotencyKey({ idempotencyKey: null })).toBeUndefined();
  });

  // A client sending a malformed key believes it has retry protection.
  // Silently proceeding without it would be worse than rejecting.
  it.each([
    ["empty string", ""],
    ["non-string", 42],
    ["over-long", "x".repeat(201)],
  ])("throws on an invalid key (%s)", (_name, value) => {
    expect(() => readIdempotencyKey({ idempotencyKey: value })).toThrow(/idempotencyKey/);
  });
});
