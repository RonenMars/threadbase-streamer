import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { runSqliteMigrations } from "../src/db/sqlite-migrate";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  coerceProviderForRunner,
} from "../src/providers";

const MIGRATIONS_DIR = join(__dirname, "..", "src", "db", "migrations");

describe("coerceProviderForRunner", () => {
  it("passes through real runner providers", () => {
    expect(coerceProviderForRunner(CLAUDE_CODE_PROVIDER)).toBe(CLAUDE_CODE_PROVIDER);
    expect(coerceProviderForRunner(CODEX_CLI_PROVIDER)).toBe(CODEX_CLI_PROVIDER);
  });

  it("coerces the legacy 'threadbase' default to claude-code (the 501 fix)", () => {
    expect(coerceProviderForRunner("threadbase")).toBe(CLAUDE_CODE_PROVIDER);
  });

  it("coerces null/undefined/empty/unknown to claude-code", () => {
    expect(coerceProviderForRunner(null)).toBe(CLAUDE_CODE_PROVIDER);
    expect(coerceProviderForRunner(undefined)).toBe(CLAUDE_CODE_PROVIDER);
    expect(coerceProviderForRunner("")).toBe(CLAUDE_CODE_PROVIDER);
    expect(coerceProviderForRunner("gemini")).toBe(CLAUDE_CODE_PROVIDER);
  });
});

describe("migration 008: heal legacy 'threadbase' provider", () => {
  let dbDir: string;
  let cache: ConversationCache;

  beforeEach(() => {
    dbDir = join(tmpdir(), `provfix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dbDir, { recursive: true });
    cache = ConversationCache.open(join(dbDir, "cache.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("rewrites threadbase rows to claude-code and leaves codex-cli untouched", () => {
    const db = cache.getDatabase();
    const insert = db.prepare(
      "INSERT INTO conversation_meta (id, file_path, provider, updated_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("legacy", "/tmp/a.jsonl", "threadbase", 1);
    insert.run("codex", "/tmp/b.jsonl", CODEX_CLI_PROVIDER, 2);

    // Re-run migrations: 008 is already applied by open(), so force the UPDATE
    // by clearing its ledger row, mirroring a cache that predates 008.
    db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(
      "008_fix_legacy_threadbase_provider.sql",
    );
    runSqliteMigrations(db, MIGRATIONS_DIR);

    const providerOf = (id: string) =>
      (
        db.prepare("SELECT provider FROM conversation_meta WHERE id = ?").get(id) as {
          provider: string;
        }
      ).provider;

    expect(providerOf("legacy")).toBe(CLAUDE_CODE_PROVIDER);
    expect(providerOf("codex")).toBe(CODEX_CLI_PROVIDER);
  });
});
