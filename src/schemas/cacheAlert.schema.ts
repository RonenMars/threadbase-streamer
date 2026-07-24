import { z } from "zod";

/** Body for POST /api/cache/alert/resolve. */
export const ResolveCacheAlertSchema = z
  .object({
    fingerprint: z.string(),
    action: z.enum(["prune_all", "prune_selected", "ignore", "reset_rescan"]),
    ids: z.array(z.string()).optional(),
  })
  .refine((v) => v.action !== "prune_selected" || (v.ids !== undefined && v.ids.length > 0), {
    message: "prune_selected requires a non-empty ids array",
    path: ["ids"],
  });

export type ResolveCacheAlertBody = z.infer<typeof ResolveCacheAlertSchema>;
