import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ConversationCache } from "../src/conversation-cache";
import { StreamerServer } from "../src/server";

const API_KEY = "tb_test_key_for_integration_tests";

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll GET /api/cache/alert until a pending alert appears; return its fingerprint. */
async function waitForAlert(port: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`http://localhost:${port}/api/cache/alert`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as { pending: { fingerprint: string } | null };
    if (body.pending) return body.pending.fingerprint;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error("cache_alert never became pending");
}

const META_BASE = {
  projectPath: "/home/proj",
  projectName: "Proj",
  title: "T",
  model: "m",
  account: "a",
  gitBranch: "main",
  messageCount: 1,
  timestamp: "2024-01-01T10:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: "p",
};

/** Pre-seed the cache with rows whose JSONL files don't exist on disk, so the
 *  server's warm-up detection raises a genuine (high-severity) pending alert. */
function seedMissingRows(cacheDir: string, n: number): void {
  const cache = ConversationCache.open(join(cacheDir, "cache.db"), 3);
  const metas = [];
  for (let i = 0; i < n; i++) {
    const id = `missing-${i}`;
    metas.push({
      ...META_BASE,
      id,
      sessionId: id,
      filePath: `/does/not/exist/${id}.jsonl`,
    });
  }
  cache.upsertFromScannerMeta(metas as never);
  cache.close();
}

describe("cache-integrity alert wiring", () => {
  let server: StreamerServer;
  let port: number;
  let cacheDir: string;
  let configDir: string;
  let scanDir: string;
  let configBefore: string | undefined;
  let fingerprint: string;

  beforeEach(async () => {
    configBefore = process.env.THREADBASE_CONFIG_DIR;
    // Deterministic high severity independent of any real conversations the
    // scanner surfaces on the host: 25 missing >= 20, ratio threshold 0.
    process.env.THREADBASE_CACHE_ALERT_MIN_MISSING = "20";
    process.env.THREADBASE_CACHE_ALERT_MIN_RATIO = "0";
    port = await getRandomPort();
    cacheDir = mkdtempSync(join(tmpdir(), "cache-alert-wiring-cache-"));
    configDir = mkdtempSync(join(tmpdir(), "cache-alert-wiring-cfg-"));
    scanDir = mkdtempSync(join(tmpdir(), "cache-alert-wiring-scan-"));
    mkdirSync(join(scanDir, "projects"), { recursive: true }); // empty → no fixture rows
    process.env.THREADBASE_CONFIG_DIR = configDir;
    // 25 cached rows, all files missing → high severity (>=20 and 100% ratio).
    seedMissingRows(cacheDir, 25);

    server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      scanProfiles: [{ id: "test", label: "Test", configDir: scanDir, enabled: true, emoji: "🧪" }],
      // Without these the scanner opens its own persistent SQLite index, which
      // both leaks real host conversations in and needs a native better-sqlite3
      // build that is not guaranteed on every dev machine. Every other server
      // fixture in the suite disables them.
      codexRoots: [],
      scannerPersistent: false,
    });
    await server.listen(port);

    // Warm-up runs detection asynchronously; wait until the alert is raised.
    fingerprint = await waitForAlert(port);
  });

  afterEach(async () => {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
    if (configBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = configBefore;
    delete process.env.THREADBASE_CACHE_ALERT_MIN_MISSING;
    delete process.env.THREADBASE_CACHE_ALERT_MIN_RATIO;
  });

  it("unicasts the pending cache_alert to a client on WS connect", async () => {
    const events: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}/ws?key=${API_KEY}`);
    ws.on("message", (d) => {
      try {
        events.push(JSON.parse(d.toString()));
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((r) => ws.on("open", () => r()));
    // Give the server a tick to flush the on-open messages.
    await new Promise<void>((r) => setTimeout(r, 200));
    ws.close();

    const alert = events.find((e) => e.type === "cache_alert");
    expect(alert).toBeTruthy();
    expect(alert.fingerprint).toBe(fingerprint);
    expect(alert.severity).toBe("high");
    expect(alert.missingCount).toBeGreaterThanOrEqual(25);
  });

  it("exposes the pending alert on GET /api/cache/alert", async () => {
    const res = await fetch(`http://localhost:${port}/api/cache/alert`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: { fingerprint: string } | null };
    expect(body.pending?.fingerprint).toBe(fingerprint);
  });

  it("reports the alert on /healthz", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as {
      cacheAlert?: { severity: string; fingerprint: string; missingCount: number };
    };
    expect(body.cacheAlert?.fingerprint).toBe(fingerprint);
    expect(body.cacheAlert?.severity).toBe("high");
    expect(body.cacheAlert?.missingCount).toBeGreaterThanOrEqual(25);
  });

  async function resolve(bodyObj: unknown): Promise<Response> {
    return fetch(`http://localhost:${port}/api/cache/alert/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    });
  }

  it("POST /resolve 400s on an invalid body", async () => {
    const res = await resolve({ action: "not_a_real_action" });
    expect(res.status).toBe(400);
  });

  it("POST /resolve 400s when prune_selected omits ids", async () => {
    const res = await resolve({ fingerprint, action: "prune_selected" });
    expect(res.status).toBe(400);
  });

  it("POST /resolve 409s on a fingerprint mismatch", async () => {
    const res = await resolve({ fingerprint: "sha256:stale", action: "ignore" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; currentFingerprint: string };
    expect(body.error).toBe("fingerprint_mismatch");
    expect(body.currentFingerprint).toBe(fingerprint);
  });

  it("POST /resolve applies ignore, then a second resolve is alreadyResolved", async () => {
    const first = await resolve({ fingerprint, action: "ignore" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; action: string };
    expect(firstBody).toMatchObject({ ok: true, action: "ignore" });

    // Alert is now cleared — GET reflects it.
    const get = await fetch(`http://localhost:${port}/api/cache/alert`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect((await get.json()).pending).toBeNull();

    // A second resolve for the same fingerprint no-ops.
    const second = await resolve({ fingerprint, action: "ignore" });
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyResolved).toBe(true);
  });
});
