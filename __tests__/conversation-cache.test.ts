import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `conv-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"), 3);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const BASE_META = {
  id: "abc-123",
  sessionId: "abc-123",
  filePath: "/home/.claude/projects/proj/abc-123.jsonl",
  projectPath: "/home/proj",
  projectName: "My Project",
  title: "My Project",
  model: "claude-3-5-sonnet",
  account: "acc1",
  gitBranch: "main",
  messageCount: 2,
  timestamp: "2024-01-01T10:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: "Hello",
};

describe("open()", () => {
  it("creates tables idempotently (opening same db twice does not throw)", () => {
    const cache2 = ConversationCache.open(join(dbDir, "cache.db"), 3);
    cache2.close();
  });
});

describe("upsertFromScannerMeta()", () => {
  it("inserts a new row", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });

  it("inserts multiple rows in batch", () => {
    const metas = [
      { ...BASE_META, id: "id-1", sessionId: "id-1", filePath: "/p/id-1.jsonl" },
      { ...BASE_META, id: "id-2", sessionId: "id-2", filePath: "/p/id-2.jsonl" },
      { ...BASE_META, id: "id-3", sessionId: "id-3", filePath: "/p/id-3.jsonl" },
    ];
    cache.upsertFromScannerMeta(metas as any);
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("does not overwrite a row updated within 24h", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:01:00.000Z",
        content: [{ type: "text", text: "new message" }],
      }),
    );
    cache.upsertFromScannerMeta([BASE_META as any]);
    const result = cache.listConversations({ limit: 10, offset: 0 });
    expect(result.conversations[0].messageCount).toBe(3);
  });

  // Regression: warm-up in server.ts iterates the SAME metas it just passed
  // to upsertFromScannerMeta and calls populateTailFromFile(id, filePath) on
  // every one. When an agent JSONL is in the input, the upsert silently
  // skipped it but the tail insert still ran, hitting the FK
  // conversation_tail.conversation_id → conversation_meta(id) and crashing
  // the warm-up. The fix is to return the set of IDs that were actually
  // upserted, so callers can warm tails only for those.
  it("returns IDs of upserted rows (excluding agent-filtered files)", () => {
    const agentDir = join(dbDir, "agent-fixtures");
    mkdirSync(agentDir, { recursive: true });
    const agentFile = join(agentDir, "agent-1.jsonl");
    const normalFile = join(agentDir, "normal-1.jsonl");
    // Agent file has the `entrypoint: "sdk-cli"` marker that isAgentFile detects.
    writeFileSync(agentFile, `${JSON.stringify({ entrypoint: "sdk-cli", type: "summary" })}\n`);
    writeFileSync(normalFile, `${JSON.stringify({ type: "summary" })}\n`);

    const agentCache = ConversationCache.open(join(dbDir, "filtered.db"), 3, undefined, {
      filterAgentConversations: true,
    });
    try {
      const ids = agentCache.upsertFromScannerMeta([
        { ...BASE_META, id: "normal-1", sessionId: "normal-1", filePath: normalFile },
        { ...BASE_META, id: "agent-1", sessionId: "agent-1", filePath: agentFile },
      ] as any);
      expect(ids).toEqual(["normal-1"]);
      // And confirm the agent row genuinely is not in conversation_meta —
      // so a follow-up populateTailFromFile("agent-1", ...) would hit FK.
      expect(agentCache.hasConversation("normal-1")).toBe(true);
      expect(agentCache.hasConversation("agent-1")).toBe(false);
    } finally {
      agentCache.close();
    }
  });

  // Regression for the "Warm-up: N/M tail populates skipped" boot log.
  //
  // Diagnosis: it is a BENIGN race, not an id-mismatch. The id the warm-up
  // loop derives is identical to the one upsertFromScannerMeta inserts, so the
  // parent conversation_meta row genuinely exists right after the upsert. But
  // the live ConversationWatcher runs concurrently during warm-up, and an
  // active session writing/deleting its JSONL fires invalidate(id), which
  // deletes that conversation_meta row mid-loop. The follow-up
  // populateTailFromFile() then trips the conversation_tail → conversation_meta
  // FK. The warm-up swallows it (so pruneGhostFiles can still run), which is
  // correct: the row is re-upserted on the next scan and prune reconciles any
  // genuinely-deleted file. This test pins that contract down.
  it("populateTailFromFile after the meta row is invalidated mid-warmup is skipped without orphaning the tail", () => {
    const dir = join(dbDir, "warmup-race");
    mkdirSync(dir, { recursive: true });
    const racedFile = join(dir, "raced.jsonl");
    const healthyFile = join(dir, "healthy.jsonl");
    const line = JSON.stringify({
      role: "user",
      timestamp: "2024-01-01T10:00:00.000Z",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    writeFileSync(racedFile, `${line}\n`);
    writeFileSync(healthyFile, `${line}\n`);

    // Both rows are upserted, exactly as warm-up's upsertFromScannerMeta does.
    const ids = cache.upsertFromScannerMeta([
      { ...BASE_META, id: "raced", sessionId: "raced", filePath: racedFile },
      { ...BASE_META, id: "healthy", sessionId: "healthy", filePath: healthyFile },
    ] as any);
    expect(ids).toEqual(["raced", "healthy"]);

    // The concurrent ConversationWatcher deletes the parent row for "raced"
    // (invalidate(id) is exactly what onConversationChanged/onFileDeleted call).
    cache.invalidate("raced");

    // Reproduce the exact throw: the file is still readable, but the FK has no
    // parent, so the tail insert raises SQLITE_CONSTRAINT_FOREIGNKEY.
    expect(() => cache.populateTailFromFile("raced", racedFile)).toThrow(/FOREIGN KEY/);

    // Warm-up's swallow-and-continue: one bad row must not abort the loop, and
    // the healthy row must still get its tail.
    const targets = [
      { id: "raced", filePath: racedFile },
      { id: "healthy", filePath: healthyFile },
    ];
    let tailFailures = 0;
    for (const t of targets) {
      try {
        cache.populateTailFromFile(t.id, t.filePath);
      } catch {
        tailFailures += 1;
      }
    }
    expect(tailFailures).toBe(1);
    expect(cache.getConversationTail("healthy")?.messages.length).toBe(1);

    // The raced row left no orphan: no parent meta, no tail.
    expect(cache.hasConversation("raced")).toBe(false);
    expect(cache.getConversationTail("raced")).toBeNull();

    // pruneGhostFiles runs right after warm-up and reconciles cleanly — the
    // healthy row survives, and nothing is left dangling for the raced one.
    const pruned = cache.pruneGhostFiles();
    expect(pruned).not.toContain("raced");
    expect(cache.hasConversation("healthy")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for two CRITICAL cache bugs found in the 2026-07-04 review.
// Both encode the intended contract, not the present (buggy) behavior.
// See CODE-REVIEW-2026-07-04.md #1 and #2.
// ---------------------------------------------------------------------------

describe("CRITICAL #1 — rescan must still update metadata after a conversation goes live", () => {
  // Bug: upsertFromScannerMeta writes updated_at:0 (conversation-cache.ts:656),
  // while the upsert is guarded by `WHERE conversation_meta.updated_at <
  // excluded.updated_at` (:290). Live tailing stamps updated_at with a
  // Date.now()-seeded tailSeq (:178), so once ANY live line has landed, every
  // later scanner upsert (0 < huge) loses the guard and silently no-ops — the
  // scanner's authoritative fields (title/model/branch/message_count/mtime/size)
  // freeze for the process lifetime.
  //
  // The existing "does not overwrite a row updated within 24h" test masks this:
  // it only asserts messageCount, which the LIVE update already bumped, so it
  // passes whether or not the scanner rewrite lands. This test instead asserts
  // on fields ONLY the scanner rewrite can change.
  it("applies a later scanner rescan (new title/model/branch) after a live line", () => {
    // 1. Initial scanner index.
    cache.upsertFromScannerMeta([
      { ...BASE_META, title: "Old Title", model: "old-model", gitBranch: "main" } as any,
    ]);

    // 2. A live line arrives (as ConversationWatcher.onNewLines → updateFromLines
    //    would deliver it). This stamps updated_at with the huge tailSeq value.
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "live message" }],
      }),
    );

    // 3. A later full rescan re-derives the conversation with corrected
    //    metadata (e.g. the branch changed mid-conversation, the model was
    //    resolved, the title was derived). This is exactly what warm-up,
    //    ?refresh=1, and the background count rescan all call.
    cache.upsertFromScannerMeta([
      { ...BASE_META, title: "New Title", model: "new-model", gitBranch: "feature/x" } as any,
    ]);

    // The rescan's values must win — a conversation going live must not freeze
    // its scanner-owned metadata forever.
    const meta = cache.getMetaById("abc-123");
    expect(meta?.title).toBe("New Title");
    expect(meta?.model).toBe("new-model");
    expect(meta?.branch).toBe("feature/x");
  });
});

