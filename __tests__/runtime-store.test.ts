import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { DevicesRepository } from "../src/db/repositories/devices.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import type { ManagedSession } from "../src/types";
import { currentBootToken } from "../src/utils/bootToken";

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
    // Only the runtime tree ran here — none of the cache's 001..015.
    expect(applied.map((r) => r.id)).toEqual([
      "001_create_managed_sessions.sql",
      "002_add_managed_session_boot_token.sql",
      "003_create_devices.sql",
    ]);
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

  // Phase 2: the boot marker that makes a stored pid safe to probe.
  it("adds boot_token on top of 001 and re-opens without re-applying it", () => {
    const first = openRuntime();
    const columns = (store: RuntimeStore) =>
      (
        store.getDatabase().prepare("PRAGMA table_info(managed_sessions)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
    expect(columns(first)).toContain("boot_token");
    new ManagedSessionsRepository(first.getDatabase()).recordSpawn({
      session: mkSession(),
      pid: 4242,
      cmdline: "claude --resume runtime-sess",
      streamerInstanceId: "instance-a",
    });
    first.close();

    // A re-applied ALTER TABLE would throw "duplicate column name".
    const second = openRuntime();
    expect(columns(second)).toContain("boot_token");
    expect(
      new ManagedSessionsRepository(second.getDatabase()).get("runtime-sess")?.boot_token,
    ).toBe(currentBootToken());
    second.close();
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

  /**
   * The device registry makes the same move, and for a sharper reason: cache.db
   * is what `tb-streamer cache clear` deletes and what the integrity monitor
   * rebuilds, and losing the devices table invalidates every device token ever
   * issued. While it lived there, no client could safely present the device
   * token as its only credential.
   */
  describe("importLegacyDevices", () => {
    /** A cache.db carrying the 011 devices table. */
    function seedLegacyDevices(rows: number): Database.Database {
      const db = new Database(join(baseDir, "legacy-devices.db"));
      db.exec(`
        CREATE TABLE devices (
          device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, name TEXT, capabilities TEXT NOT NULL,
          created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
        );
      `);
      const insert = db.prepare(`
        INSERT INTO devices (device_id, public_key, token_hash, name, capabilities, created_at)
        VALUES (?, 'pk', ?, ?, '["history:read"]', 0)
      `);
      for (let i = 0; i < rows; i++) insert.run(`dev-${i}`, `hash-${i}`, `phone-${i}`);
      return db;
    }

    // Unlike managed_sessions this MOVES: a device row carries a user-supplied
    // label, so a second copy is not left sitting in the cache.
    it("moves rows across and deletes the cache-side copy", () => {
      const legacy = seedLegacyDevices(2);

      const first = openRuntime();
      expect(first.importLegacyDevices(legacy)).toEqual({ copied: 2, purged: true });
      // Read through the repository, not raw SQL: the point of the move is that
      // DevicesRepository works against the runtime handle.
      expect(new DevicesRepository(first.getDatabase()).get("dev-1")?.name).toBe("phone-1");
      first.close();

      // The user-supplied labels are gone from the cache, not duplicated there.
      const left = legacy.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number };
      expect(left.n).toBe(0);

      // Second boot imports nothing — both because the destination is non-empty
      // and because the source is now empty — so a device revoked since stays
      // revoked rather than being resurrected with working credentials.
      const second = openRuntime();
      new DevicesRepository(second.getDatabase()).revoke("dev-0");
      expect(second.importLegacyDevices(legacy)).toEqual({ copied: 0, purged: false });
      expect(new DevicesRepository(second.getDatabase()).get("dev-0")?.revoked_at).not.toBeNull();
      second.close();
      legacy.close();
    });

    // Deleting the source is conditional on an import having actually run. This
    // is the reachable half of that: a non-empty destination makes the import
    // decline, and nothing may then be deleted on the strength of a copy that
    // never happened.
    //
    // The other half — `landed !== copied` after a partial INSERT OR IGNORE —
    // is deliberately unreachable today, because importLegacyTable only runs
    // against an empty destination and the source's own UNIQUE constraint rules
    // out intra-source collisions. It is kept as an interlock for whoever
    // relaxes that guard: the cost of the check is one COUNT, and the cost of
    // getting it wrong is deleting a device registry that was not fully copied.
    it("does not delete the cache-side copy when no import ran", () => {
      const legacy = seedLegacyDevices(2);
      const store = openRuntime();
      store
        .getDatabase()
        .prepare(
          `INSERT INTO devices (device_id, public_key, token_hash, name, capabilities, created_at)
           VALUES ('squatter', 'pk', 'squatter-hash', 'other', '["history:read"]', 0)`,
        )
        .run();
      expect(store.importLegacyDevices(legacy)).toEqual({ copied: 0, purged: false });

      const left = legacy.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number };
      expect(left.n).toBe(2);
      store.close();
      legacy.close();
    });

    it("is a no-op against a source with no devices table at all", () => {
      const bare = new Database(join(baseDir, "bare.db"));
      const store = openRuntime();
      expect(store.importLegacyDevices(bare)).toEqual({ copied: 0, purged: false });
      store.close();
      bare.close();
    });

    it("is a no-op against a cache whose devices table is empty", () => {
      // The ordinary case on every machine that pairs after the move: cache.db
      // still creates the 011 table, it is just never populated.
      const cache = ConversationCache.open(join(cacheDir, "cache.db"));
      const store = openRuntime();
      expect(store.importLegacyDevices(cache.getDatabase())).toEqual({
        copied: 0,
        purged: false,
      });
      store.close();
      cache.close();
    });

    // The whole reason for the move, asserted rather than described: deleting
    // cache.db is documented support advice, and it must no longer cost the
    // device registry.
    it("keeps devices after cache.db is deleted", () => {
      const cachePath = join(cacheDir, "cache.db");
      const cache = ConversationCache.open(cachePath);
      const store = openRuntime();
      const repo = new DevicesRepository(store.getDatabase());
      const { deviceToken } = repo.register({ publicKey: "pk", name: "phone", preset: "full" });
      cache.close();

      rmSync(cachePath, { force: true });
      expect(existsSync(cachePath)).toBe(false);

      expect(repo.authenticate(deviceToken)?.name).toBe("phone");
      store.close();
    });
  });
});
