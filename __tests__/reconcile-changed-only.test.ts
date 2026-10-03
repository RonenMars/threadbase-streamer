import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ScannerManager } from "../src/scanner-manager";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

const hoisted = vi.hoisted(() => ({ metas: [] as Array<{ id: string; filePath: string }> }));

vi.mock("@threadbase-sh/scanner", () => ({
  ConversationScanner: class {
    scan() {
      return Promise.resolve([]);
    }
    getMetadataCache() {
      return new Map(hoisted.metas.map((m) => [m.id, m]));
    }
    close() {
      return Promise.resolve();
    }
  },
}));

describe("background reconcile writes only new or changed transcripts", () => {
  let dir: string;
  let unchanged: string;
  let grown: string;
  let created: string;
  let agent: string;
  let upserted: string[][];
  let tasks: Promise<unknown>[];
  let manager: ScannerManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reconcile-changed-"));
    [unchanged, grown, created, agent] = ["a", "b", "c", "d"].map((n) => {
      const p = join(dir, `${n}.jsonl`);
      writeFileSync(p, "{}\n");
      return p;
    });
    hoisted.metas = [unchanged, grown, created, agent].map((filePath) => ({
      id: filePath,
      filePath,
    }));

    // Cache rows exist for two of the files, one of them out of date. The agent
    // file has no row and never will: the filter hides it.
    const stats = new Map<string, { mtimeMs: number; size: number }>();
    for (const p of [unchanged, grown]) {
      const s = statSync(p);
      stats.set(canonicalizeFilePath(p), { mtimeMs: s.mtimeMs, size: s.size });
    }
    writeFileSync(grown, "{}\n{}\n");

    upserted = [];
    tasks = [];
    const cache = {
      getScannerStatCache: () => new Map(),
      getFileStats: () => stats,
      isAgentFileFiltered: (filePath: string) => filePath === agent,
      upsertFromScannerMeta: (metas: Array<{ filePath: string }>) => {
        upserted.push(metas.map((m) => m.filePath));
        return [];
      },
      reconcileDeletions: () => {},
    };
    manager = new ScannerManager({
      scanProfiles: [],
      codexRoots: [],
      cursorRoots: [],
      directoryDebounceMs: 0,
      persistenceDisabled: false,
      cache: () => cache as never,
      cacheMonitor: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      cacheMetadataRepo: () => null,
      trackCacheWrite: (task) => tasks.push(task),
    });
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips a transcript whose stat matches its cached row, and a filtered agent file", async () => {
    manager.startBackgroundReconcile("full");
    await Promise.all(tasks);

    expect(upserted).toEqual([[grown, created]]);
  });

  it("still writes every transcript on an explicit refresh", async () => {
    await manager.reconcileFromDisk();

    expect(upserted).toEqual([[unchanged, grown, created, agent]]);
  });
});
