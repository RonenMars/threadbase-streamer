import type { ConversationScanner } from "@threadbase/scanner";
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

/**
 * Subset of ConversationScanner we depend on. Typed structurally so tests
 * can pass a lightweight fake without instantiating the real scanner.
 */
export type ScannerLike = Pick<ConversationScanner, "scan" | "getMetadataCache">;

export interface ListProjectChatsDeps {
  cache: ConversationCache;
  projectsRepo: ProjectsRepository;
  conversationsRepo: ConversationsRepository;
  sessionsRepo: SessionsRepository;
  cacheMetadataRepo: CacheMetadataRepository;
  /** Snapshot of session responses; the server already builds these. */
  getSessionResponses: () => SessionResponse[];
  /**
   * Return a scanner whose metadata cache reflects the current disk state.
   * Called only when the cache needs a rebuild. Implementations are
   * responsible for invalidating any prior scanner and running scan()
   * before returning — listProjectChats reads getMetadataCache() directly.
   */
  getFreshScanner: () => Promise<ScannerLike>;
  /** Override the disk path checked for drift. Defaults to ~/.claude/projects. */
  projectsDir?: string;
}

export interface ListProjectChatsArgs {
  refreshConversations: boolean;
}

/**
 * Compose the full /project-chats list:
 *
 *   1. Force-refresh or detect drift (orphan rows or projects-dir mtime).
 *   2. When drift detected, run the scanner + upsert into the cache so new
 *      JSONLs become visible. Then run project_id backfill.
 *   3. Ensure managed sessions are linked to existing projects.
 *   4. Normalize sessions + conversations into ProjectChat shape.
 *   5. Merge, dedupe (resumed conversations), sort.
 */
export async function listProjectChats(
  deps: ListProjectChatsDeps,
  args: ListProjectChatsArgs,
): Promise<ProjectChat[]> {
  const {
    cache,
    projectsRepo,
    conversationsRepo,
    sessionsRepo,
    cacheMetadataRepo,
    getSessionResponses,
    getFreshScanner,
    projectsDir,
  } = deps;

  const needsRefresh =
    args.refreshConversations ||
    shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir });

  if (needsRefresh) {
    const scanner = await getFreshScanner();
    const metas = [...scanner.getMetadataCache().values()];
    if (metas.length > 0) {
      cache.upsertFromScannerMeta(metas as never);
    }
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
