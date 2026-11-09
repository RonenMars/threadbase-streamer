import { z } from "zod";
import { PROVIDER_NAMES } from "../../src/providers";
import type { SessionResponse, SessionStatus } from "../../src/types";
import { canonicalizeProjectPath } from "../../src/utils/canonicalizeProjectPath";
import { type StreamerTool, textResult } from "./client";

// The vocabulary `GET /api/sessions` emits and its `?status=` accepts; `on_hold`
// is a resumable conversation, which that route never lists.
const STATUSES = ["running", "waiting_input", "idle"] as const satisfies readonly SessionStatus[];

interface SessionsPage {
  sessions: SessionResponse[];
  nextCursor: string | null;
}

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe("Only sessions whose project name or project path equals this."),
  provider: z.enum(PROVIDER_NAMES).optional().describe("Only sessions of this provider."),
  status: z.enum(STATUSES).optional().describe("Only sessions in this status."),
  needsYou: z
    .boolean()
    .optional()
    .describe("true: only sessions waiting on the user; false: only those that are not."),
  limit: z.number().int().min(1).max(100).default(20).describe("Page size, 1-100 (default 20)."),
  cursor: z.string().optional().describe("`nextCursor` from the previous page."),
};

export const listSessionsTools: StreamerTool[] = [
  {
    name: "list_sessions",
    description:
      "Sessions the Threadbase streamer on this machine knows about, Threadbase-owned and External alike, newest started first. " +
      "Returns `{ sessions, nextCursor }`; pass `nextCursor` back as `cursor` for the next page (null when there is none; a page can be empty while `nextCursor` is still set). " +
      "Each session: `id`, `name` (null when unnamed), `provider` (claude-code, codex-cli, cursor, copilot), `projectName`, `projectPath`, " +
      "`status` (`running` the agent is working, `waiting_input` it finished its turn, `idle` no live process or not observable), " +
      "`needsYou` (a question or permission prompt is waiting on the user), " +
      "`ownership` (`threadbase` when Threadbase started it, `external` when it was started outside Threadbase and is view only), " +
      "and `lastActivityAt` (ISO time, null when unknown). " +
      "Filters combine: project, provider, status, needsYou.",
    inputSchema,
    handler: async (args, client) => {
      const { project, provider, status, needsYou, limit, cursor } = args as z.infer<
        z.ZodObject<typeof inputSchema>
      >;
      const wanted = project === undefined ? undefined : canonicalizeProjectPath(project);
      const matches = (s: SessionResponse) =>
        (wanted === undefined ||
          s.projectName === project ||
          canonicalizeProjectPath(s.projectPath) === wanted) &&
        (provider === undefined || s.provider === provider) &&
        (needsYou === undefined || s.hasOpenPrompt === needsYou);

      // Each REST page asks for exactly the rows still missing and is consumed
      // whole, so the REST cursor is always the exact resume point and is passed
      // through as ours. `startedAt` because it never changes, so a walk cannot repeat a row.
      // ponytail: one request per page while a filter keeps missing; fine at hundreds of sessions.
      const out: SessionResponse[] = [];
      let next: string | null = cursor ?? null;
      do {
        const params = new URLSearchParams({
          limit: String(limit - out.length),
          sortBy: "startedAt",
          order: "desc",
        });
        if (status) params.set("status", status);
        if (next) params.set("cursor", next);
        const page = await client.get<SessionsPage>(`/api/sessions?${params}`);
        out.push(...page.sessions.filter(matches));
        next = page.nextCursor;
      } while (next && out.length < limit);

      return textResult({
        sessions: out.map((s) => ({
          id: s.id,
          name: s.sessionName ?? null,
          provider: s.provider ?? null,
          projectName: s.projectName,
          projectPath: s.projectPath,
          status: s.status,
          needsYou: s.hasOpenPrompt,
          ownership: s.ownership === "external" ? "external" : "threadbase",
          lastActivityAt: s.lastActivityAt ?? null,
        })),
        nextCursor: next,
      });
    },
  },
];
