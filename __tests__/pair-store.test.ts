import { PairTokenStore } from "../src/pair-store";

describe("PairTokenStore", () => {
  it("mints a token with the expected shape", () => {
    const store = new PairTokenStore({ ttlSeconds: 180, autoSweep: false });
    const minted = store.mint();
    expect(minted.token).toMatch(/^pt_[0-9a-f]{32}$/);
    expect(minted.expiresInSeconds).toBe(180);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    store.dispose();
  });

  it("consumes a valid token exactly once", () => {
    const store = new PairTokenStore({ ttlSeconds: 180, autoSweep: false });
    const { token } = store.mint();
    expect(store.consume(token)).toEqual({ ok: true });
    expect(store.consume(token)).toEqual({ ok: false, reason: "used" });
    store.dispose();
  });

  it("rejects unknown tokens", () => {
    const store = new PairTokenStore({ ttlSeconds: 180, autoSweep: false });
    expect(store.consume("pt_does_not_exist")).toEqual({ ok: false, reason: "unknown" });
    store.dispose();
  });

  it("rejects expired tokens", async () => {
    const store = new PairTokenStore({ ttlSeconds: 0.05, autoSweep: false });
    const { token } = store.mint();
    await new Promise((r) => setTimeout(r, 80));
    expect(store.consume(token)).toEqual({ ok: false, reason: "expired" });
    store.dispose();
  });

  it("replaces a prior unused token when a new one is minted", () => {
    const store = new PairTokenStore({ ttlSeconds: 180, autoSweep: false });
    const first = store.mint();
    const second = store.mint();
    expect(first.token).not.toBe(second.token);
    expect(store.consume(first.token)).toEqual({ ok: false, reason: "unknown" });
    expect(store.consume(second.token)).toEqual({ ok: true });
    store.dispose();
  });

  it("sweep clears expired tokens", async () => {
    const store = new PairTokenStore({ ttlSeconds: 0.05, autoSweep: false });
    store.mint();
    await new Promise((r) => setTimeout(r, 80));
    store.sweep();
    expect(store.peek()).toBeNull();
    store.dispose();
  });
});
