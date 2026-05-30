import { z } from "zod";

export const MarkerSchema = z.object({
  devPid: z.number().int().positive(),
  port: z.number().int().positive(),
  repoToplevel: z.string().min(1),
  suspendedAt: z.string().datetime(),
  userHeld: z.boolean(),
  shimVersion: z.literal(1),
});

export type Marker = z.infer<typeof MarkerSchema>;
