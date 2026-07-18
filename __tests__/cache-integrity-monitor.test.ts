import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import type { Logger } from "../src/logger";
import { loadAlertState } from "../src/services/cache-integrity/alertStore";
import { CacheIntegrityMonitor } from "../src/services/cache-integrity/cacheIntegrityMonitor";
import type { WSMessage } from "../src/types";
import type { WSHub } from "../src/ws-hub";

let root: string; // holds jsonl files
let cacheDir: string; // holds cache.db + backups + cache-alert.json
let cache: ConversationCache;
let broadcasts: WSMessage[];
let hub: WSHub;
let configBefore: string | undefined;

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  log: () => {},
  pino: {} as never,
};

function makeHub(): WSHub {
  return { broadcast: (m: WSMessage) => broadcasts.push(m) } as unknown as WSHub;
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

/** Create `n` real jsonl files + upsert their rows. Returns their ids/paths. */
function seed(n: number): { id: string; filePath: string }[] {
  const out: { id: string; filePath: string }[] = [];
  const metas = [];
  for (let i = 0; i < n; i++) {
    const id = `conv-${i}`;
    const filePath = join(root, `${id}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify({ type: "summary" })}\n`);
    metas.push({ ...META_BASE, id, sessionId: id, filePath });
    out.push({ id, filePath });
  }
  cache.upsertFromScannerMeta(metas as never);
  return out;
}

beforeEach(() => {
  configBefore = process.env.THREADBASE_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "cim-root-"));
  cacheDir = mkdtempSync(join(tmpdir(), "cim-cache-"));
  process.env.THREADBASE_CONFIG_DIR = cacheDir; // cache-alert.json lands here
  cache = ConversationCache.open(join(cacheDir, "cache.db"), 3);
  broadcasts = [];
  hub = makeHub();
});

afterEach(() => {
  cache.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  if (configBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = configBefore;
  delete process.env.THREADBASE_CACHE_ALERT_MIN_MISSING;
  delete process.env.THREADBASE_CACHE_ALERT_MIN_RATIO;
  vi.useRealTimers();
});

function monitor(rescan?: () => Promise<never>): CacheIntegrityMonitor {
  return new CacheIntegrityMonitor(cache, hub, noopLog, cacheDir, rescan as never);
}

describe("severity classification", () => {
  it("is high at/above both thresholds (>=20 missing AND >=20% ratio)", async () => {
    const files = seed(100);
    // Delete 20 of 100 → 20 missing, ratio 0.20.
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();
    expect(m.pending?.severity).toBe("high");
    expect(m.pending?.missingCount).toBe(20);
    expect(m.pending?.backupPath).toBeTruthy(); // high → immediate backup
  });

  it("is low when below the missing-count threshold", async () => {
    const files = seed(100);
    for (let i = 0; i < 19; i++) rmSync(files[i].filePath); // 19 < 20
    const m = monitor();
    await m.runDetection();
    expect(m.pending?.severity).toBe("low");
    expect(m.pending?.backupPath).toBeUndefined(); // low → no forced backup
  });

  it("is low when below the ratio threshold even with many missing", async () => {
    const files = seed(200);
    for (let i = 0; i < 25; i++) rmSync(files[i].filePath); // 25 missing, ratio 0.125
    const m = monitor();
    await m.runDetection();
    expect(m.pending?.severity).toBe("low");
  });
});

describe("ignored ids", () => {
  it("excludes ignored ids from the missing-set", async () => {
    const files = seed(5);
    for (const f of files) rmSync(f.filePath); // all 5 gone
    const m = monitor();
    await m.runDetection();
    expect(m.pending?.missingCount).toBe(5);

    // Ignore all 5 → clears the alert.
    const fp = m.pending?.fingerprint as string;
    await m.resolve(fp, "ignore");
    expect(m.pending).toBeNull();

    // A fresh detection sees nothing (all ignored).
    await m.runDetection();
    expect(m.pending).toBeNull();
  });
});

describe("fingerprint", () => {
  it("is stable for the same missing-set and changes when the set changes", async () => {
    const files = seed(5);
    rmSync(files[0].filePath);
    rmSync(files[1].filePath);
    const m1 = monitor();
    await m1.runDetection();
    const fp1 = m1.pending?.fingerprint;

    // Re-run detection with the same set → same fingerprint.
    await m1.runDetection();
    expect(m1.pending?.fingerprint).toBe(fp1);

    // Delete one more → different fingerprint.
    rmSync(files[2].filePath);
    await m1.runDetection();
    expect(m1.pending?.fingerprint).not.toBe(fp1);
  });
});

describe("storm window", () => {
  it("triggers detection at exactly the threshold, not one below", async () => {
    const files = seed(30);
    // Delete 12 files so a detection would find drift, but do NOT run detection.
    for (let i = 0; i < 12; i++) rmSync(files[i].filePath);
    const m = monitor();

    vi.useFakeTimers();
    vi.setSystemTime(0);
    // 9 unlinks within the window: below threshold, no detection.
    for (let i = 0; i < 9; i++) m.recordUnlink(files[i].filePath);
    expect(m.pending).toBeNull();

    // 10th unlink crosses the threshold → detection runs.
    m.recordUnlink(files[9].filePath);
    await vi.waitFor(() => expect(m.pending).not.toBeNull());
    expect(m.pending?.missingCount).toBe(12);
  });

  it("drops unlinks older than the 30s window", async () => {
    const files = seed(30);
    for (let i = 0; i < 12; i++) rmSync(files[i].filePath);
    const m = monitor();

    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let i = 0; i < 9; i++) m.recordUnlink(files[i].filePath);
    // Jump past the window: the 9 earlier unlinks expire.
    vi.setSystemTime(31_000);
    for (let i = 0; i < 9; i++) m.recordUnlink(files[i].filePath);
    // Only 9 in-window → still no detection.
    expect(m.pending).toBeNull();
  });
});

