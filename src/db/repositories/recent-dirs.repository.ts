import type Database from "better-sqlite3";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";
import type { RuntimeStore } from "../runtime-store";

/** Rows kept; the oldest beyond this are dropped on each write. */
export const RECENT_DIRS_MAX = 50;

export interface RecentDirView {
  path: string;
  lastUsedAt: string;
  useCount: number;
  provider?: string;
}

interface RecentDirRow {
  path: string;
  last_used_at: number;
  use_count: number;
  provider: string | null;
}

export class RecentDirsRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      touch: db.prepare(`
        INSERT INTO recent_dirs (path, last_used_at, use_count, provider)
        VALUES (@path, @now, 1, @provider)
        ON CONFLICT (path) DO UPDATE SET
          last_used_at = MAX(recent_dirs.last_used_at, excluded.last_used_at),
          use_count = recent_dirs.use_count + 1,
          provider = COALESCE(excluded.provider, recent_dirs.provider)`),
      prune: db.prepare(`
        DELETE FROM recent_dirs WHERE path NOT IN (
          SELECT path FROM recent_dirs ORDER BY last_used_at DESC, path LIMIT ?
        )`),
      list: db.prepare("SELECT * FROM recent_dirs ORDER BY last_used_at DESC, path LIMIT ?"),
    };
  }

  /** Record a session starting in `path`. A blank path is ignored. */
  touch(path: string, provider?: string, now: number = Date.now()): void {
    const canonical = canonicalizeProjectPath(path);
    if (!canonical) return;
    this.db.transaction(() => {
      this.stmts.touch.run({ path: canonical, now, provider: provider ?? null });
      this.stmts.prune.run(RECENT_DIRS_MAX);
    })();
  }

  list(limit: number = RECENT_DIRS_MAX): RecentDirView[] {
    const rows = this.stmts.list.all(
      Math.max(0, Math.min(limit, RECENT_DIRS_MAX)),
    ) as RecentDirRow[];
    return rows.map((r) => ({
      path: r.path,
      lastUsedAt: new Date(r.last_used_at).toISOString(),
      useCount: r.use_count,
      ...(r.provider ? { provider: r.provider } : {}),
    }));
  }
}

const repos = new WeakMap<Database.Database, RecentDirsRepository>();

/** One repository per open runtime.db, shared by the spawn path and the route. */
export function recentDirsFor(store: RuntimeStore | null): RecentDirsRepository | null {
  const db = store?.getDatabase();
  if (!db) return null;
  let repo = repos.get(db);
  if (!repo) {
    repo = new RecentDirsRepository(db);
    repos.set(db, repo);
  }
  return repo;
}
