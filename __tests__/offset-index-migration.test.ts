import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { runSqliteMigrations } from "../src/db/sqlite-migrate";

const MIGRATIONS_DIR = join(__dirname, "..", "src", "db", "migrations");

let dbDir: string;
let cache: ConversationCache;

beforeEach(() => {
  dbDir = join(tmpdir(), `offset-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("migration 009 — offset index", () => {
  it("creates conversation_file_state and conversation_message_index", () => {
    const db = cache.getDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("conversation_file_state");
    expect(names).toContain("conversation_message_index");
  });

  it("conversation_file_state has the expected columns", () => {
    const cols = cache
      .getDatabase()
      .prepare("PRAGMA table_info(conversation_file_state)")
      .all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    for (const col of [
      "path",
      "identity",
      "size",
      "mtime_ms",
      "byte_offset",
      "last_message_index",
    ]) {
      expect(names).toContain(col);
    }
    // path is the primary key.
    expect(cols.find((c) => c.name === "path")?.pk).toBe(1);
  });

  it("conversation_message_index has a composite PK on (conversation_id, message_index)", () => {
    const cols = cache
      .getDatabase()
      .prepare("PRAGMA table_info(conversation_message_index)")
      .all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    for (const col of [
      "conversation_id",
      "message_index",
      "byte_offset",
      "byte_length",
      "uuid",
      "role",
      "ts",
    ]) {
      expect(names).toContain(col);
    }
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["conversation_id", "message_index"]);
  });

  it("is recorded in schema_migrations and re-applies idempotently", () => {
    const db = cache.getDatabase();
    const applied = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
    expect(applied.map((r) => r.id)).toContain("009_create_offset_index.sql");

    // A second run applies nothing new and skips 009 among others.
    const second = runSqliteMigrations(db, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("009_create_offset_index.sql");
  });

  it("upgrades a db already carrying 001-008 without error", () => {
    // Fresh cache.open ran every migration; deleting only the 009 marker row
    // simulates a db that stopped at 008, then re-running migrates just 009.
    const db = cache.getDatabase();
    db.prepare("DELETE FROM schema_migrations WHERE id = ?").run("009_create_offset_index.sql");
    db.exec("DROP TABLE conversation_file_state");
    db.exec("DROP TABLE conversation_message_index");

    const result = runSqliteMigrations(db, MIGRATIONS_DIR);
    expect(result.applied).toEqual(["009_create_offset_index.sql"]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("conversation_file_state");
    expect(names).toContain("conversation_message_index");
  });
});
