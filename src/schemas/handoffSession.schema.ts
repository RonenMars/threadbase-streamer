import { z } from "zod";

/** Body of POST /api/sessions/:id/handoff. Phase 1 clients send `{}`. */
export const HandoffSessionSchema = z.object({
  /** Also open the configured terminal app on the tmux session. */
  openTerminal: z.boolean().optional(),
});
