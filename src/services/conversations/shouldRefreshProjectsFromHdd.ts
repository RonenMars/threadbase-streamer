import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import { getCacheMetadata } from "../cache/cacheMetadata";

const DEFAULT_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ShouldRefreshOptions {
  /** Override the disk path checked for drift. Defaults to ~/.claude/projects. */
  projectsDir?: string;
}

/**
 * Decide whether the projects/conversations cache needs a refresh.
 *
 * Returns true when either:
 *   1. The cache has orphan rows — conversations with a project_path but no
 *      project_id. These need a backfill pass to become visible to
 *      /project-chats (which filters out null project_id).
 *   2. The projects dir on disk has changed since the last scanner pass —
 *      its mtime is newer than cache_metadata.conversations_last_indexed_at.
 *      This catches new JSONLs that the file watcher missed.
 *
 * The chokidar watcher only tails JSONLs for managed PTY sessions, so
 * conversations created outside the streamer (or before it started) never
 * trigger the watcher. The mtime check is the safety net.
 */
export function shouldRefreshProjectsFromHdd(
  conversationsRepo: ConversationsRepository,
  cacheMetadataRepo: CacheMetadataRepository,
  opts: ShouldRefreshOptions = {},
): boolean {
  if (conversationsRepo.hasOrphanRows()) return true;

  const projectsDir = opts.projectsDir ?? DEFAULT_PROJECTS_DIR;
  let dirMtimeMs: number;
  try {
    dirMtimeMs = statSync(projectsDir).mtimeMs;
  } catch {
    return false;
  }

  const lastIndexedIso = getCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at");
  if (!lastIndexedIso) return true;

  const lastIndexedMs = Date.parse(lastIndexedIso);
  if (Number.isNaN(lastIndexedMs)) return true;

  return dirMtimeMs > lastIndexedMs;
}
