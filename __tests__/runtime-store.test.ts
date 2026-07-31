import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import type { ManagedSession } from "../src/types";

/**
 * Phase 0 of the live-sessions-persistence plan: the managed-session registry
 * moves out of cache.db, which is derived and safe to delete, into runtime.db,
 * which is authoritative and is not.
 *
 * See docs/plans/live-sessions-persistence-plan.md §3.0.
 */

let baseDir: string;
let cacheDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "tb-runtime-store-"));
  cacheDir = join(baseDir, "cache");
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const STARTED = new Date("2026-07-30T08:00:00Z");

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "runtime-sess",
    provider: "claude-code",
    projectPath: "/work/repo",
    projectName: "repo",
    branch: "main",
    status: "running",
    startedAt: STARTED,
    completedAt: null,
    promptCount: 4,
    lastOutput: "",
    sessionName: "the long refactor",
    ...over,
  } as ManagedSession;
}

function openRuntime(): RuntimeStore {
  return RuntimeStore.open(join(baseDir, "runtime.db"));
}

describe("RuntimeStore", () => {
  it("tracks its migrations in its own file, not the cache's", () => {
    const store = openRuntime();
    const applied = store.getDatabase().prepare("SELECT id FROM schema_migrations").all() as Array<{
      id: string;
    }>;
    // Only the runtime tree ran here — none of the cache's 001..014.
    expect(applied.map((r) => r.id)).toEqual(["001_create_managed_sessions.sql"]);
    store.close();

    // And the cache no longer creates the table at all: it moved out of
    // src/db/migrations/, so a fresh cache.db has no managed_sessions.
    const cache = ConversationCache.open(join(cacheDir, "cache.db"));
    const table = cache
      .getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_sessions'")
      .get();
    expect(table).toBeUndefined();
    cache.close();
  });

  it("survives deleting the whole cache directory", () => {
    const cache = ConversationCache.open(join(cacheDir, "cache.db"));
    const store = openRuntime();
    const repo = new ManagedSessionsRepository(store.getDatabase());
    repo.recordSpawn({
      session: mkSession(),
      pid: 4242,
      cmdline: "claude --resume runtime-sess",
      streamerInstanceId: "instance-a",
    });
    cache.close();
    store.close();

    // The support instruction this split exists to make survivable.
    rmSync(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    const reopened = openRuntime();
    const row = new ManagedSessionsRepository(reopened.getDatabase()).get("runtime-sess");
    expect(row?.session_name).toBe("the long refactor");
    expect(row?.prompt_count).toBe(4);
    expect(row?.started_at).toBe(STARTED.getTime());
    reopened.close();
  });

  it("keeps persistence working when the conversation cache fails to open", () => {
    // A directory where cache.db should be — better-sqlite3 cannot open it,
    // standing in for the ABI mismatch that used to null the registry too.
    const blocked = join(baseDir, "blocked");
    mkdirSync(join(blocked, "cache.db"), { recursive: true });
    expect(() => ConversationCache.open(join(blocked, "cache.db"))).toThrow();

    const store = openRuntime();
    const repo = new ManagedSessionsRepository(store.getDatabase());
    repo.recordSpawn({
      session: mkSession({ id: "degraded-sess" }),
      pid: 1,
      cmdline: "claude",
      streamerInstanceId: "instance-a",
    });
    expect(repo.get("degraded-sess")).not.toBeNull();
    store.close();
  });

  describe("importLegacyManagedSessions", () => {
    /** A pre-split cache.db: the 010 table living inside the cache file. */
    function seedLegacyCache(rows: number): Database.Database {
      const db = new Database(join(baseDir, "legacy-cache.db"));
      db.exec(`
        CREATE TABLE managed_sessions (
          session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, pid INTEGER,
          cmdline TEXT, project_path TEXT NOT NULL, project_name TEXT NOT NULL,
          branch TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
          status_source TEXT NOT NULL, status_updated_at INTEGER NOT NULL,
          started_at INTEGER NOT NULL, completed_at INTEGER,
          last_activity_at INTEGER, prompt_count INTEGER NOT NULL DEFAULT 0,
          session_name TEXT, project_id TEXT, bound_conversation_id TEXT,
          resumed_from_conversation_id TEXT, failure_reason TEXT,
          streamer_instance_id TEXT NOT NULL
        );
      `);
      const insert = db.prepare(`
        INSERT INTO managed_sessions (
          session_id, provider, project_path, project_name, status, status_source,
          status_updated_at, started_at, prompt_count, session_name, streamer_instance_id
        ) VALUES (?, 'claude-code', '/work/repo', 'repo', 'running', 'spawn', 0, ?, 2, ?, 'old')
      `);
      for (let i = 0; i < rows; i++) insert.run(`legacy-${i}`, STARTED.getTime() + i, `name-${i}`);
      return db;
    }

    it("copies rows across once and leaves the original in place", () => {
      const legacy = seedLegacyCache(3);

      const first = openRuntime();
      expect(first.importLegacyManagedSessions(legacy)).toBe(3);
      const repo = new ManagedSessionsRepository(first.getDatabase());
      expect(repo.get("legacy-1")?.session_name).toBe("name-1");
      first.close();

      // Rollback safety: an older streamer put back on this machine still finds
      // its registry where it left it.
      const stillThere = legacy.prepare("SELECT COUNT(*) AS n FROM managed_sessions").get() as {
        n: number;
      };
      expect(stillThere.n).toBe(3);

      // Second boot: table is non-empty, so nothing is re-copied — including
      // rows deleted since, which must stay deleted.
      const second = openRuntime();
      new ManagedSessionsRepository(second.getDatabase()).delete("legacy-1");
      expect(second.importLegacyManagedSessions(legacy)).toBe(0);
      expect(new ManagedSessionsRepository(second.getDatabase()).get("legacy-1")).toBeNull();
      second.close();
      legacy.close();
    });

    it("is a no-op against a cache that never had the table", () => {
      const cache = ConversationCache.open(join(cacheDir, "cache.db"));
      const store = openRuntime();
      expect(store.importLegacyManagedSessions(cache.getDatabase())).toBe(0);
      store.close();
      cache.close();
    });
  });
});
