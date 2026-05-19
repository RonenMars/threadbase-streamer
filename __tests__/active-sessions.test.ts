import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countActiveSessions } from "../src/updater/active-sessions";

describe("countActiveSessions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns kind=count with the streamer's total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ total: 3, sessions: [] }),
        } as Response),
      ),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r).toEqual({ kind: "count", count: 3 });
  });

  it("falls back to sessions.length when total is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ sessions: [{}, {}] }),
        } as Response),
      ),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r).toEqual({ kind: "count", count: 2 });
  });

  it("returns kind=unreachable when fetch throws (streamer not running)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r.kind).toBe("unreachable");
    if (r.kind === "unreachable") expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it("returns kind=error on non-2xx HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}),
        } as Response),
      ),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(500);
  });

  it("returns kind=error when response body is malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => {
            throw new Error("unexpected token");
          },
        } as Response),
      ),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/malformed JSON/);
  });

  it("returns kind=error when response has neither total nor sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ unrelated: "field" }),
        } as Response),
      ),
    );
    const r = await countActiveSessions({ port: 3456, apiKey: "tb_x" });
    expect(r.kind).toBe("error");
  });
});
