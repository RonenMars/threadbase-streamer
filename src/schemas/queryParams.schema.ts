import { z } from "zod";

/**
 * Query parameters accepted by GET /project-chats.
 *
 *   refreshConversations=1  → force a full conversation/projects refresh.
 *   refresh=1               → legacy alias kept for compatibility with the
 *                             existing /api/conversations refresh semantic.
 */
export const ListProjectChatsQuerySchema = z.object({
  refresh: z.enum(["1"]).optional(),
  refreshConversations: z.enum(["1"]).optional(),
});

export type ListProjectChatsQuery = z.infer<typeof ListProjectChatsQuerySchema>;
