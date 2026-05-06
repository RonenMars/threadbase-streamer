import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

function getMigrationsDir(): string {
  if (typeof import.meta !== "undefined" && import.meta.url) {
    return dirname(fileURLToPath(import.meta.url));
  }
  return __dirname;
}

const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

export interface SqliteMigrationRunResult {
  applied: string[];
  skipped: string[];
}

export function runSqliteMigrations(
  db: Database.Database,
  migrationsDir?: string,
): SqliteMigrationRunResult {
  db.exec(SCHEMA_MIGRATIONS_SQL);

  const dir = migrationsDir ?? join(getMigrationsDir(), "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const appliedSet = new Set(appliedRows.map((r) => r.id));

  const recordApplied = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf-8");
    const tx = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(file, new Date().toISOString());
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}
