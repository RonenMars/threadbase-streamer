import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { ConversationCache } from "../src/conversation-cache";
import {
  canonicalizeFilePath,
  canonicalLivePathSet,
  joinStatCacheByNativePath,
  toNativeFilePath,
} from "../src/utils/canonicalizeFilePath";

// The scanner emits native-separator paths; every cache key is canonical
// (forward slashes). Joining the two without normalizing fails silently — an
// empty map or a false, never a throw — and is invisible on POSIX, where both
// forms are identical.
//
// Every assertion here is therefore about a join SUCCEEDING, never about which
// separator a string contains: a separator assertion passes vacuously on the
// platform whose native separator already matches.
describe("scanner/cache file-path boundary", () => {
  let dir: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-path-boundary-"));
    cache = ConversationCache.open(join(dir, "cache.db"));
  });

  afterEach(() => {
    cache.close();
  });

  function writeConv(id: string): string {
    const projDir = join(dir, "projects", "-tmp-boundary");
    mkdirSync(projDir, { recursive: true });
    const filePath = join(projDir, `${id}.jsonl`);
    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: "user",
        uuid: `${id}-1`,
        timestamp: "2026-06-05T08:00:00.000Z",
        sessionId: id,
        cwd: "/tmp/boundary",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );
    return filePath;
  }

  it("round-trips a native path through canonical form and back", () => {
    const nativePath = writeConv("round-trip");
    expect(toNativeFilePath(canonicalizeFilePath(nativePath))).toBe(nativePath);
  });

  // The bug this file exists for: a scanner-shaped (native) path must resolve
  // to the row a scanner upsert wrote under its canonical key.
  it("resolves a native scanner path to the canonically-stored cache row", () => {
    const nativePath = writeConv("native-lookup");
    cache.upsertFromScannerMeta([
      {
        id: "native-lookup",
        filePath: nativePath,
        projectPath: "/tmp/boundary",
        projectName: "boundary",
        messageCount: 1,
        lastActivity: "2026-06-05T08:00:00.000Z",
      },
    ] as never);

    // Looked up by the native form the scanner would hand us.
    expect(cache.getIdByFilePath(nativePath)).toBe("native-lookup");
    // …and by the canonical form a watcher key would carry. Both must hit the
    // same row; on Windows these are different strings.
    expect(cache.getIdByFilePath(canonicalizeFilePath(nativePath))).toBe("native-lookup");
  });

  // getFileStats() is keyed canonically. buildStatCache joins it against the
  // scanner's native metas, so the canonical form of a native path must be
  // present as a key — this is the lookup that silently missed on Windows.
  it("exposes stat rows under a key the canonical form of a native path matches", () => {
    const nativePath = writeConv("stat-join");
    cache.upsertFromScannerMeta([
      {
        id: "stat-join",
        filePath: nativePath,
        projectPath: "/tmp/boundary",
        projectName: "boundary",
        messageCount: 1,
        lastActivity: "2026-06-05T08:00:00.000Z",
        mtimeMs: 1_000,
        fileSize: 42,
      },
    ] as never);

    const stats = cache.getFileStats();
    expect(stats.size).toBeGreaterThan(0);
    // The join buildStatCache performs.
    expect(stats.get(canonicalizeFilePath(nativePath))).toBeDefined();
  });

  // reconcileDeletions compares livePaths against canonical rows. A live file
  // whose path arrives in native form must be recognised as live — the
  // existsSync backstop is stubbed false so a miss would delete the row.
  it("treats a canonicalized scanner path as live during reconcile", () => {
    const nativePath = writeConv("live-row");
    cache.upsertFromScannerMeta([
      {
        id: "live-row",
        filePath: nativePath,
        projectPath: "/tmp/boundary",
        projectName: "boundary",
        messageCount: 1,
        lastActivity: "2026-06-05T08:00:00.000Z",
      },
    ] as never);

    const livePaths = new Set([canonicalizeFilePath(nativePath)]);
    // exists() forced false: without a livePaths hit the row would be dropped,
    // so this asserts the membership test itself matched.
    const removed = cache.reconcileDeletions(livePaths, { exists: () => false });
    expect(removed).not.toContain("live-row");
    expect(cache.getIdByFilePath(nativePath)).toBe("live-row");
  });

  // Guard the inverse: a row genuinely absent from the snapshot and gone from
  // disk still gets removed, so the fix above cannot mask real deletions.
  it("still removes a row that is neither live nor on disk", () => {
    const nativePath = writeConv("dead-row");
    cache.upsertFromScannerMeta([
      {
        id: "dead-row",
        filePath: nativePath,
        projectPath: "/tmp/boundary",
        projectName: "boundary",
        messageCount: 1,
        lastActivity: "2026-06-05T08:00:00.000Z",
      },
    ] as never);

    const removed = cache.reconcileDeletions(new Set<string>(), { exists: () => false });
    expect(removed).toContain("dead-row");
  });

  // Documents the platform asymmetry that makes the whole class invisible on
  // POSIX, so a future reader knows why these tests look redundant there.
  it("only diverges where the native separator is not a forward slash", () => {
    const nativePath = writeConv("asymmetry");
    const canonical = canonicalizeFilePath(nativePath);
    if (sep === "/") {
      expect(canonical).toBe(nativePath);
    } else {
      expect(canonical).not.toBe(nativePath);
    }
  });
});

