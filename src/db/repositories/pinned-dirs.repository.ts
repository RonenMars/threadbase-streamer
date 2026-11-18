import type Database from "better-sqlite3";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";
import type { RuntimeStore } from "../runtime-store";

export const PINNED_DIRS_MAX = 50;

export interface PinnedDirView {
  path: string;
  pinnedAt: string;
}

interface PinnedDirRow {
  path: string;
  pinned_at: number;
}

export class PinnedDirsFullError extends Error {
  constructor() {
    super(`At most ${PINNED_DIRS_MAX} pinned directories`);
  }
}

export class PinnedDirsRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      has: db.prepare("SELECT 1 FROM pinned_dirs WHERE path = ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM pinned_dirs"),
      insert: db.prepare("INSERT OR IGNORE INTO pinned_dirs (path, pinned_at) VALUES (?, ?)"),
      remove: db.prepare("DELETE FROM pinned_dirs WHERE path = ?"),
      // Oldest pin first, so pinning another folder never reshuffles the list.
      list: db.prepare("SELECT * FROM pinned_dirs ORDER BY pinned_at, path"),
    };
  }

  /** Idempotent: re-pinning keeps the original position. A blank path is ignored. */
  pin(path: string, now: number = Date.now()): void {
    const canonical = canonicalizeProjectPath(path);
    if (!canonical) return;
    this.db.transaction(() => {
      if (this.stmts.has.get(canonical)) return;
      const { n } = this.stmts.count.get() as { n: number };
      if (n >= PINNED_DIRS_MAX) throw new PinnedDirsFullError();
      this.stmts.insert.run(canonical, now);
    })();
  }

  unpin(path: string): boolean {
    return this.stmts.remove.run(canonicalizeProjectPath(path)).changes > 0;
  }

  list(): PinnedDirView[] {
    return (this.stmts.list.all() as PinnedDirRow[]).map((r) => ({
      path: r.path,
      pinnedAt: new Date(r.pinned_at).toISOString(),
    }));
  }
}

const repos = new WeakMap<Database.Database, PinnedDirsRepository>();

export function pinnedDirsFor(store: RuntimeStore | null): PinnedDirsRepository | null {
  const db = store?.getDatabase();
  if (!db) return null;
  let repo = repos.get(db);
  if (!repo) {
    repo = new PinnedDirsRepository(db);
    repos.set(db, repo);
  }
  return repo;
}
