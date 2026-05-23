import type { ConversationCache } from "../../conversation-cache";

/**
 * Thin repository wrapper around ConversationCache for the project-id flow.
 * The cache is the source of truth for conversation rows; this just exposes
 * a stable, repo-style API for services that don't want to know about the
 * cache class directly.
 */
export class ConversationsRepository {
  constructor(private cache: ConversationCache) {}

  updateConversationProjectId(args: { conversationId: string; projectId: string }): void {
    this.cache.setConversationProjectId(args.conversationId, args.projectId);
  }

  listConversationsForProjectBackfill() {
    return this.cache.listConversationsForProjectBackfill();
  }

  getLatestConversation() {
    return this.cache.getLatestConversation();
  }

  hasOrphanRows(): boolean {
    return this.cache.hasOrphanProjectId();
  }
}
