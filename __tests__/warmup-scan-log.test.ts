import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StreamerServer } from "../src/server";

// Issue #501 slice 1: the warm-up scan is the boot's biggest cost, and nothing
// said whether it ran cold (full parse of every JSONL) or seeded from the
// persisted stat cache (only changed files re-parsed). One line per boot names
// the mode, the scan time and the conversation count.

const serverLogCalls = vi.hoisted(
  () => [] as { level: string; msg: string; meta: Record<string, unknown> }[],
);
vi.mock("../src/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger")>();
  return {
    ...actual,
    getLogger: (component?: string) => {
      const real = actual.getLogger(component);
      if (component !== "server") return real;
      const wrap =
        (level: "debug" | "info" | "warn" | "error") =>
        (msg: string, meta?: Record<string, unknown>) => {
          serverLogCalls.push({ level, msg, meta: meta ?? {} });
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

const API_KEY = "tb_test_key_for_warmup_scan_log";
const COUNT = 3;

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-warmup-log-cfg-"));
  const project = join(dir, "projects", "-tmp-proj");
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    writeFileSync(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: "user",
        sessionId: id,
        cwd: "/tmp/proj",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: `hello ${i}` },
      })}\n`,
    );
  }
  return dir;
}

function makeServer(configDir: string, cacheDir: string): StreamerServer {
  return new StreamerServer({
    port: 0,
    apiKey: API_KEY,
    localNoAuth: false,
    verbose: false,
    disableDb: true,
    cacheDir,
    scannerPersistent: false,
    codexRoots: [],
    cursorRoots: [],
    scanProfiles: [{ id: "t", label: "t", configDir, enabled: true, emoji: "" }],
  });
}

const doneLines = () => serverLogCalls.filter((c) => c.meta.event === "cache.warmup_scan_done");

describe("warm-up scan log (#501)", () => {
  let server: StreamerServer | undefined;

  beforeEach(() => {
    serverLogCalls.length = 0;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("logs one cold line with mode, durationMs and the conversation count on an empty cache", async () => {
    server = makeServer(seed(), mkdtempSync(join(tmpdir(), "tb-warmup-log-cache-")));
    await server.listen(0, { awaitReady: true });

    const lines = doneLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].meta.mode).toBe("cold");
    expect(typeof lines[0].meta.durationMs).toBe("number");
    expect(lines[0].meta.durationMs as number).toBeGreaterThanOrEqual(0);
    // Measured from the scan start, not the epoch.
    expect(lines[0].meta.durationMs as number).toBeLessThan(60_000);
    expect(lines[0].meta.metas).toBe(COUNT);
  }, 60_000);

  it("logs mode stat-cache when the persisted cache seeds the scan", async () => {
    const cfg = seed();
    const cacheDir = mkdtempSync(join(tmpdir(), "tb-warmup-log-cache-"));
    const first = makeServer(cfg, cacheDir);
    await first.listen(0, { awaitReady: true });
    await first.close();
    serverLogCalls.length = 0;

    server = makeServer(cfg, cacheDir);
    await server.listen(0, { awaitReady: true });

    const lines = doneLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].meta.mode).toBe("stat-cache");
    expect(lines[0].meta.statCacheEntries).toBe(COUNT);
    expect(lines[0].meta.metas).toBe(COUNT);
  }, 60_000);
});
