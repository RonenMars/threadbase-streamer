import Database from "better-sqlite3";
import { instrumentDatabase } from "./query-timing";
import { resolveMigrationsDir, runSqliteMigrations } from "./sqlite-migrate";

/**
 * `~/.threadbase/runtime.db` — the authoritative, non-derived half of the
 * streamer's SQLite state.
 *
 * Deliberately a separate file from `cache/cache.db`, and deliberately not
 * under `cache/`. The conversation cache is rebuildable from the provider
 * JSONLs at any time, which is why "delete the cache and restart" is reasonable
 * support advice and why the integrity monitor offers a reset-and-rescan
 * action. The managed-session registry is not rebuildable from anything on
 * disk, so it must not sit one plausible instruction away from deletion — nor
 * share a handle whose failure (a better-sqlite3 ABI mismatch, most commonly)
 * would silently disable session persistence along with the cache.
 *
 * Runs its own migrations from `src/db/runtime-migrations/`, tracked in this
 * file's own `schema_migrations` table.
 */
export class RuntimeStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string, migrationsDir?: string): RuntimeStore {
    const db = instrumentDatabase(new Database(dbPath));
    db.pragma("journal_mode = WAL");
    runSqliteMigrations(db, migrationsDir ?? resolveMigrationsDir("runtime-migrations"));
    return new RuntimeStore(db);
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * One-time move of `managed_sessions` rows out of a pre-split `cache.db`.
   *
   * Non-destructive by design: the source table is left in place so an older
   * streamer rolled back onto the same machine still finds its registry. Runs
   * only when this file's table is empty, so a second boot is a no-op rather
   * than a re-copy that would resurrect rows deleted since.
   *
   * Returns the number of rows copied.
   */
  importLegacyManagedSessions(source: Database.Database): number {
    const existing = this.db.prepare("SELECT COUNT(*) AS n FROM managed_sessions").get() as {
      n: number;
    };
    if (existing.n > 0) return 0;

    const hasTable = source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_sessions'")
      .get();
    if (!hasTable) return 0;

    const rows = source.prepare("SELECT * FROM managed_sessions").all() as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return 0;

    // Column names come from SQLite's own schema, never from user input.
    const columns = Object.keys(rows[0]);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO managed_sessions (${columns.join(", ")})
       VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
    );
    this.db.transaction((batch: Array<Record<string, unknown>>) => {
      for (const row of batch) insert.run(row);
    })(rows);

    return rows.length;
  }

  close(): void {
    this.db.close();
  }
}
