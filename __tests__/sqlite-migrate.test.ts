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
  dbDir = join(tmpdir(), `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("runSqliteMigrations", () => {
  it("is idempotent when run a second time", () => {
    const second = runSqliteMigrations(cache.getDatabase(), MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it("creates the projects, cache_metadata, and schema_migrations tables", () => {
    const db = cache.getDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("cache_metadata");
    expect(names).toContain("conversation_file_metadata");
    expect(names).toContain("schema_migrations");
  });

  it("adds project_id column to conversation_meta", () => {
    const cols = cache
      .getDatabase()
      .prepare("PRAGMA table_info(conversation_meta)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("project_id");
    expect(cols.map((c) => c.name)).toContain("scanner_meta_json");
  });
});
