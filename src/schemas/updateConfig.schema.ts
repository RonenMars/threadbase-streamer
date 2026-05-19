import { z } from "zod";

export const UpdateConfigSchema = z
  .object({
    auto_update: z.boolean().default(false),
    channel: z.enum(["stable", "next"]).default("stable"),
    allow: z.array(z.enum(["patch", "minor", "major"])).default(["patch", "minor"]),
    poll_interval_minutes: z.number().int().min(0).default(60),
    defer_if_active_sessions: z.boolean().default(true),
    github_repo: z.string().regex(/^[^/]+\/[^/]+$/, "github_repo must be 'owner/name'"),
    webhook_secret: z.string().min(1).nullable().default(null),
  })
  .strict();

export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;
