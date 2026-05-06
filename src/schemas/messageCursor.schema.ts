import { z } from "zod";

/**
 * Compound cursor for paginated message sync. Used by the active-session
 * delta sync flow described in the refactor plan; encoded as base64url JSON.
 */
export const MessageCursorSchema = z.object({
  timestamp: z.string().datetime(),
  id: z.string().min(1),
});

export type MessageCursor = z.infer<typeof MessageCursorSchema>;
