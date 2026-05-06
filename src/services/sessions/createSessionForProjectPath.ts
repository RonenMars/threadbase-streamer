import type { CacheMetadataRepository } from "../../db/repositories/cacheMetadata.repository";
import type { ConversationsRepository } from "../../db/repositories/conversations.repository";
import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import type { SessionsRepository } from "../../db/repositories/sessions.repository";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";
import { setCacheMetadata } from "../cache/cacheMetadata";

export interface LinkSessionToProjectArgs {
  sessionId: string;
  projectPath: string;
  conversationId: string;
  conversationCreatedAt?: string | null;
  latestMessageAt?: string | null;
}

export interface LinkSessionToProjectDeps {
  projectsRepo: ProjectsRepository;
  conversationsRepo: ConversationsRepository;
  sessionsRepo: SessionsRepository;
  cacheMetadataRepo: CacheMetadataRepository;
}

/**
 * After a PTY session has been created and its conversation .jsonl is on
 * disk, link both the conversation and the session to a project row.
 * Idempotent: re-running with the same inputs returns the same project.
 *
 * Order matters:
 *   1. Upsert project by canonical path
 *   2. Update conversation.project_id
 *   3. Update session.project_id
 *   4. Update cache_metadata.last_conversation_id
 */
export function linkSessionAndConversationToProject(
  deps: LinkSessionToProjectDeps,
  args: LinkSessionToProjectArgs,
): { projectId: string } {
  const canonical = canonicalizeProjectPath(args.projectPath);

  const project = deps.projectsRepo.upsertProjectByPath(canonical, {
    lastConversationId: args.conversationId,
    lastConversationCreatedAt: args.conversationCreatedAt ?? null,
    latestMessageAt: args.latestMessageAt ?? null,
  });

  deps.conversationsRepo.updateConversationProjectId({
    conversationId: args.conversationId,
    projectId: project.id,
  });

  deps.sessionsRepo.updateSessionProjectId({
    sessionId: args.sessionId,
    projectId: project.id,
  });

  setCacheMetadata(deps.cacheMetadataRepo, "last_conversation_id", args.conversationId);
  if (args.conversationCreatedAt) {
    setCacheMetadata(
      deps.cacheMetadataRepo,
      "last_conversation_created_at",
      args.conversationCreatedAt,
    );
  }

  return { projectId: project.id };
}
