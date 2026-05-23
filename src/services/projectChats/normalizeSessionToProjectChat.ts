import type { SessionProjectChat } from "../../schemas/projectChat.schema";
import type { SessionResponse } from "../../types";
import { deriveProjectChatTitle } from "./deriveProjectChatTitle";

/**
 * Normalize a SessionResponse into the union ProjectChat shape used by
 * the GET /project-chats endpoint.
 *
 * The session must already have projectId resolved by the service layer
 * (see linkSessionAndConversationToProject /
 * ensureSessionProjectIdsFromExistingProjects). This pure function does
 * NOT attempt to repair missing ids; it expects them to be present.
 */
export function normalizeSessionToProjectChat(session: SessionResponse): SessionProjectChat {
  if (!session.projectId) {
    throw new Error(
      `normalizeSessionToProjectChat: session ${session.id} has no projectId — resolve it before normalizing`,
    );
  }
  return {
    type: "session",
    id: session.id,
    projectId: session.projectId,
    projectPath: session.projectPath ?? null,
    title: deriveProjectChatTitle({
      title: session.sessionName,
      projectName: session.projectName,
      projectPath: session.projectPath,
      id: session.id,
    }),
    latestMessageAt: session.lastMessageAt ?? session.lastActivityAt ?? null,
    updatedAt: session.lastActivityAt ?? null,
    createdAt: session.startedAt ?? null,
    status: "active",
    source: "session-store",
    resumedFromConversationId: session.resumedFromConversationId ?? null,
  };
}
