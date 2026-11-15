import { ScannerManager } from "../src/scanner-manager";

let scans = 0;
let release: () => void;

vi.mock("@threadbase-sh/scanner", () => ({
  ConversationScanner: class {
    scan() {
      scans++;
      return new Promise<never[]>((resolve) => {
        release = () => resolve([]);
      });
    }
    getMetadataCache() {
      return new Map();
    }
    close() {
      return Promise.resolve();
    }
  },
}));

describe("explicit ?refresh=1 reconcile is single-flighted", () => {
  const make = () => {
    const cache = {
      getScannerStatCache: () => new Map(),
      getFileStats: () => new Map(),
      isAgentFileFiltered: () => false,
      upsertFromScannerMeta: () => [],
      reconcileDeletions: () => {},
    };
    return new ScannerManager({
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
  };

  beforeEach(() => {
    scans = 0;
  });

  it("concurrent callers share one scan, and a later call starts a new one", async () => {
    const manager = make();
    const calls = [
      manager.reconcileExplicit(),
      manager.reconcileExplicit(),
      manager.reconcileExplicit(),
    ];
    await vi.waitFor(() => expect(scans).toBe(1));
    release();
    await Promise.all(calls);
    expect(scans).toBe(1);

    const next = manager.reconcileExplicit();
    await vi.waitFor(() => expect(scans).toBe(2));
    release();
    await next;
  });
});
