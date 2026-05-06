import type { ConversationCache } from "../../conversation-cache";
import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import type { ProjectChat } from "../../schemas/projectChat.schema";
import type { SessionResponse } from "../../types";
import { refreshConversationCache } from "../conversations/refreshConversationCache";
import { shouldRefreshProjectsFromHdd } from "../conversations/shouldRefreshProjectsFromHdd";
import { ensureSessionProjectIdsFromExistingProjects } from "../sessions/ensureSessionProjectIdsFromExistingProjects";
import { mergeProjectChats } from "./mergeProjectChats";
import { normalizeConversationToProjectChat } from "./normalizeConversationToProjectChat";
import { normalizeSessionToProjectChat } from "./normalizeSessionToProjectChat";

export interface ListProjectChatsDeps {
  cache: ConversationCache;
  projectsRepo: ProjectsRepository;
  conversationsRepo: ConversationsRepository;
  sessionsRepo: SessionsRepository;
  cacheMetadataRepo: CacheMetadataRepository;
  /** Snapshot of session responses; the server already builds these. */
  getSessionResponses: () => SessionResponse[];
}

export interface ListProjectChatsArgs {
  refreshConversations: boolean;
}

/**
 * Compose the full /project-chats list:
 *
 *   1. Force-refresh or check latest HDD conversation id
 *   2. Ensure sessions are linked to existing projects
 *   3. Normalize sessions + conversations into ProjectChat shape
 *   4. Merge, dedupe (resumed conversations), sort
 */
export function listProjectChats(
  deps: ListProjectChatsDeps,
  args: ListProjectChatsArgs,
): ProjectChat[] {
  const {
    cache,
    projectsRepo,
    conversationsRepo,
    sessionsRepo,
    cacheMetadataRepo,
    getSessionResponses,
  } = deps;

  if (
    args.refreshConversations ||
    shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo)
  ) {
    refreshConversationCache({ cache, projectsRepo, conversationsRepo, cacheMetadataRepo });
  }

  ensureSessionProjectIdsFromExistingProjects(projectsRepo, sessionsRepo);

  const sessionResponses = getSessionResponses();
  const sessionChats: ProjectChat[] = [];
  for (const s of sessionResponses) {
    if (!s.projectId) continue; // skip sessions still missing a project link
    sessionChats.push(normalizeSessionToProjectChat(s));
  }

  const conversationChats: ProjectChat[] = [];
  const { conversations } = cache.listConversations({ limit: 1000, offset: 0 });
  for (const c of conversations) {
    if (!c.projectId) continue;
    conversationChats.push(normalizeConversationToProjectChat(c));
  }

  return mergeProjectChats({ sessions: sessionChats, conversations: conversationChats });
}
