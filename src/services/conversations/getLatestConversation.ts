import type { ConversationsRepository } from "../../db/repositories/conversations.repository";

export interface LatestConversationInfo {
  id: string;
  lastActivity: string | null;
}

/**
 * Returns the most-recently-active conversation as known to the SQLite
 * cache. The cache is incrementally fed by chokidar + scanner refreshes,
 * so this is treated as the "latest on HDD" source of truth for cache
 * freshness decisions. Returns null when the cache has no conversations.
 */
export function getLatestConversation(
  repo: ConversationsRepository,
): LatestConversationInfo | null {
  return repo.getLatestConversation();
}