describe("CRITICAL #2 — a directory-watch invalidate must not delete a freshly live-tailed row", () => {
  // Bug: every managed session's JSONL is watched TWICE — individually
  // (onNewLines → updateFromLines, an upsert) and via the project-directory
  // watcher (onConversationChanged → invalidateByFilePath, which deletes the
  // conversation_meta + conversation_tail rows, conversation-cache.ts:902-919).
  // chokidar fires BOTH on the same append with no ordering guarantee. When the
  // invalidate lands last, the just-cached row is deleted right after being
  // written, so the conversation vanishes from /api/conversations and Recents
  // until the ~1s debounced rescan repairs it — a flicker on nearly every
  // message of an active session.
  //
  // This test reproduces the exact "invalidate wins the race" interleaving that
  // the two watcher callbacks in server.ts (258-330) can produce, operating on
  // the ConversationCache unit both callbacks mutate. It is expected to FAIL:
  // after the sequence, the live row should still be present and correct.
  it("keeps the row after: scanner upsert → live append → directory-change invalidate", () => {
    // 1. Scanner has indexed the conversation.
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);

    // 2. A live line is appended and tailed (onNewLines path).
    cache.updateFromLines(BASE_META.filePath, [
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "live message" }],
      }),
    ]);
    expect(cache.hasConversation("abc-123")).toBe(true);

    // 3. The SAME fs append also reaches the directory watcher, whose handler
    //    (onConversationChanged) calls invalidateByFilePath with skipIfTailed
    //    — and here it lands AFTER the tail write (the unspecified-order race
    //    resolving the "bad" way).
    cache.invalidateByFilePath(BASE_META.filePath, { skipIfTailed: true });

    // The conversation must survive a live append. Deleting it on every message
    // (to be re-created only by a later debounced rescan) is the bug.
    expect(cache.hasConversation("abc-123")).toBe(true);
    expect(cache.getMetaById("abc-123")?.messageCount).toBe(3);
  });
});

