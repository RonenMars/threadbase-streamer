import { z } from "zod";

/**
 * Shape of a single conversation as produced by the HDD scanner. Used to
 * validate scanner output at the boundary before we feed it into the
 * projects/conversations refresh pipeline.
 */
export const ScannedConversationSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  latestMessageAt: z.string().datetime().nullable().optional(),
});

export type ScannedConversation = z.infer<typeof ScannedConversationSchema>;
