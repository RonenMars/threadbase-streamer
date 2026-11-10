import { z } from "zod";
import { MAX_OUTPUT_LINES } from "../../src/api/output-lines";
import { StreamerHttpError, type StreamerTool } from "./client";

const DEFAULT_LINES = 50;

interface SessionSummary {
  status?: string;
  ownership?: string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export const tailTerminalTools: StreamerTool[] = [
  {
    name: "tail_terminal",
    description:
      "The most recent rendered terminal lines of a live Threadbase session, as they appear on screen. " +
      `\`lines\` (default ${DEFAULT_LINES}, max ${MAX_OUTPUT_LINES}) bounds how many trailing lines come back. ` +
      "A session with no live terminal (ended, on hold, or run outside the streamer) answers that it is not live; an unknown id is an error.",
    inputSchema: {
      sessionId: z.string().min(1).describe("Session id, as returned by list_sessions."),
      lines: z.number().int().min(1).max(MAX_OUTPUT_LINES).default(DEFAULT_LINES),
    },
    handler: async (args, client) => {
      const id = encodeURIComponent(String(args.sessionId));
      let session: SessionSummary;
      try {
        session = await client.get<SessionSummary>(`/api/sessions/${id}`);
      } catch (err) {
        if (err instanceof StreamerHttpError && err.status === 404) {
          throw new Error("Session not found.");
        }
        throw err;
      }
      if (
        session.ownership === "external" ||
        (session.status !== "running" && session.status !== "waiting_input")
      ) {
        return text("Session is not live: it has no running terminal to tail.");
      }
      const { lines } = await client.get<{ lines: string[] }>(
        `/api/sessions/${id}/output?lines=${args.lines}`,
      );
      return text(lines.join("\n") || "(the terminal has produced no output yet)");
    },
  },
];
