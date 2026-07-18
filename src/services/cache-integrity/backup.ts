// WAL-safe backup of the SQLite conversation cache, taken before any
// destructive cache-integrity resolution. Uses better-sqlite3's native async
// db.backup() (not a raw cp) — the cache runs in WAL mode, so copying cache.db
// alone would miss uncheckpointed data in cache.db-wal.

import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const DEFAULT_RETAIN = 3;

function retainCount(): number {
  const parsed = Number.parseInt(process.env.THREADBASE_CACHE_BACKUP_RETAIN ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETAIN;
}

/** `YYYYMMDD-HHMMSS` in local time, matching a hand-taken backup's name. */
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Back up the cache DB to `<cacheDir>/backups/cache-<timestamp>.db`, then prune
 * all but the newest THREADBASE_CACHE_BACKUP_RETAIN backups. Returns the path
 * of the backup just created.
 */
export async function backupCacheDb(db: Database.Database, cacheDir: string): Promise<string> {
  const backupsDir = join(cacheDir, "backups");
  mkdirSync(backupsDir, { recursive: true });
  const destPath = join(backupsDir, `cache-${timestamp(new Date())}.db`);
  await db.backup(destPath);

  const retain = retainCount();
  const backups = readdirSync(backupsDir)
    .filter((f) => f.startsWith("cache-") && f.endsWith(".db"))
    .map((f) => {
      const full = join(backupsDir, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const stale of backups.slice(retain)) {
    if (existsSync(stale.full)) unlinkSync(stale.full);
  }

  return destPath;
}
