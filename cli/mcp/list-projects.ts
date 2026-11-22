import { z } from "zod";
import { type StreamerTool, textResult } from "./client";

interface ProjectsPage {
  projects: Array<{
    name: string;
    path: string;
    conversationCount: number;
    lastActivity: string;
    liveExternalCount: number;
  }>;
  hasMore: boolean;
  offset: number;
}

const inputSchema = {
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional().describe("`nextCursor` from the previous page."),
};

export const listProjectsTools: StreamerTool[] = [
  {
    name: "list_projects",
    description:
      "Projects with conversations on this machine, most recently active first. " +
      "Returns `{ projects, nextCursor }`; pass `nextCursor` back as `cursor` for the next page (null when there is none). " +
      "Each project: `name` and `path` (either works as list_sessions' `project` filter, the path as search_conversations' `project`), " +
      "`conversationCount`, `liveExternalSessions` (agents running there outside Threadbase) and `lastActivityAt`.",
    inputSchema,
    handler: async (args, client) => {
      const { limit, cursor } = args as z.infer<z.ZodObject<typeof inputSchema>>;
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid cursor.");
      const page = await client.get<ProjectsPage>(
        `/api/projects/summary?limit=${limit}&offset=${offset}`,
      );
      return textResult({
        projects: page.projects.map((p) => ({
          name: p.name,
          path: p.path,
          conversationCount: p.conversationCount,
          liveExternalSessions: p.liveExternalCount,
          lastActivityAt: p.lastActivity ?? null,
        })),
        nextCursor: page.hasMore ? String(offset + page.projects.length) : null,
      });
    },
  },
];
