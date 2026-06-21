import type { ConversationListItem } from "../../conversation-cache";
import type { ConversationProjectChat } from "../../schemas/projectChat.schema";
import { deriveProjectChatTitle } from "./deriveProjectChatTitle";

/**
 * Normalize a cached conversation row into the union ProjectChat shape.
 *
 * Resolves to a "resumable" conversation by default. The caller (merge
 * step) may choose to suppress conversations that have been resumed into
 * an active session.
 */
export function normalizeConversationToProjectChat(
  conversation: ConversationListItem,
): ConversationProjectChat {
  if (!conversation.projectId) {
    throw new Error(
      `normalizeConversationToProjectChat: conversation ${conversation.id} has no projectId — resolve it before normalizing`,
    );
  }
  return {
    type: "conversation",
    id: conversation.id,
    projectId: conversation.projectId,
    projectPath: conversation.projectPath ?? null,
    title: deriveProjectChatTitle({
      title: conversation.title,
      projectName: conversation.projectName,
      projectPath: conversation.projectPath,
      id: conversation.id,
    }),
    latestMessageAt: conversation.lastActivity ?? null,
    updatedAt: conversation.lastActivity ?? null,
    createdAt: null,
    status: "resumable",
    source: "hdd-cache",
    provider: conversation.provider ?? "threadbase",
    indexedAt: null,
    fileMtime: null,
    filePath: conversation.filePath ?? null,
    sourceHash: null,
  };
}
