import { describe, expect, it, vi } from "vitest";
import { handleSendAgentInput } from "../../src/agent/handle-send-agent-input";

function makeDeps(sessionOverrides: Record<string, unknown> = {}) {
  const session = {
    id: "sess_test",
    conversationId: "conv_test",
    currentTurnId: null,
    ...sessionOverrides,
  };
  const sessionStore = {
    getManaged: vi.fn(() => session),
  };
  const cache = {
    getConversationTail: vi.fn(() => null),
  };
  const agentClient = {
    sendUserInput: vi.fn(async () => undefined),
  };
  const agentConfig = {
    enabled: true,
    payload: { limitBytes: 1572864, trajectoryLogBytes: 512000, trajectoryLogTurns: 20 },
    sessionBusyRetryMs: 1000,
  };
  return { sessionStore, cache, agentClient, agentConfig, session };
}

describe("handleSendAgentInput", () => {
  it("returns 400 INPUT_REQUIRED when text is missing", async () => {
    const deps = makeDeps();
    const result = await handleSendAgentInput("sess_test", {}, deps as any);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INPUT_REQUIRED");
  });

  it("returns 400 INPUT_REQUIRED when text is empty string", async () => {
    const deps = makeDeps();
    const result = await handleSendAgentInput("sess_test", { text: "" }, deps as any);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INPUT_REQUIRED");
  });

  it("returns 404 SESSION_NOT_FOUND when session is missing", async () => {
    const deps = makeDeps();
    deps.sessionStore.getManaged.mockReturnValueOnce(null);
    const result = await handleSendAgentInput("sess_missing", { text: "hi" }, deps as any);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns 429 SESSION_BUSY when currentTurnId is set", async () => {
    const deps = makeDeps({ currentTurnId: "turn_running" });
    const result = await handleSendAgentInput("sess_test", { text: "hi" }, deps as any);
    expect(result.status).toBe(429);
    expect(result.body.code).toBe("SESSION_BUSY");
    expect(result.body.retryAfterMs).toBe(1000);
    expect(deps.agentClient.sendUserInput).not.toHaveBeenCalled();
  });

  it("returns 202 with turnId on happy path", async () => {
    const deps = makeDeps();
    const result = await handleSendAgentInput("sess_test", { text: "hello" }, deps as any);
    expect(result.status).toBe(202);
    expect(typeof result.body.turnId).toBe("string");
    expect(result.body.status).toBe("queued");
    expect(deps.agentClient.sendUserInput).toHaveBeenCalledOnce();
  });

  it("sets currentTurnId on the session record before sending the signal", async () => {
    const deps = makeDeps();
    await handleSendAgentInput("sess_test", { text: "hello" }, deps as any);
    expect(deps.session.currentTurnId).toBeTruthy();
    expect(typeof deps.session.currentTurnId).toBe("string");
  });

  it("returns 413 SESSION_HISTORY_FULL when payload exceeds limit", async () => {
    const deps = makeDeps();
    deps.agentConfig.payload.limitBytes = 50; // force exceedance (signal serializes to ~76 bytes)
    const result = await handleSendAgentInput("sess_test", { text: "hello" }, deps as any);
    expect(result.status).toBe(413);
    expect(result.body.code).toBe("SESSION_HISTORY_FULL");
    expect(result.body.limitBytes).toBe(50);
    expect(deps.agentClient.sendUserInput).not.toHaveBeenCalled();
    expect(deps.session.currentTurnId).toBeNull();
  });

  it("returns 503 TEMPORAL_UNAVAILABLE when sendUserInput throws", async () => {
    const deps = makeDeps();
    deps.agentClient.sendUserInput.mockRejectedValueOnce(new Error("temporal down"));
    const result = await handleSendAgentInput("sess_test", { text: "hi" }, deps as any);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("TEMPORAL_UNAVAILABLE");
    // Lock must be released after Temporal failure so the next POST can proceed.
    expect(deps.session.currentTurnId).toBeNull();
  });
});
