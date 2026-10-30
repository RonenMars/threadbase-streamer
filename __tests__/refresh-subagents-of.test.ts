import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ScannerManager } from "../src/scanner-manager";
import { canonicalizeFilePath } from "../src/utils/canonicalizeFilePath";

// A parent's `subagents/` dir gets no watch once the box is at the fs.watch
// ceiling, so `?parent=` re-reads it: new and grown children reach the cache,
// unchanged ones cost nothing.
describe("ScannerManager.refreshSubagentsOf", () => {
  let dir: string;
  let parent: string;
  let stats: Map<string, { mtimeMs: number; size: number }>;
  let manager: ScannerManager;
  let reconcile: ReturnType<typeof vi.fn>;

  const child = (name: string, body = "{}\n") => {
    const p = join(dir, "parent", "subagents", name);
    writeFileSync(p, body);
    return p;
  };
  const known = (p: string) => {
    const s = statSync(p);
    stats.set(canonicalizeFilePath(p), { mtimeMs: s.mtimeMs, size: s.size });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "refresh-subagents-of-"));
    parent = join(dir, "parent.jsonl");
    writeFileSync(parent, "{}\n");
    mkdirSync(join(dir, "parent", "subagents"), { recursive: true });
    stats = new Map();
    const cache = { getFileStats: () => stats, isAgentFileFiltered: () => false };
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
      trackCacheWrite: () => {},
    });
    reconcile = vi.fn(async () => {});
    (
      manager as unknown as { reconcileStaleFilesFromDisk: typeof reconcile }
    ).reconcileStaleFilesFromDisk = reconcile;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reconciles children the cache has no row for or is behind on", async () => {
    const fresh = child("agent-new.jsonl");
    const grown = child("agent-grown.jsonl");
    known(grown);
    writeFileSync(grown, "{}\n{}\n");
    known(child("agent-same.jsonl"));
    child("agent-same.meta.json");

    await manager.refreshSubagentsOf(parent);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect([...reconcile.mock.calls[0][0]].sort()).toEqual([grown, fresh].sort());
  });

  it("does nothing when every child is current or there is no subagents dir", async () => {
    known(child("agent-same.jsonl"));
    await manager.refreshSubagentsOf(parent);
    await manager.refreshSubagentsOf(join(dir, "no-such-parent.jsonl"));
    expect(reconcile).not.toHaveBeenCalled();
  });
});
