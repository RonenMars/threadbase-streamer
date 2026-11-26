import { StreamerHttpError } from "../cli/mcp/client";
import { listProjectsTools } from "../cli/mcp/list-projects";
import { searchConversationsTools } from "../cli/mcp/search-conversations";
import { POLL_MS, waitForTurnTools } from "../cli/mcp/wait-for-turn";

const body = (res: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(res.content[0].text as string);
const clientOf = (get: (p: string) => unknown) => ({ get: async (p: string) => get(p) }) as never;

describe("search_conversations handler", () => {
  const tool = searchConversationsTools[0];

  it("builds the search query and maps hits, with the next offset as cursor", async () => {
    const paths: string[] = [];
    const res = await tool.handler(
      { q: "redate", provider: "codex-cli", project: "/p/x/", limit: 2, cursor: "4" },
      clientOf((p) => {
        paths.push(p);
        return {
          hasMore: true,
          offset: 4,
          conversations: [
            {
              id: "c1",
              projectPath: "/p/x",
              provider: "codex-cli",
              lastActivity: "t",
              matches: [{ snippet: "the redate rule" }],
            },
            {
              id: "c2",
              projectPath: "/p/x",
              provider: "codex-cli",
              lastActivity: "t",
              matches: [],
            },
          ],
        };
      }),
    );
    const url = new URL(`http://x${paths[0]}`);
    expect(url.pathname).toBe("/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "redate",
      limit: "2",
      offset: "4",
      provider: "codex-cli",
      projectPath: "/p/x",
    });
    const out = body(res);
    expect(out.results[0]).toEqual({
      id: "c1",
      name: null,
      provider: "codex-cli",
      projectPath: "/p/x",
      lastActivityAt: "t",
      snippets: ["the redate rule"],
    });
    expect(out.nextCursor).toBe("6");
  });

  it("returns a null cursor on the last page and rejects a bad cursor", async () => {
    const res = await tool.handler(
      { q: "x", limit: 20 },
      clientOf(() => ({ hasMore: false, offset: 0, conversations: [] })),
    );
    expect(body(res).nextCursor).toBeNull();
    await expect(
      tool.handler(
        { q: "x", limit: 20, cursor: "-1" },
        clientOf(() => ({})),
      ),
    ).rejects.toThrow("Invalid cursor.");
  });
});

describe("list_projects handler", () => {
  const tool = listProjectsTools[0];

  it("pages the summary route and maps each project", async () => {
    const paths: string[] = [];
    const res = await tool.handler(
      { limit: 1 },
      clientOf((p) => {
        paths.push(p);
        return {
          hasMore: true,
          offset: 0,
          projects: [
            {
              name: "tb",
              path: "/p/tb",
              conversationCount: 9,
              lastActivity: "t",
              liveExternalCount: 2,
            },
          ],
        };
      }),
    );
    expect(paths).toEqual(["/api/projects/summary?limit=1&offset=0"]);
    expect(body(res)).toEqual({
      projects: [
        {
          name: "tb",
          path: "/p/tb",
          conversationCount: 9,
          liveExternalSessions: 2,
          lastActivityAt: "t",
        },
      ],
      nextCursor: "1",
    });
  });
});

describe("wait_for_turn handler", () => {
  const tool = waitForTurnTools[0];
  const session = (over: object) => ({
    id: "s1",
    projectName: "tb",
    projectPath: "/p/tb",
    status: "running",
    hasOpenPrompt: false,
    ...over,
  });

  afterEach(() => vi.useRealTimers());

  it("returns at once when the session is already settled", async () => {
    let calls = 0;
    const res = await tool.handler(
      { sessionId: "s1", timeoutSeconds: 120 },
      clientOf(() => {
        calls++;
        return session({ status: "idle" });
      }),
    );
    expect(body(res).outcome).toBe("idle");
    expect(calls).toBe(1);
  });

  it("puts needs_you ahead of waiting_input", async () => {
    const res = await tool.handler(
      { sessionId: "s1", timeoutSeconds: 120 },
      clientOf(() => session({ status: "waiting_input", hasOpenPrompt: true })),
    );
    expect(body(res).outcome).toBe("needs_you");
    expect(body(res).session.needsYou).toBe(true);
  });

  it("polls a running session until its turn ends", async () => {
    vi.useFakeTimers();
    const states = ["running", "running", "waiting_input"];
    let i = 0;
    const p = tool.handler(
      { sessionId: "s1", timeoutSeconds: 120 },
      clientOf(() => session({ status: states[i++] })),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const res = await p;
    expect(body(res).outcome).toBe("waiting_input");
    expect(i).toBe(3);
  });

  it("answers timeout, not an error, when the turn outlasts the wait", async () => {
    vi.useFakeTimers();
    const p = tool.handler(
      { sessionId: "s1", timeoutSeconds: 3 },
      clientOf(() => session({})),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const out = body(await p);
    expect(out.outcome).toBe("timeout");
    expect(out.session.status).toBe("running");
  });

  it("fails at once on an unknown id", async () => {
    await expect(
      tool.handler(
        { sessionId: "nope", timeoutSeconds: 120 },
        clientOf(() => {
          throw new StreamerHttpError(404, "x");
        }),
      ),
    ).rejects.toThrow("Session not found.");
  });
});
