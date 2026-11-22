/**
 * `handoff_to_threadbase` identifies its own Claude session by walking up the
 * process tree to the first pid with a registry entry, then asks the streamer
 * to adopt it after the turn. Every refusal must reach the agent as a message
 * it can relay, and an older streamer (no route, bare 404) must not be read as
 * a refusal of ours.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../cli/mcp";
import { StreamerHttpError } from "../cli/mcp/client";
import {
  findOwnSession,
  makeHandoffTools,
  NOT_CLAUDE,
  SCHEDULED,
  TOO_OLD,
} from "../cli/mcp/handoff";

const SESSION = "bbbbbbbb-1111-4222-8333-444444444444";
const KEY = "tb_unit_test_key_0123456789abcdef";

describe("findOwnSession", () => {
  it("resolves the first ancestor with a registry entry", async () => {
    const parents: Record<number, number> = { 300: 200, 200: 100, 100: 1 };
    const seen: number[] = [];
    const entry = await findOwnSession({
      startPid: 300,
      platform: "darwin",
      parentOf: async (pid) => parents[pid] ?? null,
      readEntry: async (pid) => {
        seen.push(pid);
        return pid === 200 ? { pid, sessionId: SESSION } : null;
      },
    });
    expect(entry).toEqual({ pid: 200, sessionId: SESSION });
    expect(seen).toEqual([300, 200]);
  });

  it("returns null when no ancestor has an entry", async () => {
    const entry = await findOwnSession({
      startPid: 300,
      platform: "linux",
      parentOf: async (pid) => (pid > 2 ? pid - 1 : null),
      readEntry: async () => null,
    });
    expect(entry).toBeNull();
  });

  it("returns null on Windows without reading anything", async () => {
    const readEntry = vi.fn();
    expect(await findOwnSession({ startPid: 300, platform: "win32", readEntry })).toBeNull();
    expect(readEntry).not.toHaveBeenCalled();
  });
});

describe("handoff_to_threadbase handler", () => {
  const own = { pid: 200, sessionId: SESSION };
  const tool = (find = async () => own as never) => makeHandoffTools(find)[0];
  const refuse = (status: number, code?: string) => async () => {
    throw new StreamerHttpError(status, `The streamer answered HTTP ${status}.`, code);
  };

  it("refuses a non-Claude caller without calling the streamer", async () => {
    const post = vi.fn();
    await expect(tool(async () => null).handler({}, { post } as never)).rejects.toThrow(NOT_CLAUDE);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts its own pid to its own session's route and tells the agent to finish", async () => {
    const post = vi.fn(async () => ({ scheduled: true }));
    const res = await tool().handler({}, { post } as never);
    expect(post).toHaveBeenCalledWith(`/api/sessions/${SESSION}/adopt-after-turn`, { pid: 200 });
    expect(JSON.stringify(res)).toContain(SCHEDULED);
  });

  it("reads a 404 with no code as a streamer without the route", async () => {
    await expect(tool().handler({}, { post: refuse(404) } as never)).rejects.toThrow(TOO_OLD);
  });

  it.each([
    [404, "HANDOFF_NOT_DISCOVERED", /cannot see this session/],
    [409, "HANDOFF_ALREADY_MANAGED", /already managed by Threadbase/],
    [409, "HANDOFF_NO_TURN_STATE", /turn state/],
    [400, "HANDOFF_SESSION_MISMATCH", /identity/],
    [400, "ADOPT_PROJECT_PATH_MISSING", /project directory/],
  ])("maps %i %s to its own message", async (status, code, message) => {
    const run = tool().handler({}, { post: refuse(status, code) } as never);
    await expect(run).rejects.toThrow(message);
    await expect(run).rejects.not.toThrow(TOO_OLD);
  });

  it("keeps the streamer's message for an unknown code", async () => {
    await expect(
      tool().handler({}, { post: refuse(400, "SOMETHING_NEW") } as never),
    ).rejects.toThrow(/HTTP 400.*keeps running/);
  });
});

describe("handoff tool over MCP", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function connect(fetchFn: typeof fetch) {
    const server = createMcpServer({ baseUrl: "http://127.0.0.1:1", apiKey: KEY, fetchFn });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "mcp-handoff-test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("is listed as destructive, not read-only, while the others stay read-only", async () => {
    const client = await connect(async () => json({}));
    const { tools } = await client.listTools();
    const handoff = tools.find((t) => t.name === "handoff_to_threadbase");
    expect(handoff?.annotations?.readOnlyHint).toBeUndefined();
    expect(handoff?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "streamer_info")?.annotations?.readOnlyHint).toBe(true);
  });

  it("client.post sends the key and a JSON body, and redacts the key from an error", async () => {
    let init: RequestInit | undefined;
    const fetchFn: typeof fetch = async (_url, i) => {
      init = i;
      return json({ error: `bad ${KEY}`, code: "X" }, 400);
    };
    const { StreamerClient } = await import("../cli/mcp/client");
    const client = new StreamerClient({ baseUrl: "http://127.0.0.1:1", apiKey: KEY, fetchFn });
    const err = await client.post("/x", { pid: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(StreamerHttpError);
    expect(err.code).toBe("X");
    expect(err.message).not.toContain(KEY);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"pid":1}');
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
  });
});
