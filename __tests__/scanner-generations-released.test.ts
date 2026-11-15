import { ScannerManager } from "../src/scanner-manager";

vi.mock("@threadbase-sh/scanner", () => ({
  ConversationScanner: class {
    scan() {
      return Promise.resolve([]);
    }
    getMetadataCache() {
      return new Map();
    }
    close() {
      return Promise.resolve();
    }
  },
}));

describe("a full rescan does not keep every earlier scanner reachable", () => {
  it("holds one scanner after several refreshes", async () => {
    const manager = new ScannerManager({
      scanProfiles: [],
      codexRoots: [],
      cursorRoots: [],
      directoryDebounceMs: 0,
      persistenceDisabled: false,
      cache: () => null,
      cacheMonitor: () => null,
      projectsRepo: () => null,
      conversationsRepo: () => null,
      cacheMetadataRepo: () => null,
      trackCacheWrite: () => {},
    });
    for (let i = 0; i < 5; i++) await manager.rescanForRefresh();
    expect((manager as unknown as { allScanners: Set<unknown> }).allScanners.size).toBe(1);
  });
});
