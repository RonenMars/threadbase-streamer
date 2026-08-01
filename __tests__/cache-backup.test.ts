import Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCacheDb } from "../src/services/cache-integrity/backup";

let cacheDir: string;
let db: Database.Database;

beforeEach(() => {
  cacheDir = join(
    tmpdir(),
    `cache-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(cacheDir, { recursive: true });
  db = new Database(join(cacheDir, "cache.db"));
  db.pragma("journal_mode = WAL");
});

afterEach(() => {
  db.close();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.THREADBASE_CACHE_BACKUP_RETAIN;
});

describe("backupCacheDb()", () => {
  it("captures uncheckpointed WAL data (no forced checkpoint before backup)", async () => {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 50; i++) insert.run(`row-${i}`);
    // Do NOT checkpoint — rows live in cache.db-wal, not cache.db.

    const backupPath = await backupCacheDb(db, cacheDir);

    const restored = new Database(backupPath, { readonly: true });
    const count = (restored.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
    restored.close();
    expect(count).toBe(50);
  });

  it("retains only the newest N backups (default 3)", async () => {
    const backupsDir = join(cacheDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    // 4 pre-existing backups with mtimes in the PAST, strictly increasing, so
    // the fresh backup created below is the newest. 4 old + 1 new = 5 total.
    const past = Date.now() / 1000 - 100;
    for (const i of [1, 2, 3, 4]) {
      const f = join(backupsDir, `cache-2026010${i}-000000.db`);
      writeFileSync(f, "x");
      utimesSync(f, past + i, past + i);
    }

    await backupCacheDb(db, cacheDir);

    const remaining = readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
    expect(remaining.length).toBe(3);
    // The two oldest pre-seeded files must be gone; the two newest survive.
    expect(remaining).not.toContain("cache-20260101-000000.db");
    expect(remaining).not.toContain("cache-20260102-000000.db");
    expect(remaining).toContain("cache-20260103-000000.db");
    expect(remaining).toContain("cache-20260104-000000.db");
  });

  it("honors THREADBASE_CACHE_BACKUP_RETAIN override", async () => {
    process.env.THREADBASE_CACHE_BACKUP_RETAIN = "1";
    const backupsDir = join(cacheDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const base = Date.now() / 1000;
    for (const i of [1, 2, 3]) {
      const f = join(backupsDir, `cache-2026020${i}-000000.db`);
      writeFileSync(f, "x");
      utimesSync(f, base + i, base + i);
    }

    await backupCacheDb(db, cacheDir);

    const remaining = readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
    expect(remaining.length).toBe(1);
  });
});
