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
  return { sessionStore, agentClient, conversationsDir, agentConfig };
}

describe("handleStartAgentSession", () => {
  it("creates a fresh session when body is empty", async () => {
    const deps = makeDeps();
    const result = await handleStartAgentSession({}, deps as any);
    expect(result.status).toBe(200);
    expect(result.body.sessionId).toBeTruthy();
    expect(result.body.conversationId).toBe(result.body.sessionId);
    expect(result.body.status).toBe("running");
    expect(deps.sessionStore.addManaged).toHaveBeenCalledOnce();
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