describe("deferred unlink queue", () => {
  it("prune_all drains the deferred queue", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();
    expect(m.pending).not.toBeNull();

    // While pending, a live unlink of a still-present row is deferred.
    const extra = files[25];
    rmSync(extra.filePath);
    m.deferUnlink(extra.filePath);
    expect(cache.hasConversation("conv-25")).toBe(true); // not yet invalidated

    const fp = m.pending?.fingerprint as string;
    const res = await m.resolve(fp, "prune_all");
    expect(res).toMatchObject({ ok: true, action: "prune_all" });
    // Deferred unlink applied.
    expect(cache.hasConversation("conv-25")).toBe(false);
    // The 20 missing rows are pruned.
    expect(cache.hasConversation("conv-0")).toBe(false);
  });

  it("ignore discards the deferred queue (keeps those rows)", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();

    const extra = files[25];
    rmSync(extra.filePath);
    m.deferUnlink(extra.filePath);

    const fp = m.pending?.fingerprint as string;
    await m.resolve(fp, "ignore");
    // Deferred unlink discarded — the row survives.
    expect(cache.hasConversation("conv-25")).toBe(true);
    // The 20 originally-missing rows also survive (ignored, not pruned).
    expect(cache.hasConversation("conv-0")).toBe(true);
  });

  it("prune_selected drops only the requested subset and re-runs detection", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();
    const fp = m.pending?.fingerprint as string;

    // Prune only 5 of the 20 missing ids.
    const subset = ["conv-0", "conv-1", "conv-2", "conv-3", "conv-4"];
    const res = await m.resolve(fp, "prune_selected", subset);
    expect(res).toMatchObject({ ok: true, action: "prune_selected", pruned: 5 });
    for (const id of subset) expect(cache.hasConversation(id)).toBe(false);
    // The remaining 15 are still missing → a NEW pending alert (new fingerprint).
    expect(m.pending).not.toBeNull();
    expect(m.pending?.fingerprint).not.toBe(fp);
    expect(m.pending?.missingCount).toBe(15);
  });
});