describe("reconcileDeletions() — refresh=1's remove-what-vanished half", () => {
  const OTHER_META = {
    ...BASE_META,
    id: "gone-456",
    sessionId: "gone-456",
    filePath: "/home/.claude/projects/proj/gone-456.jsonl",
  };

  it("drops rows whose file was deleted from disk, keeps the rest", () => {
    cache.upsertFromScannerMeta([BASE_META as any, OTHER_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
    expect(cache.hasConversation("gone-456")).toBe(true);

    // A fresh scan only surfaces BASE_META's file; gone-456's JSONL was deleted
    // from disk. reconcileDeletions must drop the stale row.
    const exists = (fp: string) => fp === BASE_META.filePath; // gone-456 gone
    const removed = cache.reconcileDeletions(new Set([BASE_META.filePath]), { exists });

    expect(removed).toEqual(["gone-456"]);
    expect(cache.hasConversation("abc-123")).toBe(true);
    expect(cache.hasConversation("gone-456")).toBe(false);
  });

  it("removes a deleted-from-disk row even if it still has a cached tail", () => {
    // A conversation that went live (has a tail) but whose file was then deleted
    // must still disappear on refresh — refresh=1 has to be truthful about
    // removals. This matches the old invalidate()+rebuild behavior, where a
    // deleted file simply wasn't re-added regardless of any cached tail.
    cache.upsertFromScannerMeta([OTHER_META as any]);
    cache.updateFromLines(OTHER_META.filePath, [
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "was live, now deleted" }],
      }),
    ]);
    expect(cache.getConversationTail("gone-456")).not.toBeNull();

    const removed = cache.reconcileDeletions(new Set(), { exists: () => false });

    expect(removed).toContain("gone-456");
    expect(cache.hasConversation("gone-456")).toBe(false);
  });

  // Regression mirroring CRITICAL #2 for the Stage 3 reconcile path: a
  // refresh=1 computes livePaths from a scan SNAPSHOT, then upserts +
  // reconcileDeletions. If a brand-new live session's file is created AFTER that
  // snapshot but BEFORE reconcileDeletions runs, its path is absent from
  // livePaths. Because the file still EXISTS on disk, it must not be removed —
  // dropping it would flicker the just-created (live-tailed) conversation out of
  // /api/conversations. The next reconcile (fresh scan) includes it in livePaths.
  it("does not delete a still-on-disk row missing from the scan snapshot", () => {
    // Scan snapshot only knew about BASE_META.
    cache.upsertFromScannerMeta([BASE_META as any]);

    // Concurrently, a new live session starts: its row is upserted and tailed.
    cache.upsertFromScannerMeta([OTHER_META as any]);
    cache.updateFromLines(OTHER_META.filePath, [
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "live message on a brand-new session" }],
      }),
    ]);

    // Reconcile with the stale snapshot (no gone-456), but gone-456's file
    // exists on disk (it's a live session mid-write).
    const exists = (fp: string) => fp === BASE_META.filePath || fp === OTHER_META.filePath;
    const removed = cache.reconcileDeletions(new Set([BASE_META.filePath]), { exists });

    expect(removed).not.toContain("gone-456");
    expect(cache.hasConversation("gone-456")).toBe(true);
  });
});

describe("updateFromLine()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([BASE_META as any]);
  });

  it("increments message_count by 1", () => {
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:01:00.000Z",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(3);
  });

  it("updates last_activity to the line timestamp", () => {
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "assistant",
        timestamp: "2024-06-15T08:30:00.000Z",
        content: [{ type: "text", text: "reply" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].lastActivity).toBe("2024-06-15T08:30:00.000Z");
  });

  it("appends messages to tail and trims to tailSize (3)", () => {
    for (let i = 0; i < 5; i++) {
      cache.updateFromLine(
        BASE_META.filePath,
        JSON.stringify({
          role: "user",
          timestamp: `2024-01-0${i + 2}T00:00:00.000Z`,
          content: [{ type: "text", text: `msg ${i}` }],
        }),
      );
    }
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail?.messages).toHaveLength(3);
    expect(tail?.messages[2].text).toContain("msg 4");
  });

  it("ignores lines that are not valid JSON", () => {
    cache.updateFromLine(BASE_META.filePath, "not json at all");
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(2);
  });

  it("does not throw for an unknown file path", () => {
    expect(() => {
      cache.updateFromLine(
        "/unknown/path.jsonl",
        JSON.stringify({
          role: "user",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: [{ type: "text", text: "msg" }],
        }),
      );
    }).not.toThrow();
  });

  it("handles a string message.content (legacy Claude JSONL shape)", () => {
    expect(() => {
      cache.updateFromLine(
        BASE_META.filePath,
        JSON.stringify({
          role: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: { content: "raw string content, not an array" },
        }),
      );
    }).not.toThrow();
    const tail = cache.getConversationTail("abc-123");
    expect(tail?.messages[tail.messages.length - 1].text).toContain("raw string");
  });
});

