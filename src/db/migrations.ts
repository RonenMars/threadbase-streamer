import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type pg from "pg";
import { fileURLToPath } from "url";

function getMigrationsDir(): string {
  // ESM: import.meta.url is available
  if (import.meta.url) {
    return dirname(fileURLToPath(import.meta.url));
  }
  // CJS: __dirname is available (injected by tsup)
  return __dirname;
}

export async function runMigrations(pool: pg.Pool, migrationsDir?: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query<{ name: string }>(
    "SELECT name FROM _migrations ORDER BY name",
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  const dir = migrationsDir ?? join(getMigrationsDir(), "pg-migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(join(dir, file), "utf-8");
    await pool.query(sql);
    await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
  }
}
