import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import { getCacheMetadata } from "../cache/cacheMetadata";

const DEFAULT_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ShouldRefreshOptions {
  /** Override the disk path checked for drift. Defaults to ~/.claude/projects. */
  projectsDir?: string;
  /** Additional project roots (e.g. per-profile `configDir/projects`). */
  projectsDirs?: string[];
}

/**
 * Newest mtime across a projects root and its immediate child directories.
 *
 * POSIX directory mtime updates when direct entries are added/removed/renamed,
 * not when a file inside a child is appended. Checking one level of children
 * catches new JSONLs in an existing project without stating every file.
 */
export function maxProjectsTreeMtimeMs(projectsDir: string): number | null {
  let maxMs: number;
  try {
    maxMs = statSync(projectsDir).mtimeMs;
  } catch {
    return null;
  }

  try {
    for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      try {
        const childMs = statSync(join(projectsDir, ent.name)).mtimeMs;
        if (childMs > maxMs) maxMs = childMs;
      } catch {
        // race: directory removed between readdir and stat
      }
    }
  } catch {
    // projectsDir unreadable after the root stat — keep root mtime
  }

  return maxMs;
}

/**
 * Decide whether the projects/conversations cache needs a refresh.
 *
 * Returns true when either:
 *   1. The cache has orphan rows — conversations with a project_path but no
 *      project_id. These need a backfill pass to become visible to
 *      /project-chats (which filters out null project_id).
 *   2. A watched projects tree on disk has changed since the last scanner pass —
 *      max(root mtime, child-dir mtimes) is newer than
 *      cache_metadata.conversations_last_indexed_at. This catches new JSONLs
 *      that the file watcher missed (including under existing project dirs).
 *
 * Appends to existing JSONLs still rely on the directory watcher flipping
 * scannerStale; this mtime gate does not see in-place file growth.
 */
export function shouldRefreshProjectsFromHdd(
  conversationsRepo: ConversationsRepository,
  cacheMetadataRepo: CacheMetadataRepository,
  opts: ShouldRefreshOptions = {},
): boolean {
  if (conversationsRepo.hasOrphanRows()) return true;

  const dirs = new Set<string>();
  if (opts.projectsDirs) {
    for (const d of opts.projectsDirs) dirs.add(d);
  }
  dirs.add(opts.projectsDir ?? DEFAULT_PROJECTS_DIR);

  let newestMs: number | null = null;
  for (const dir of dirs) {
    const ms = maxProjectsTreeMtimeMs(dir);
    if (ms === null) continue;
    if (newestMs === null || ms > newestMs) newestMs = ms;
  }
  if (newestMs === null) return false;

  const lastIndexedIso = getCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at");
  if (!lastIndexedIso) return true;

  const lastIndexedMs = Date.parse(lastIndexedIso);
  if (Number.isNaN(lastIndexedMs)) return true;

  return newestMs > lastIndexedMs;
}
