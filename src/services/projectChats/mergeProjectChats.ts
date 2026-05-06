import type { ProjectChat } from "../../schemas/projectChat.schema";
import { sortProjectChats } from "./sortProjectChats";

/**
 * Merge active sessions and historical conversations into a single
 * ProjectChat list, hiding any conversation that has been resumed into
 * an active session.
 */
export function mergeProjectChats(args: {
  sessions: ProjectChat[];
  conversations: ProjectChat[];
}): ProjectChat[] {
  const { sessions, conversations } = args;

  const resumedConversationIds = new Set<string>(
    sessions
      .filter((c): c is Extract<ProjectChat, { type: "session" }> => c.type === "session")
      .map((c) => c.resumedFromConversationId)
      .filter((id): id is string => Boolean(id)),
  );

  const visibleConversations = conversations.filter((c) => {
    if (c.type !== "conversation") return true;
    return !resumedConversationIds.has(c.id);
  });

  return [...sessions, ...visibleConversations].sort(sortProjectChats);
}
