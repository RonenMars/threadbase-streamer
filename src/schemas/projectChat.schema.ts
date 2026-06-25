import { z } from "zod";

/**
 * UI-facing union returned by GET /project-chats.
 *
 * The two variants share most fields but disambiguate on the `type`
 * discriminator. `projectId` is required on both during/after the
 * migration; `projectPath` remains as compatibility metadata.
 */
const Common = {
  id: z.string().min(1),
  projectId: z.string().min(1),
  projectPath: z.string().nullable().optional(),
  title: z.string(),
  latestMessageAt: z.string().nullable(),
  updatedAt: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
};

export const SessionProjectChatSchema = z.object({
  type: z.literal("session"),
  ...Common,
  status: z.literal("active"),
  source: z.literal("session-store"),
  resumedFromConversationId: z.string().nullable().optional(),
});

export const ConversationProjectChatSchema = z.object({
  type: z.literal("conversation"),
  ...Common,
  status: z.enum(["archived", "resumable"]),
  source: z.literal("hdd-cache"),
  provider: z.enum(["claude-code", "codex-cli"]).default("claude-code"),
  indexedAt: z.string().nullable().optional(),
  fileMtime: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  sourceHash: z.string().nullable().optional(),
});

export const ProjectChatSchema = z.discriminatedUnion("type", [
  SessionProjectChatSchema,
  ConversationProjectChatSchema,
]);

export type ProjectChat = z.infer<typeof ProjectChatSchema>;
export type SessionProjectChat = z.infer<typeof SessionProjectChatSchema>;
export type ConversationProjectChat = z.infer<typeof ConversationProjectChatSchema>;