describe("updateFromLine() — project backfill from cwd/slug", () => {
  const PSEUDO_ID = "9f4a-skeleton";
  const NEW_FILE = `/home/.claude/projects/-proj-new/${PSEUDO_ID}.jsonl`;

  it("backfills project_path / project_name / title from cwd on the first message line", () => {
    cache.updateFromLine(
      NEW_FILE,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        cwd: "/Users/me/dev/my-project",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    const row = list.conversations.find((c) => c.id === PSEUDO_ID);
    expect(row).toBeDefined();
    expect(row?.projectPath).toBe("/Users/me/dev/my-project");
    expect(row?.projectName).toBe("me/dev/my-project");
    expect(row?.title).toBe("me/dev/my-project");
  });

  it("backfills from a non-user/assistant line that carries cwd (e.g. attachment)", () => {
    cache.updateFromLine(
      NEW_FILE,
      JSON.stringify({
        type: "attachment",
        timestamp: "2024-01-01T09:59:00.000Z",
        cwd: "/Users/me/dev/my-project",
        sessionId: PSEUDO_ID,
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    const row = list.conversations.find((c) => c.id === PSEUDO_ID);
    expect(row).toBeDefined();
    expect(row?.projectPath).toBe("/Users/me/dev/my-project");
    expect(row?.messageCount).toBe(1); // skeleton insert; not bumped by attachment
  });

  it("prefers slug over derived projectName for title when slug is present", () => {
    cache.updateFromLine(
      NEW_FILE,
      JSON.stringify({
        type: "attachment",
        cwd: "/Users/me/dev/my-project",
        slug: "fix-the-foo-bug",
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    const row = list.conversations.find((c) => c.id === PSEUDO_ID);
    expect(row?.title).toBe("fix-the-foo-bug");
    expect(row?.projectName).toBe("me/dev/my-project");
  });

  it("never overwrites a scanner-populated project_path", () => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: PSEUDO_ID,
        sessionId: PSEUDO_ID,
        filePath: NEW_FILE,
        projectPath: "/scanner/wins",
        projectName: "scanner/wins",
        title: "scanner/wins",
      } as never,
    ]);
    cache.updateFromLine(
      NEW_FILE,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        cwd: "/Users/me/dev/different",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    const row = list.conversations.find((c) => c.id === PSEUDO_ID);
    expect(row?.projectPath).toBe("/scanner/wins");
    expect(row?.projectName).toBe("scanner/wins");
  });

  it("ignores lines with neither a message role nor cwd/slug", () => {
    cache.updateFromLine(
      NEW_FILE,
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
    );
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations.find((c) => c.id === PSEUDO_ID)).toBeUndefined();
  });
});

describe("listConversations()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: "conv-a",
        sessionId: "conv-a",
        filePath: "/p/a.jsonl",
        projectPath: "/proj/alpha",
        projectName: "Alpha",
        timestamp: "2024-03-01T00:00:00.000Z",
      },
      {
        ...BASE_META,
        id: "conv-b",
        sessionId: "conv-b",
        filePath: "/p/b.jsonl",
        projectPath: "/proj/beta",
        projectName: "Beta",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        ...BASE_META,
        id: "conv-c",
        sessionId: "conv-c",
        filePath: "/p/c.jsonl",
        projectPath: "/proj/alpha",
        projectName: "Alpha",
        timestamp: "2024-06-01T00:00:00.000Z",
      },
    ] as any);
  });

  it("returns total count", () => {
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("returns total without rows when limit is 0", () => {
    const r = cache.listConversations({ limit: 0, offset: 0 });
    expect(r.total).toBe(3);
    expect(r.conversations).toHaveLength(0);
  });

  it("filters by project", () => {
    const r = cache.listConversations({ limit: 10, offset: 0, project: "/proj/alpha" });
    expect(r.total).toBe(2);
    expect(r.conversations.every((c) => c.projectPath === "/proj/alpha")).toBe(true);
  });

  it("paginates correctly", () => {
    const page1 = cache.listConversations({ limit: 2, offset: 0 });
    const page2 = cache.listConversations({ limit: 2, offset: 2 });
    expect(page1.conversations).toHaveLength(2);
    expect(page2.conversations).toHaveLength(1);
  });

  it("sorts by last_activity descending by default", () => {
    const r = cache.listConversations({ limit: 10, offset: 0 });
    const times = r.conversations.map((c) => new Date(c.lastActivity).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });
});

describe("getConversationTail()", () => {
  it("returns null for unknown id", () => {
    expect(cache.getConversationTail("nonexistent")).toBeNull();
  });

  it("returns null when conversation exists but has no tail", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.getConversationTail("abc-123")).toBeNull();
  });

  it("returns messages after updateFromLine calls", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        content: [{ type: "text", text: "hello" }],
      }),
    );
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail?.messages).toHaveLength(1);
    expect(tail?.messages[0].role).toBe("user");
    expect(tail?.messages[0].text).toBe("hello");
  });
});