describe("resolve idempotency", () => {
  it("returns alreadyResolved when no alert is pending", async () => {
    const m = monitor();
    const res = await m.resolve("sha256:whatever", "prune_all");
    expect(res).toEqual({ alreadyResolved: true });
  });

  it("returns conflict on a fingerprint mismatch", async () => {
    const files = seed(5);
    for (const f of files) rmSync(f.filePath);
    const m = monitor();
    await m.runDetection();
    const res = await m.resolve("sha256:stale", "prune_all");
    expect(res).toMatchObject({ conflict: true, currentFingerprint: m.pending?.fingerprint });
  });

  it("two concurrent same-fingerprint resolves: first wins, second no-ops", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();
    const fp = m.pending?.fingerprint as string;

    // Fire both without awaiting between them — the second must observe the
    // alert already claimed (cleared synchronously at the top of resolve).
    const [a, b] = await Promise.all([m.resolve(fp, "prune_all"), m.resolve(fp, "prune_all")]);
    const results = [a, b];
    expect(results.filter((r) => "ok" in r)).toHaveLength(1);
    expect(results.filter((r) => "alreadyResolved" in r)).toHaveLength(1);
    expect(m.pending).toBeNull();
  });

  it("prune_all re-verifies against disk (skips reappeared files)", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor();
    await m.runDetection();
    const fp = m.pending?.fingerprint as string;

    // One file reappears before resolve.
    writeFileSync(files[0].filePath, `${JSON.stringify({ type: "summary" })}\n`);
    const res = await m.resolve(fp, "prune_all");
    // 19 still missing → 19 pruned, conv-0 kept.
    expect(res).toMatchObject({ pruned: 19 });
    expect(cache.hasConversation("conv-0")).toBe(true);
  });
});

describe("reset_rescan", () => {
  it("backs up, clears all, and rebuilds from the injected rescan", async () => {
    const files = seed(30);
    for (let i = 0; i < 20; i++) rmSync(files[i].filePath);
    const m = monitor(async () => {
      // Fresh scan surfaces only the 10 surviving files.
      return files.slice(20).map((f, i) => ({
        ...META_BASE,
        id: `conv-${20 + i}`,
        sessionId: `conv-${20 + i}`,
        filePath: f.filePath,
      })) as never;
    });
    await m.runDetection();
    const fp = m.pending?.fingerprint as string;

    const res = await m.resolve(fp, "reset_rescan");
    expect(res).toMatchObject({ ok: true, action: "reset_rescan" });
    expect(res).toHaveProperty("backupPath");
    expect(m.pending).toBeNull();
    // Only the 10 surviving rows remain.
    expect(cache.listConversations({ limit: 0, offset: 0 }).total).toBe(10);
    expect(cache.hasConversation("conv-25")).toBe(true);
    expect(cache.hasConversation("conv-0")).toBe(false);
  });
});

describe("persistence", () => {
  it("round-trips a pending alert through alertStore across monitor instances", async () => {
    const files = seed(5);
    for (const f of files) rmSync(f.filePath);
    const m1 = monitor();
    await m1.runDetection();
    const fp = m1.pending?.fingerprint;
    expect(fp).toBeTruthy();

    // On-disk state is real JSON.
    expect(loadAlertState().pending?.fingerprint).toBe(fp);

    // A fresh monitor reads the pending alert from disk.
    const m2 = monitor();
    expect(m2.pending?.fingerprint).toBe(fp);
    expect(m2.pending?.missingCount).toBe(5);
  });

  it("persists ignored ids durably across instances", async () => {
    const files = seed(5);
    for (const f of files) rmSync(f.filePath);
    const m1 = monitor();
    await m1.runDetection();
    await m1.resolve(m1.pending?.fingerprint as string, "ignore");

    expect(loadAlertState().ignoredIds?.length).toBe(5);
    // A fresh monitor still ignores them.
    const m2 = monitor();
    await m2.runDetection();
    expect(m2.pending).toBeNull();
  });
});
