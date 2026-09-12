import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CLIENT_LOG_RATE_LIMIT,
  MAX_CLIENT_LOG_ENTRIES,
  MAX_JSON_BODY_BYTES,
} from "../src/api/routes/misc.routes";
import { StreamerServer } from "../src/server";

/**
 * `POST /api/__client-log` bounds. tb-mobile is about to ship slow-request
 * timings from release builds to this endpoint, which today is unbounded in
 * request rate, body size, and per-batch/per-entry size — fine behind Metro,
 * not fine for a released app.
 *
 * A tap on the "client" logger (not a stub — it still calls through) is the
 * only way to prove a refused or truncated request wrote fewer lines than it
 * asked for, since the HTTP response alone can't show what reached the log.
 */

const clientLogCalls = vi.hoisted(
  () => [] as { level: string; msg: string; meta: Record<string, unknown> }[],
);
vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  return {
    ...actual,
    getLogger: (component?: string) => {
      const real = actual.getLogger(component);
      if (component !== "client") return real;
      const wrap =
        (level: "debug" | "info" | "warn" | "error") =>
        (msg: string, meta?: Record<string, unknown>) => {
          clientLogCalls.push({ level, msg, meta: meta ?? {} });
          return real[level](msg, meta);
        };
      return {
        ...real,
        debug: wrap("debug"),
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
      };
    },
  };
});

const API_KEY = "tb_test_key_for_client_log_bounds";
const AUTH = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const HOST_ISOLATION = { codexRoots: [] as string[], scannerPersistent: false };

describe("POST /api/__client-log bounds", () => {
  let server: StreamerServer;
  let baseUrl: string;
  let cacheDir: string;

  beforeEach(async () => {
    clientLogCalls.length = 0;
    cacheDir = mkdtempSync(join(tmpdir(), "threadbase-client-log-"));
    server = new StreamerServer({
      ...HOST_ISOLATION,
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [],
    });
    await server.listen(0, { awaitReady: true });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/__client-log`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });

  // Positive control: a small, ordinary batch is accepted and reaches the
  // logger untouched, so the bounds below are proven against a working
  // baseline rather than a handler that always refuses.
  it("accepts a normal batch and logs every entry unmodified", async () => {
    const res = await post({ entries: [{ level: "info", tag: "t", msg: "hello" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
    expect(clientLogCalls).toHaveLength(1);
    expect(clientLogCalls[0].msg).toBe("[client] t: hello");
  });

  it("answers 413 and logs nothing when the body exceeds the byte cap", async () => {
    const oversized = "A".repeat(MAX_JSON_BODY_BYTES + 1024);
    const res = await post({ entries: [{ msg: oversized }] });
    expect(res.status).toBe(413);
    expect(clientLogCalls).toHaveLength(0);
  });

  it("truncates a batch over the entry cap instead of logging it whole", async () => {
    const entries = Array.from({ length: MAX_CLIENT_LOG_ENTRIES + 5 }, (_, i) => ({
      msg: `entry-${i}`,
    }));
    const res = await post({ entries });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: MAX_CLIENT_LOG_ENTRIES });
    expect(clientLogCalls).toHaveLength(MAX_CLIENT_LOG_ENTRIES);
  });

  it("truncates an over-long msg rather than logging it whole", async () => {
    const longMsg = "x".repeat(5000);
    const res = await post({ entries: [{ msg: longMsg }] });
    expect(res.status).toBe(200);
    expect(clientLogCalls).toHaveLength(1);
    expect(clientLogCalls[0].msg.length).toBeLessThan(longMsg.length);
    expect(clientLogCalls[0].msg).toContain("(truncated)");
  });

  it("truncates over-long fields rather than logging them whole", async () => {
    const bigFields = { blob: "y".repeat(6000) };
    const res = await post({ entries: [{ msg: "ok", fields: bigFields }] });
    expect(res.status).toBe(200);
    expect(clientLogCalls).toHaveLength(1);
    const meta = clientLogCalls[0].meta;
    expect(meta.blob).toBeUndefined();
    expect(typeof meta.fieldsTruncated).toBe("string");
    expect((meta.fieldsTruncated as string).length).toBeLessThan(JSON.stringify(bigFields).length);
  });

  it("answers 429 and logs nothing once the per-caller rate limit is spent", async () => {
    for (let i = 0; i < CLIENT_LOG_RATE_LIMIT; i++) {
      const res = await post({ entries: [] });
      expect(res.status).toBe(200);
    }
    clientLogCalls.length = 0;
    const res = await post({ entries: [{ msg: "should not be logged" }] });
    expect(res.status).toBe(429);
    expect(clientLogCalls).toHaveLength(0);
  });
});