describe("populateTailFromFile()", () => {
  let jsonlPath: string;

  beforeEach(() => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    jsonlPath = join(dbDir, "abc-123.jsonl");
  });

  it("returns false for a non-existent file", () => {
    expect(cache.populateTailFromFile("abc-123", "/no/such/file.jsonl")).toBe(false);
  });

  it("returns false when tail already exists", () => {
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({ role: "user", timestamp: "2024-01-01T00:00:00.000Z", content: [] })}\n`,
    );
    cache.populateTailFromFile("abc-123", jsonlPath);
    expect(cache.populateTailFromFile("abc-123", jsonlPath)).toBe(false);
  });

  it("reads last tailSize lines and writes tail", () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        role: i % 2 === 0 ? "user" : "assistant",
        timestamp: `2024-01-0${i + 1}T00:00:00.000Z`,
        content: [{ type: "text", text: `msg ${i}` }],
      }),
    );
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    const result = cache.populateTailFromFile("abc-123", jsonlPath);
    expect(result).toBe(true);
    const tail = cache.getConversationTail("abc-123");
    expect(tail).not.toBeNull();
    expect(tail?.messages).toHaveLength(3); // tailSize is 3
    expect(tail?.messages[2].text).toBe("msg 4");
  });

  it("skips lines without a role or type field", () => {
    const lines = [
      JSON.stringify({ no_role: true, timestamp: "2024-01-01T00:00:00.000Z" }),
      JSON.stringify({ role: "user", timestamp: "2024-01-02T00:00:00.000Z", content: [] }),
    ];
    writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
    cache.populateTailFromFile("abc-123", jsonlPath);
    const tail = cache.getConversationTail("abc-123");
    expect(tail?.messages).toHaveLength(1);
    expect(tail?.messages[0].role).toBe("user");
  });

  it("does not overwrite a tail written by updateFromLine", () => {
    writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "from file" }],
      })}\n`,
    );
    // updateFromLine writes updated_at = Date.now() (wins over populateTailFromFile's 0)
    cache.updateFromLine(
      BASE_META.filePath,
      JSON.stringify({
        role: "assistant",
        timestamp: "2024-01-02T00:00:00.000Z",
        content: [{ type: "text", text: "live message" }],
      }),
    );
    // populateTailFromFile skips because tail already exists
    cache.populateTailFromFile("abc-123", jsonlPath);
    const tail = cache.getConversationTail("abc-123");
    expect(tail?.messages[tail?.messages.length - 1].text).toBe("live message");
  });
});

describe("hasConversation()", () => {
  it("returns false for unknown id", () => {
    expect(cache.hasConversation("unknown")).toBe(false);
  });

  it("returns true after upsert", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    expect(cache.hasConversation("abc-123")).toBe(true);
  });
});

describe("getPopularProjects()", () => {
  it("returns projects ranked by conversation count descending", () => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: "p1-a",
        sessionId: "p1-a",
        filePath: "/p/p1-a.jsonl",
        projectPath: "~/my-app",
        projectName: "My App",
      },
      {
        ...BASE_META,
        id: "p1-b",
        sessionId: "p1-b",
        filePath: "/p/p1-b.jsonl",
        projectPath: "~/my-app",
        projectName: "My App",
      },
      {
        ...BASE_META,
        id: "p1-c",
        sessionId: "p1-c",
        filePath: "/p/p1-c.jsonl",
        projectPath: "~/my-app",
        projectName: "My App",
      },
      {
        ...BASE_META,
        id: "p2-a",
        sessionId: "p2-a",
        filePath: "/p/p2-a.jsonl",
        projectPath: "~/work/api",
        projectName: "API",
      },
      {
        ...BASE_META,
        id: "p2-b",
        sessionId: "p2-b",
        filePath: "/p/p2-b.jsonl",
        projectPath: "~/work/api",
        projectName: "API",
      },
      {
        ...BASE_META,
        id: "p3-a",
        sessionId: "p3-a",
        filePath: "/p/p3-a.jsonl",
        projectPath: null as any,
        projectName: undefined,
      },
    ] as any);
    const result = cache.getPopularProjects(10);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("~/my-app");
    expect(result[0].sessionCount).toBe(3);
    expect(result[1].path).toBe("~/work/api");
    expect(result[1].sessionCount).toBe(2);
  });

  it("falls back to last path segment when projectName is null", () => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: "fe-1",
        sessionId: "fe-1",
        filePath: "/p/fe-1.jsonl",
        projectPath: "~/work/frontend",
        projectName: undefined,
      },
    ] as any);
    const result = cache.getPopularProjects(10);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("frontend");
  });

  it("respects the limit parameter", () => {
    cache.upsertFromScannerMeta([
      {
        ...BASE_META,
        id: "lim-1",
        sessionId: "lim-1",
        filePath: "/p/lim-1.jsonl",
        projectPath: "~/proj-a",
        projectName: "A",
      },
      {
        ...BASE_META,
        id: "lim-2",
        sessionId: "lim-2",
        filePath: "/p/lim-2.jsonl",
        projectPath: "~/proj-b",
        projectName: "B",
      },
      {
        ...BASE_META,
        id: "lim-3",
        sessionId: "lim-3",
        filePath: "/p/lim-3.jsonl",
        projectPath: "~/proj-c",
        projectName: "C",
      },
    ] as any);
    const result = cache.getPopularProjects(2);
    expect(result).toHaveLength(2);
  });
});

