import { z } from "zod";

/**
 * Persisted Project row. Mirrors the projects SQLite table.
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().nullable().optional(),

  lastConversationId: z.string().nullable().optional(),
  lastConversationCreatedAt: z.string().nullable().optional(),
  lastIndexedAt: z.string().nullable().optional(),

  latestMessageAt: z.string().nullable().optional(),
  latestMessageId: z.string().nullable().optional(),
  messageCount: z.number().int().nonnegative().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;
