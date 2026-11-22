import { z } from "zod";
import { PROVIDER_NAMES } from "../../src/providers";
import { MAX_SEARCH_LIMIT } from "../../src/services/search/searchQuery";
import { canonicalizeProjectPath } from "../../src/utils/canonicalizeProjectPath";
import { type StreamerTool, textResult } from "./client";

interface SearchHit {
  id: string;
  sessionName?: string;
  projectPath: string;
  provider: string;
  lastActivity: string;
  matches: Array<{ snippet: string }>;
}

interface SearchPage {
  conversations: SearchHit[];
  hasMore: boolean;
  offset: number;
}

const inputSchema = {
  q: z.string().trim().min(1).describe("Words to search for."),
  provider: z.enum(PROVIDER_NAMES).optional().describe("Only conversations of this provider."),
  project: z.string().optional().describe("Only conversations whose project path equals this."),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(20),
  cursor: z.string().optional().describe("`nextCursor` from the previous page."),
};

export const searchConversationsTools: StreamerTool[] = [
  {
    name: "search_conversations",
    description:
      "Full-text search across past conversations of every provider on this machine, best match first. " +
      "Returns `{ results, nextCursor }`; pass `nextCursor` back as `cursor` for the next page (null when there is none). " +
      "Each result: `id` (pass it to read_conversation), `name`, `provider`, `projectPath`, `lastActivityAt` and `snippets` (the matching text). " +
      "Filters combine: provider, project.",
    inputSchema,
    handler: async (args, client) => {
      const { q, provider, project, limit, cursor } = args as z.infer<
        z.ZodObject<typeof inputSchema>
      >;
      // The route pages by offset; the cursor is that offset, opaque to the agent.
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid cursor.");
      const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
      if (provider) params.set("provider", provider);
      if (project) params.set("projectPath", canonicalizeProjectPath(project));
      const page = await client.get<SearchPage>(`/api/search?${params}`);
      return textResult({
        results: page.conversations.map((c) => ({
          id: c.id,
          name: c.sessionName ?? null,
          provider: c.provider,
          projectPath: c.projectPath,
          lastActivityAt: c.lastActivity ?? null,
          snippets: c.matches.map((m) => m.snippet),
        })),
        nextCursor: page.hasMore ? String(offset + page.conversations.length) : null,
      });
    },
  },
];
