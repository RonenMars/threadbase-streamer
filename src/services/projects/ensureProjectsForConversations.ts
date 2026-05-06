import type { ProjectsRepository } from "../../db/repositories/projects.repository";
import { canonicalizeProjectPath } from "../../utils/canonicalizeProjectPath";
import { compareIsoDesc } from "../../utils/dates";

export interface ConversationLikeForProjects {
  id: string;
  projectPath: string | null | undefined;
  createdAt?: string | null;
  latestMessageAt?: string | null;
}

/**
 * Group cached conversations by their canonical project path, find the
 * latest conversation per project, then upsert one project row per unique
 * path. Returns a map from canonical path → projectId so callers can
 * backfill conversation/session project_id columns afterwards.
 */
export function ensureProjectsForConversations(
  repo: ProjectsRepository,
  conversations: ConversationLikeForProjects[],
): Map<string, string> {
  const conversationsByPath = new Map<string, ConversationLikeForProjects[]>();

  for (const conversation of conversations) {
    if (!conversation.projectPath) continue;
    const canonical = canonicalizeProjectPath(conversation.projectPath);
    if (!canonical) continue;
    const existing = conversationsByPath.get(canonical) ?? [];
    existing.push(conversation);
    conversationsByPath.set(canonical, existing);
  }

  const pathToProjectId = new Map<string, string>();

  for (const [path, projectConversations] of conversationsByPath) {
    const latest = pickLatestConversation(projectConversations);

    const project = repo.upsertProjectByPath(path, {
      lastConversationId: latest?.id ?? null,
      lastConversationCreatedAt: latest?.createdAt ?? null,
      latestMessageAt: latest?.latestMessageAt ?? null,
    });

    pathToProjectId.set(path, project.id);
  }

  return pathToProjectId;
}

function pickLatestConversation(
  conversations: ConversationLikeForProjects[],
): ConversationLikeForProjects | undefined {
  if (conversations.length === 0) return undefined;
  return [...conversations].sort((a, b) => {
    const cmp = compareIsoDesc(a.latestMessageAt ?? null, b.latestMessageAt ?? null);
    if (cmp !== 0) return cmp;
    return compareIsoDesc(a.createdAt ?? null, b.createdAt ?? null);
  })[0];
}