// The two joins PR #253 broke. These use a hard-coded Windows-shaped path and a
// stubbed cache rather than real files, so they exercise the mismatch on EVERY
// platform — on Linux a backslash path is not a native path, so the canonical
// and raw forms still differ and the join is still under test. Without that,
// these would be no-ops on the only OS CI actually runs.
describe("scanner/cache joins (platform-independent)", () => {
  const WIN_PATH = "C:\\Users\\dev\\.claude\\projects\\-tmp-proj\\conv-1.jsonl";
  const CANONICAL = "C:/Users/dev/.claude/projects/-tmp-proj/conv-1.jsonl";

  it("canonicalizeFilePath maps the native form onto the stored form", () => {
    expect(canonicalizeFilePath(WIN_PATH)).toBe(CANONICAL);
  });

  // Site 2: livePaths must be canonical, or reconcileDeletions' membership test
  // misses every row and the existsSync backstop becomes the only guard.
  it("canonicalLivePathSet emits keys that match canonical cache rows", () => {
    const live = canonicalLivePathSet([
      { filePath: WIN_PATH },
      { filePath: null },
      { filePath: undefined },
    ]);
    expect(live.has(CANONICAL)).toBe(true);
    expect(live.size).toBe(1);
  });

  // Site 1: buildStatCache hands its map to scanner.scan({ statCache }), and the
  // scanner looks entries up by its own native filePath. The join is therefore
  // done in canonical form but the result must be keyed native.
  //
  // Tested against the extracted pure function rather than through
  // StreamerServer: constructing the server opens a real database connection,
  // which made an earlier version of this test take 21s and flake.
  it("joinStatCacheByNativePath keys the result by the path the scanner looks up", () => {
    const meta = { id: "conv-1", filePath: WIN_PATH };
    const canonicalStats = new Map([[CANONICAL, { mtimeMs: 1_000, size: 42 }]]);

    const joined = joinStatCacheByNativePath([meta], canonicalStats);

    expect(joined.size).toBe(1);
    // The scanner will look up by its own native path — that exact key must hit.
    expect(joined.get(WIN_PATH)).toBeDefined();
    expect(joined.get(WIN_PATH)?.stat).toEqual({ mtimeMs: 1_000, size: 42 });
    expect(joined.get(WIN_PATH)?.meta).toBe(meta);
  });

  it("joinStatCacheByNativePath drops metas with no matching stat row", () => {
    const joined = joinStatCacheByNativePath(
      [{ filePath: WIN_PATH }, { filePath: null }, { filePath: "C:\\other\\unmatched.jsonl" }],
      new Map([[CANONICAL, { mtimeMs: 1, size: 2 }]]),
    );
    expect(joined.size).toBe(1);
    expect(joined.has(WIN_PATH)).toBe(true);
  });

  it("toNativeFilePath re-keys a canonical path for the scanner", () => {
    expect(toNativeFilePath(CANONICAL)).toBe(
      join("C:", "Users", "dev", ".claude", "projects", "-tmp-proj", "conv-1.jsonl"),
    );
  });
});