describe("invalidate()", () => {
  beforeEach(() => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "inv-1", sessionId: "inv-1", filePath: "/p/inv-1.jsonl" },
      { ...BASE_META, id: "inv-2", sessionId: "inv-2", filePath: "/p/inv-2.jsonl" },
    ] as any);
  });

  it("with no args clears all rows", () => {
    cache.invalidate();
    expect(cache.listConversations({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("with id removes only that row", () => {
    cache.invalidate("inv-1");
    expect(cache.hasConversation("inv-1")).toBe(false);
    expect(cache.hasConversation("inv-2")).toBe(true);
  });

  it("with id also clears the cached tail", () => {
    cache.updateFromLine(
      "/p/inv-1.jsonl",
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        message: { content: [{ type: "text", text: "leaky" }] },
      }),
    );
    expect(cache.getConversationTail("inv-1")?.messages.length).toBe(1);
    cache.invalidate("inv-1");
    expect(cache.getConversationTail("inv-1")).toBeNull();
  });
});

describe("invalidateByFilePath()", () => {
  it("returns null when no row matches", () => {
    expect(cache.invalidateByFilePath("/does/not/exist.jsonl")).toBeNull();
  });

  it("removes the matching row and returns its id", () => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "match-1", sessionId: "match-1", filePath: "/p/match-1.jsonl" },
    ] as any);
    const removed = cache.invalidateByFilePath("/p/match-1.jsonl");
    expect(removed).toBe("match-1");
    expect(cache.hasConversation("match-1")).toBe(false);
  });

  it("removes a TAIL'D row on the unlink path (default, no skipIfTailed)", () => {
    // onFileDeleted → invalidateByFilePath with no opts: a genuinely deleted
    // JSONL must be removed even if it had a cached tail, or it ghosts in
    // /api/conversations. The skipIfTailed guard is for the change path only.
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(BASE_META.filePath, [
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "live message" }],
      }),
    ]);
    expect(cache.getConversationTail("abc-123")).not.toBeNull(); // has a tail

    const removed = cache.invalidateByFilePath(BASE_META.filePath);
    expect(removed).toBe("abc-123");
    expect(cache.hasConversation("abc-123")).toBe(false);
  });

  it("keeps a TAIL'D row on the change path (skipIfTailed: true)", () => {
    // onConversationChanged → invalidateByFilePath({ skipIfTailed: true }): a
    // row a live tail just wrote must survive the directory-change event.
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(BASE_META.filePath, [
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:05:00.000Z",
        content: [{ type: "text", text: "live message" }],
      }),
    ]);

    const removed = cache.invalidateByFilePath(BASE_META.filePath, { skipIfTailed: true });
    expect(removed).toBeNull();
    expect(cache.hasConversation("abc-123")).toBe(true);
  });
});

describe("pruneGhostFiles()", () => {
  it("deletes only the rows whose file_path no longer exists", () => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "live", sessionId: "live", filePath: "/p/live.jsonl" },
      { ...BASE_META, id: "ghost-1", sessionId: "ghost-1", filePath: "/p/ghost-1.jsonl" },
      { ...BASE_META, id: "ghost-2", sessionId: "ghost-2", filePath: "/p/ghost-2.jsonl" },
    ] as any);

    const pruned = cache.pruneGhostFiles((fp) => fp === "/p/live.jsonl");
    expect(pruned.sort()).toEqual(["ghost-1", "ghost-2"]);
    expect(cache.hasConversation("live")).toBe(true);
    expect(cache.hasConversation("ghost-1")).toBe(false);
    expect(cache.hasConversation("ghost-2")).toBe(false);
  });

  it("returns [] when nothing is stale", () => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "live-1", sessionId: "live-1", filePath: "/p/live-1.jsonl" },
    ] as any);
    expect(cache.pruneGhostFiles(() => true)).toEqual([]);
  });

  it("preserves rows that have a cached tail even when the JSONL is missing", () => {
    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "ghost-tail", sessionId: "ghost-tail", filePath: "/p/g.jsonl" },
    ] as any);
    cache.updateFromLine(
      "/p/g.jsonl",
      JSON.stringify({
        role: "user",
        timestamp: "2024-01-01T10:00:00.000Z",
        message: { content: [{ type: "text", text: "tail data" }] },
      }),
    );
    expect(cache.getConversationTail("ghost-tail")?.messages.length).toBe(1);
    expect(cache.pruneGhostFiles(() => false)).toEqual([]);
    expect(cache.hasConversation("ghost-tail")).toBe(true);
    expect(cache.getConversationTail("ghost-tail")?.messages.length).toBe(1);
  });
});

