import { z } from "zod";

// Body schema for PUT /api/config/claude-flags.
//
// Validated with zod rather than the hand-rolled `typeof` checks used elsewhere
// in server.ts because this payload becomes process argv — it is a genuine trust
// boundary, and the values can disable Claude's permission prompts entirely.
//
// This layer only enforces the SHAPE (a flat map of scalars/string arrays).
// Which ids are legal, and which values each id accepts, is decided by
// validateFlagValues() against the registry in src/claude-flags.ts — one source
// of truth rather than two that can drift.
export const ClaudeFlagsBodySchema = z
  .object({
    values: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
      .default({}),
    // A newline would corrupt the flat one-line-per-key server.yaml, so reject
    // it here with a field error instead of silently stripping it.
    extraArgs: z
      .string()
      .refine((v) => !/[\r\n]/.test(v), "extraArgs must not contain newlines")
      .optional(),
  })
  .strict();

export type ClaudeFlagsBody = z.infer<typeof ClaudeFlagsBodySchema>;
