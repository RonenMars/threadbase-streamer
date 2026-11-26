import { z } from "zod";
import type { SessionResponse } from "../../src/types";
import { StreamerHttpError, type StreamerTool, textResult } from "./client";
import { toMcpSession } from "./list-sessions";

export const POLL_MS = 1000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

// Needs-you first: a gate open on a settled turn is what the caller must act on.
function outcomeOf(s: SessionResponse): "needs_you" | "waiting_input" | "idle" | null {
  if (s.hasOpenPrompt) return "needs_you";
  if (s.status === "waiting_input") return "waiting_input";
  if (s.status === "idle") return "idle";
  return null;
}

const inputSchema = {
  sessionId: z.string().min(1).describe("Session id, as returned by list_sessions."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_S)
    .default(DEFAULT_TIMEOUT_S)
    .describe(`How long to wait, 1-${MAX_TIMEOUT_S} (default ${DEFAULT_TIMEOUT_S}).`),
};

export const waitForTurnTools: StreamerTool[] = [
  {
    name: "wait_for_turn",
    description:
      "Wait until a session finishes its turn, goes idle, or needs the user, then return. " +
      "Returns `{ outcome, session }`: `outcome` is `needs_you`, `waiting_input`, `idle`, or `timeout` when `timeoutSeconds` passed first (call again to keep waiting); " +
      "`session` has the list_sessions shape. Returns at once when the session is already settled. " +
      "If your client cuts tool calls off sooner than the timeout, pass a smaller `timeoutSeconds` and loop. An unknown id is an error.",
    inputSchema,
    handler: async (args, client) => {
      const { sessionId, timeoutSeconds } = args as z.infer<z.ZodObject<typeof inputSchema>>;
      const path = `/api/sessions/${encodeURIComponent(sessionId)}`;
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        let s: SessionResponse;
        try {
          s = await client.get<SessionResponse>(path);
        } catch (err) {
          if (err instanceof StreamerHttpError && err.status === 404) {
            throw new Error("Session not found.");
          }
          throw err;
        }
        const outcome = outcomeOf(s);
        if (outcome) return textResult({ outcome, session: toMcpSession(s) });
        if (Date.now() + POLL_MS > deadline) {
          return textResult({ outcome: "timeout", session: toMcpSession(s) });
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
  },
];
