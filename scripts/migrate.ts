#!/usr/bin/env tsx
/**
 * Apply SQLite schema migrations to the conversation cache database.
 *
 * Usage:
 *   tsx scripts/migrate.ts [--db <path>]
 *
 * Defaults to ~/.threadbase/cache/cache.db when --db is not given.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { runSqliteMigrations } from "../src/db/sqlite-migrate";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const CONVERSATION_META_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS conversation_meta (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  project_path  TEXT,
  project_name  TEXT,
  title         TEXT,
  model         TEXT,
  account       TEXT,
  branch        TEXT,
  message_count INTEGER DEFAULT 0,
  last_activity INTEGER,
  first_message TEXT,
  last_message  TEXT,
  preview       TEXT,
  updated_at    INTEGER NOT NULL
);
`;

function main(): void {
  const dbPath =
    parseArg("--db") ?? join(homedir(), ".threadbase", "cache", "cache.db");
  const migrationsDir =
    parseArg("--migrations-dir") ?? join(__dirname, "..", "src", "db", "migrations");

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Make sure conversation_meta exists so the 002 migration can ALTER it.
  db.exec(CONVERSATION_META_BOOTSTRAP_SQL);

  const result = runSqliteMigrations(db, migrationsDir);

  console.log(`SQLite migrations applied: ${result.applied.length}`);
  for (const file of result.applied) console.log(`  + ${file}`);
  console.log(`SQLite migrations skipped (already applied): ${result.skipped.length}`);
  for (const file of result.skipped) console.log(`  = ${file}`);

  db.close();
}

main();
