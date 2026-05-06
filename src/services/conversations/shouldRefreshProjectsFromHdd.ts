import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import { getCacheMetadata } from "../cache/cacheMetadata";
import { getLatestConversation } from "./getLatestConversation";

/**
 * Decide whether the projects/conversations cache needs a refresh.
 *
 *   true  → the latest known HDD conversation id has changed since the
 *           last refresh; callers should rescan/refresh.
 *   false → cache is up to date; serve from cache.
 *
 * Returns false when there are no conversations on disk yet — there is
 * nothing to refresh in that case.
 */
export function shouldRefreshProjectsFromHdd(
  conversationsRepo: ConversationsRepository,
  cacheMetadataRepo: CacheMetadataRepository,
): boolean {
  const latest = getLatestConversation(conversationsRepo);
  if (!latest) return false;

  const cached = getCacheMetadata(cacheMetadataRepo, "last_conversation_id");
  return latest.id !== cached;
}
