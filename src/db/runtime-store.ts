import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { instrumentDatabase } from "./query-timing";
import { resolveMigrationsDir, runSqliteMigrations } from "./sqlite-migrate";

/**
 * Where runtime.db lives: explicit override, then the test hook, then a sibling
 * of server.yaml — deliberately NOT under cache/, for the reasons below.
 *
 * Exported because both StreamerServer and the CLI's `devices` command need to
 * agree on it, and a second hand-written copy of this precedence chain would
 * drift the moment one of the three sources changed.
 */
export function resolveRuntimeDbPath(override?: string): string {
  return (
    override ??
    process.env.THREADBASE_RUNTIME_DB ??
    join(process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase"), "runtime.db")
  );
}

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
   * Returns the number of rows copied.
   */
  importLegacyManagedSessions(source: Database.Database): number {
    return this.importLegacyTable(source, "managed_sessions");
  }

  /**
   * One-time move of `devices` rows out of `cache.db`, where the registry used
   * to live (migration `011_create_devices.sql`).
   *
   * Losing this table invalidates every device token ever issued, and cache.db
   * is the file `tb-streamer cache clear` deletes and the integrity monitor
   * rebuilds — see `runtime-migrations/003_create_devices.sql`.
   *
   * Unlike `managed_sessions`, this one MOVES rather than copies: the source
   * rows are deleted once the copy is verified. A `devices` row carries a
   * user-supplied label ("Ronen's iPhone"), and leaving a second copy of that
   * on disk indefinitely — in the one file the user is told to delete when
   * something goes wrong — is more retained personal data than the rollback
   * path is worth. Recovering from a rollback is re-scanning a pairing QR.
   *
   * The delete is conditional on the copy being complete: `INSERT OR IGNORE`
   * can silently skip a row, so the destination count must match what was read
   * before anything is removed. A mismatch keeps the source and reports
   * `purged: false` rather than throwing — the import itself still succeeded,
   * and keeping data is the safe direction to fail in.
   */
  importLegacyDevices(source: Database.Database): { copied: number; purged: boolean } {
    const copied = this.importLegacyTable(source, "devices");
    if (copied === 0) return { copied: 0, purged: false };

    const landed = (this.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
    if (landed !== copied) return { copied, purged: false };

    source.prepare("DELETE FROM devices").run();
    // Deliberately no VACUUM. The rows can linger in cache.db's free pages
    // until reused, but the same data sits unencrypted in runtime.db by design,
    // so reclaiming those pages buys nothing and a VACUUM locks a database the
    // scanner is actively writing to.
    return { copied, purged: true };
  }

  /**
   * Copy a whole table out of a pre-split `cache.db` into this file.
   *
   * The copy itself is non-destructive — the source is left in place, so an
   * older streamer rolled back onto the same machine still finds its data.
   * `importLegacyDevices` deletes the source afterwards for its own reasons;
   * `managed_sessions` does not. Runs only when this file's table is empty, so
   * a second boot is a no-op rather than a re-copy that would resurrect rows
   * deleted since.
   *
   * The table name is interpolated into SQL, so it is typed as a closed union
   * rather than `string` — the set of tables that can ever be lifted is known
   * at compile time, and that is what keeps a caller from making this a hole.
   */
  private importLegacyTable(
    source: Database.Database,
    table: "managed_sessions" | "devices",
  ): number {
    const existing = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    if (existing.n > 0) return 0;

    const hasTable = source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!hasTable) return 0;

    const rows = source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;

    // Column names come from SQLite's own schema, never from user input.
    const columns = Object.keys(rows[0]);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")})
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
