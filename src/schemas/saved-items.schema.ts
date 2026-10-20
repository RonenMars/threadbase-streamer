import { z } from "zod";

export const SAVED_ITEMS_MAX = 500;

const Id = z.string().min(1).max(256);
const Label = z.string().trim().min(1).max(200);

const SessionItemSchema = z.object({
  kind: z.literal("session"),
  label: Label,
  sessionId: Id,
  projectId: Id.optional(),
});

const ConversationItemSchema = z.object({
  kind: z.literal("conversation"),
  label: Label,
  conversationId: Id,
  projectId: Id.optional(),
});

const ProjectChatItemSchema = z.object({
  kind: z.literal("project-chat"),
  label: Label,
  chatType: z.enum(["session", "conversation"]),
  chatId: Id,
  projectId: Id,
});

export const SavedItemInputSchema = z.discriminatedUnion("kind", [
  SessionItemSchema,
  ConversationItemSchema,
  ProjectChatItemSchema,
]);

export type SavedItemInput = z.infer<typeof SavedItemInputSchema>;

export const SavedItemsOrderSchema = z.object({
  keys: z.array(z.string().min(1).max(600)).max(SAVED_ITEMS_MAX),
});

/**
 * The stored key for an item. Derived, never client-chosen, so two phones that
 * save the same conversation land on the same row whatever they call the server
 * locally.
 */
export function savedItemKey(item: SavedItemInput): string {
  switch (item.kind) {
    case "session":
      return `session::${item.sessionId}`;
    case "conversation":
      return `conversation::${item.conversationId}`;
    case "project-chat":
      return `project-chat::${item.chatType}::${item.chatId}`;
  }
}