describe("markAsStreamer()", () => {
  it("sets source to 'streamer' on an existing row", () => {
    cache.upsertFromScannerMeta([
      {
        id: "abc-123",
        filePath: "/tmp/abc-123.jsonl",
        messageCount: 1,
        timestamp: new Date().toISOString(),
      },
    ] as any);
    cache.markAsStreamer("abc-123");
    const item = cache.getMetaById("abc-123");
    expect(item?.source).toBe("streamer");
  });

  it("is a no-op (does not throw) when the row does not exist yet", () => {
    expect(() => cache.markAsStreamer("non-existent-id")).not.toThrow();
  });

  it("getMetaById returns null source for un-tagged rows", () => {
    cache.upsertFromScannerMeta([
      {
        id: "xyz-456",
        filePath: "/tmp/xyz-456.jsonl",
        messageCount: 1,
        timestamp: new Date().toISOString(),
      },
    ] as any);
    const item = cache.getMetaById("xyz-456");
    expect(item?.source).toBeNull();
  });
});

describe("getFileStats()", () => {
  it("returns empty map when no rows have stat data", () => {
    cache.upsertFromScannerMeta([{ ...BASE_META }] as any);
    // BASE_META.filePath doesn't exist on disk, so stat is skipped
    const stats = cache.getFileStats();
    expect(stats.size).toBe(0);
  });

  it("stores and returns mtime_ms and file_size for real files", () => {
    const filePath = join(dbDir, "conv.jsonl");
    writeFileSync(filePath, '{"role":"user"}\n');
    const s = statSync(filePath);

    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "stat-test", sessionId: "stat-test", filePath },
    ] as any);

    const stats = cache.getFileStats();
    expect(stats.has(filePath)).toBe(true);
    const entry = stats.get(filePath);
    expect(entry?.mtimeMs).toBe(s.mtimeMs);
    expect(entry?.size).toBe(s.size);
  });

  it("returns only rows with both stat columns populated", () => {
    const filePath = join(dbDir, "real.jsonl");
    writeFileSync(filePath, '{"role":"user"}\n');

    cache.upsertFromScannerMeta([
      { ...BASE_META, id: "has-stat", sessionId: "has-stat", filePath },
      { ...BASE_META, id: "no-stat", sessionId: "no-stat", filePath: "/nonexistent/path.jsonl" },
    ] as any);

    const stats = cache.getFileStats();
    expect(stats.has(filePath)).toBe(true);
    expect(stats.has("/nonexistent/path.jsonl")).toBe(false);
    expect(stats.size).toBe(1);
  });
});

