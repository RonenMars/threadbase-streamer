import type { ConversationCache } from "../../conversation-cache";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";
import { setCacheMetadata } from "../cache/cacheMetadata";
import { ensureProjectsForConversations } from "../projects/ensureProjectsForConversations";

export interface RefreshConversationCacheDeps {
  cache: ConversationCache;
  projectsRepo: ProjectsRepository;
  conversationsRepo: ConversationsRepository;
  cacheMetadataRepo: CacheMetadataRepository;
}

export interface RefreshConversationCacheResult {
  projectsTouched: number;
  conversationsBackfilled: number;
  latestConversationId: string | null;
}

/**
 * After a scanner-driven cache rebuild has run, walk the cache to:
 *   1. Upsert one project row per unique canonical project_path.
 *   2. Backfill conversation_meta.project_id for any rows missing it.
 *   3. Update cache_metadata.last_conversation_id so subsequent freshness
 *      checks can short-circuit.
 *
 * The scanner itself runs in `server.ts` today; this function picks up
 * after it has populated `conversation_meta`.
 */
export function refreshConversationCache(
  deps: RefreshConversationCacheDeps,
): RefreshConversationCacheResult {
  const { projectsRepo, conversationsRepo, cacheMetadataRepo } = deps;

  const conversations = conversationsRepo.listConversationsForProjectBackfill();

  const pathToProjectId = ensureProjectsForConversations(
    projectsRepo,
    conversations.map((c) => ({
      id: c.id,
      projectPath: c.projectPath,
      latestMessageAt: c.lastActivity ?? null,
      createdAt: c.lastActivity ?? null,
    })),
  );

  let conversationsBackfilled = 0;
  for (const conversation of conversations) {
    if (!conversation.projectPath) continue;
    if (conversation.projectId) continue;
    const projectId = pathToProjectId.get(canonicalizeProjectPath(conversation.projectPath));
    if (!projectId) continue;
    conversationsRepo.updateConversationProjectId({
      conversationId: conversation.id,
      projectId,
    });
    conversationsBackfilled += 1;
  }

  const latest = conversationsRepo.getLatestConversation();
  if (latest) {
    setCacheMetadata(cacheMetadataRepo, "last_conversation_id", latest.id);
    if (latest.lastActivity) {
      setCacheMetadata(cacheMetadataRepo, "last_conversation_created_at", latest.lastActivity);
    }
  }
  setCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at", new Date().toISOString());

  return {
    projectsTouched: pathToProjectId.size,
    conversationsBackfilled,
    latestConversationId: latest?.id ?? null,
  };
}
