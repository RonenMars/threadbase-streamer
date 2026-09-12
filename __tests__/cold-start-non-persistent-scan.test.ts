import { ScannerManager } from "../src/scanner-manager";

/**
 * Captures what each ConversationScanner was constructed with. The scanner is
 * mocked rather than driven for real because the defect is entirely in the
 * constructor argument: a persistent scanner reads its own index, and on a
 * cold start that index is the only thing it can read.
 */
const hoisted = vi.hoisted(() => ({ ctorArgs: [] as unknown[] }));

vi.mock("@threadbase-sh/scanner", () => ({
  ConversationScanner: class {
    constructor(options?: unknown) {
      hoisted.ctorArgs.push(options);
    }
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

/** persistenceDisabled:false is the normal case — the flag only flips when cache.open() throws. */
const makeManager = () =>
  new ScannerManager({
    scanProfiles: [],
    codexRoots: [],
    directoryDebounceMs: 0,
    persistenceDisabled: false,
    // No cache at all is the same condition an emptied cache.db produces:
    // buildStatCache returns undefined, so nothing forced persistent:false.
    cache: () => null,
    cacheMonitor: () => null,
    projectsRepo: () => null,
    conversationsRepo: () => null,
    cacheMetadataRepo: () => null,
    trackCacheWrite: () => {},
  });

describe("cold-start scans never use the scanner's persistent index", () => {
  beforeEach(() => {
    hoisted.ctorArgs.length = 0;
  });

  it("builds a non-persistent scanner when there is no stat cache", async () => {
    const manager = makeManager();
    await manager.get();

    expect(hoisted.ctorArgs.length).toBeGreaterThan(0);
    for (const args of hoisted.ctorArgs) {
      expect(args).toEqual({ persistent: false });
    }
    await manager.close();
  });

  it("builds a non-persistent scanner for a full rescan with no stat cache", async () => {
    const manager = makeManager();
    hoisted.ctorArgs.length = 0;
    await manager.getFresh();

    expect(hoisted.ctorArgs.length).toBeGreaterThan(0);
    for (const args of hoisted.ctorArgs) {
      expect(args).toEqual({ persistent: false });
    }
    await manager.close();
  });

  it("never constructs a scanner with undefined options, which defaults to persistent", async () => {
    const manager = makeManager();
    await manager.get();
    await manager.getFresh();

    expect(hoisted.ctorArgs).not.toContain(undefined);
    await manager.close();
  });
});