describe("updateFromLines() — batched write", () => {
  const msgLine = (i: number, ts: string) =>
    JSON.stringify({
      role: i % 2 === 0 ? "user" : "assistant",
      timestamp: ts,
      content: [{ type: "text", text: `msg ${i}` }],
    });

  it("increments message_count by the number of message lines", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(BASE_META.filePath, [
      msgLine(0, "2024-01-02T00:00:00.000Z"),
      msgLine(1, "2024-01-02T00:01:00.000Z"),
      msgLine(2, "2024-01-02T00:02:00.000Z"),
    ]);
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(2 + 3);
  });

  it("writes the tail once, trimmed to tailSize, in order", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(
      BASE_META.filePath,
      Array.from({ length: 5 }, (_, i) => msgLine(i, `2024-01-0${i + 2}T00:00:00.000Z`)),
    );
    const tail = cache.getConversationTail("abc-123");
    expect(tail?.messages).toHaveLength(3);
    expect(tail?.messages[0].text).toContain("msg 2");
    expect(tail?.messages[2].text).toContain("msg 4");
  });

  it("sets last_activity to the final message line", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(BASE_META.filePath, [
      msgLine(0, "2024-03-01T00:00:00.000Z"),
      msgLine(1, "2024-06-15T08:30:00.000Z"),
    ]);
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].lastActivity).toBe("2024-06-15T08:30:00.000Z");
  });

  it("skips non-JSON and timestamp-less garbage lines but counts valid ones", () => {
    cache.upsertFromScannerMeta([BASE_META as any]);
    cache.updateFromLines(BASE_META.filePath, [
      "not json",
      msgLine(0, "2024-01-02T00:00:00.000Z"),
      JSON.stringify({ role: "user", timestamp: "nonsense-date", content: [] }),
      msgLine(1, "2024-01-02T00:01:00.000Z"),
    ]);
    const list = cache.listConversations({ limit: 10, offset: 0 });
    expect(list.conversations[0].messageCount).toBe(2 + 2);
  });

  it("backfills project context from a cwd-only line in the batch", () => {
    const file = "/home/.claude/projects/-proj-batch/batch-skel.jsonl";
    cache.updateFromLines(file, [
      JSON.stringify({ cwd: "/Users/me/dev/batch-project" }),
      msgLine(0, "2024-01-02T00:00:00.000Z"),
    ]);
    const row = cache
      .listConversations({ limit: 10, offset: 0 })
      .conversations.find((c) => c.id === "batch-skel");
    expect(row?.projectPath).toBe("/Users/me/dev/batch-project");
    expect(row?.projectName).toBe("me/dev/batch-project");
  });

  it("agent filter short-circuits the whole batch and deletes the file", () => {
    const agentCache = ConversationCache.open(join(dbDir, "agent.db"), 3, undefined, {
      filterAgentConversations: true,
    });
    try {
      const file = "/home/.claude/projects/-proj-agent/agent-skel.jsonl";
      agentCache.updateFromLines(file, [
        JSON.stringify({
          entrypoint: "sdk-cli",
          role: "user",
          timestamp: "2024-01-02T00:00:00.000Z",
        }),
        msgLine(1, "2024-01-02T00:01:00.000Z"),
      ]);
      expect(agentCache.hasConversation("agent-skel")).toBe(false);
    } finally {
      agentCache.close();
    }
  });

  it("parity: replaying lines via updateFromLine equals one updateFromLines (existing row)", () => {
    const lines = Array.from({ length: 4 }, (_, i) =>
      msgLine(i, `2024-05-0${i + 1}T00:00:00.000Z`),
    );

    const a = ConversationCache.open(join(dbDir, "parity-a.db"), 3);
    const b = ConversationCache.open(join(dbDir, "parity-b.db"), 3);
    try {
      a.upsertFromScannerMeta([BASE_META as any]);
      b.upsertFromScannerMeta([BASE_META as any]);
      for (const l of lines) a.updateFromLine(BASE_META.filePath, l);
      b.updateFromLines(BASE_META.filePath, lines);

      const la = a.listConversations({ limit: 10, offset: 0 }).conversations[0];
      const lb = b.listConversations({ limit: 10, offset: 0 }).conversations[0];
      expect(lb.messageCount).toBe(la.messageCount);
      expect(lb.lastActivity).toBe(la.lastActivity);
      expect(a.getConversationTail("abc-123")?.messages.map((m) => m.text)).toEqual(
        b.getConversationTail("abc-123")?.messages.map((m) => m.text),
      );
    } finally {
      a.close();
      b.close();
    }
  });

  it("parity: fresh-file (skeleton) path matches per-line replay", () => {
    const file = "/home/.claude/projects/-proj-fresh/fresh-skel.jsonl";
    const lines = Array.from({ length: 3 }, (_, i) =>
      msgLine(i, `2024-07-0${i + 1}T00:00:00.000Z`),
    );

    const a = ConversationCache.open(join(dbDir, "fresh-a.db"), 3);
    const b = ConversationCache.open(join(dbDir, "fresh-b.db"), 3);
    try {
      for (const l of lines) a.updateFromLine(file, l);
      b.updateFromLines(file, lines);
      const rowA = a
        .listConversations({ limit: 10, offset: 0 })
        .conversations.find((c) => c.id === "fresh-skel");
      const rowB = b
        .listConversations({ limit: 10, offset: 0 })
        .conversations.find((c) => c.id === "fresh-skel");
      expect(rowB?.messageCount).toBe(rowA?.messageCount);
    } finally {
      a.close();
      b.close();
    }
  });

  it("parity: multiple interleaved cwd/slug context lines resolve first-wins like per-line replay", () => {
    // backfillSkeletonProject COALESCEs each column, so per-line replay keeps the
    // FIRST non-null value seen for a column; later context lines can't override
    // it. The batch path applies project context once at the end, so it must also
    // accumulate first-wins. This exercises >1 context line + slug — the spot most
    // likely to diverge — and asserts both paths land on identical project metadata.
    const file = "/home/.claude/projects/-proj-ctx/ctx-skel.jsonl";
    const lines = [
      JSON.stringify({ cwd: "/Users/me/dev/first" }),
      msgLine(0, "2024-08-01T00:00:00.000Z"),
      JSON.stringify({ slug: "renamed-thread", cwd: "/Users/me/dev/second" }),
      msgLine(1, "2024-08-02T00:00:00.000Z"),
    ];

    const a = ConversationCache.open(join(dbDir, "ctx-a.db"), 3);
    const b = ConversationCache.open(join(dbDir, "ctx-b.db"), 3);
    try {
      for (const l of lines) a.updateFromLine(file, l);
      b.updateFromLines(file, lines);
      const rowA = a
        .listConversations({ limit: 10, offset: 0 })
        .conversations.find((c) => c.id === "ctx-skel");
      const rowB = b
        .listConversations({ limit: 10, offset: 0 })
        .conversations.find((c) => c.id === "ctx-skel");
      expect(rowB?.projectPath).toBe(rowA?.projectPath);
      expect(rowB?.projectName).toBe(rowA?.projectName);
      expect(rowB?.title).toBe(rowA?.title);
      expect(rowB?.messageCount).toBe(rowA?.messageCount);
      expect(b.getConversationTail("ctx-skel")?.messages.map((m) => m.text)).toEqual(
        a.getConversationTail("ctx-skel")?.messages.map((m) => m.text),
      );
    } finally {
      a.close();
      b.close();
    }
  });
});
