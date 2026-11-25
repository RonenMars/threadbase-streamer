import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleStartAgentSession } from "../../src/agent/handle-start-agent-session";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

function makeDeps() {
  const sessionStore = {
    addManaged: vi.fn(),
    initAgentSession: vi.fn(),
  };
  const agentClient = {
    startSession: vi.fn(async (sessionId: string) => sessionId),
  };
  const conversationsDir = "/tmp/test-conversations";
  const agentConfig = {
    enabled: true,
    dedupe: { perSessionCapacity: 64 },
  };
  const resolveProjectPath = vi.fn(async (path: string) => {
    if (path.includes("..")) throw new Error("Path outside browse root");
    return `/browse/${path}`;
  });
  return { sessionStore, agentClient, conversationsDir, agentConfig, resolveProjectPath };
}

describe("handleStartAgentSession", () => {
  it("creates a fresh session when body is empty", async () => {
    const deps = makeDeps();
    const result = await handleStartAgentSession({}, deps as any);
    expect(result.status).toBe(200);
    expect(result.body.sessionId).toBeTruthy();
    expect(result.body.conversationId).toBe(result.body.sessionId);
    expect(result.body.status).toBe("running");
    expect(deps.sessionStore.addManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        // Multi-agent marker: defined (null between turns). PTY sessions leave
        // it undefined, which is what managedToResponse uses to tell them apart.
        currentTurnId: null,
      }),
    );
    expect(deps.sessionStore.initAgentSession).toHaveBeenCalledOnce();
    expect(deps.agentClient.startSession).toHaveBeenCalledWith(result.body.sessionId);
  });

  it("resumes when body has conversationId and JSONL exists", async () => {
    const deps = makeDeps();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await handleStartAgentSession({ conversationId: "conv_old" }, deps as any);
    expect(result.status).toBe(200);
    expect(result.body.conversationId).toBe("conv_old");
    expect(result.body.sessionId).not.toBe("conv_old");
    expect(deps.sessionStore.addManaged).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv_old" }),
    );
  });

  it("returns 404 CONVERSATION_NOT_FOUND when resume target JSONL is missing", async () => {
    const deps = makeDeps();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await handleStartAgentSession({ conversationId: "conv_missing" }, deps as any);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("CONVERSATION_NOT_FOUND");
    expect(deps.agentClient.startSession).not.toHaveBeenCalled();
  });

  it("resolves body path and passes it to the session and the workflow", async () => {
    const deps = makeDeps();
    const result = await handleStartAgentSession({ path: "repo" }, deps as any);
    expect(result.status).toBe(200);
    expect(deps.resolveProjectPath).toHaveBeenCalledWith("repo");
    expect(deps.sessionStore.addManaged).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/browse/repo" }),
    );
    expect(deps.agentClient.startSession).toHaveBeenCalledWith(result.body.sessionId, {
      projectPath: "/browse/repo",
    });
  });

  it("accepts a path together with a conversationId", async () => {
    const deps = makeDeps();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await handleStartAgentSession(
      { conversationId: "conv_old", path: "repo" },
      deps as any,
    );
    expect(result.status).toBe(200);
    expect(result.body.conversationId).toBe("conv_old");
    expect(deps.agentClient.startSession).toHaveBeenCalledWith(result.body.sessionId, {
      projectPath: "/browse/repo",
    });
  });

  it("returns 400 INVALID_BODY when the path is not allowed, without starting a session", async () => {
    const deps = makeDeps();
    const result = await handleStartAgentSession({ path: "../etc" }, deps as any);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_BODY");
    expect(result.body.error).toBe("Path outside browse root");
    expect(deps.sessionStore.addManaged).not.toHaveBeenCalled();
    expect(deps.agentClient.startSession).not.toHaveBeenCalled();
  });

  it.each([[{ path: "" }], [{ path: 3 }], [{ conversationId: "" }]])(
    "returns 400 INVALID_BODY for %j",
    async (body) => {
      const deps = makeDeps();
      const result = await handleStartAgentSession(body as any, deps as any);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("INVALID_BODY");
      expect(deps.resolveProjectPath).not.toHaveBeenCalled();
    },
  );

  it("returns 400 INVALID_BODY when body has unknown shape", async () => {
    const deps = makeDeps();
    const result = await handleStartAgentSession({ randomField: "x" } as any, deps as any);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_BODY");
  });

  it("returns 503 TEMPORAL_UNAVAILABLE when agentClient.startSession throws", async () => {
    const deps = makeDeps();
    deps.agentClient.startSession.mockRejectedValueOnce(new Error("connect failed"));
    const result = await handleStartAgentSession({}, deps as any);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("TEMPORAL_UNAVAILABLE");
  });
});
