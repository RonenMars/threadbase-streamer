import { WorkflowNotFoundError } from "@temporalio/client";
import type { ServerResponse } from "http";
import { describe, expect, it, vi } from "vitest";
import { handleEndAgentSession } from "../../src/agent/handle-end-agent-session";
import {
  SessionHandlers,
  type SessionHandlersDeps,
} from "../../src/api/handlers/sessions.handlers";
import type { ManagedSession, WSMessage } from "../../src/types";

function makeDeps(session: Partial<ManagedSession> | null, endSession = vi.fn(async () => {})) {
  const stored = session ? ({ id: "s1", status: "running", ...session } as ManagedSession) : null;
  const sessionStore = {
    getManaged: vi.fn(() => stored),
    updateManaged: vi.fn((_id: string, updates: Partial<ManagedSession>) =>
      stored ? Object.assign(stored, updates) : null,
    ),
  };
  return { sessionStore, agentClient: { endSession }, stored };
}

describe("handleEndAgentSession", () => {
  it("ends the session workflow and marks the session idle", async () => {
    const deps = makeDeps({ currentTurnId: "t1" });
    const result = await handleEndAgentSession("s1", deps as any);
    expect(deps.agentClient.endSession).toHaveBeenCalledWith("s1");
    expect(result).toEqual({ status: 200, body: { event: "stopped", sessionId: "s1" } });
    expect(deps.stored).toMatchObject({ status: "idle", currentTurnId: null });
  });

  it("answers 404 for an unknown session without calling Temporal", async () => {
    const deps = makeDeps(null);
    const result = await handleEndAgentSession("s1", deps as any);
    expect(result.status).toBe(404);
    expect(deps.agentClient.endSession).not.toHaveBeenCalled();
  });

  it("answers already_idle for an ended session without calling Temporal", async () => {
    const deps = makeDeps({ status: "idle" });
    const result = await handleEndAgentSession("s1", deps as any);
    expect(result).toEqual({ status: 200, body: { status: "already_idle", sessionId: "s1" } });
    expect(deps.agentClient.endSession).not.toHaveBeenCalled();
  });

  it("marks the session idle when its workflow is already gone", async () => {
    const deps = makeDeps(
      {},
      vi.fn(async () => {
        throw new WorkflowNotFoundError("not found", "session-s1", undefined);
      }),
    );
    const result = await handleEndAgentSession("s1", deps as any);
    expect(result.status).toBe(200);
    expect(deps.stored?.status).toBe("idle");
  });

  it("answers 503 and keeps the session running when Temporal is unreachable", async () => {
    const deps = makeDeps(
      {},
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const result = await handleEndAgentSession("s1", deps as any);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("TEMPORAL_UNAVAILABLE");
    expect(deps.stored?.status).toBe("running");
  });
});

describe("POST /:id/kill and /:id/stop in multi-agent mode", () => {
  function setup() {
    const { sessionStore, agentClient, stored } = makeDeps({});
    const broadcasts: WSMessage[] = [];
    const deps = {
      agentConfig: { enabled: true },
      agentClient,
      sessionStore: { ...sessionStore, get: () => ({ id: "s1", status: stored?.status }) },
      ptyAttachedIds: () => new Set<string>(),
      wsHub: { broadcast: (m: WSMessage) => broadcasts.push(m) },
    };
    let status = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (chunk: string) => {
        payload = chunk;
      },
    } as unknown as ServerResponse;
    const handlers = new SessionHandlers(deps as unknown as SessionHandlersDeps);
    return {
      handlers,
      agentClient,
      broadcasts,
      res,
      status: () => status,
      body: () => JSON.parse(payload),
    };
  }

  for (const route of ["kill", "stop"] as const) {
    it(`/${route} ends the session workflow and broadcasts the idle session`, async () => {
      const t = setup();
      if (route === "kill") await t.handlers.handleKillSession("s1", t.res);
      else await t.handlers.handleStopSession("s1", t.res);
      expect(t.agentClient.endSession).toHaveBeenCalledWith("s1");
      expect(t.status()).toBe(200);
      expect(t.body()).toEqual({ event: "stopped", sessionId: "s1" });
      expect(t.broadcasts).toContainEqual({
        type: "session_update",
        session: { id: "s1", status: "idle" },
      });
    });
  }

  it("/kill?delete=true also soft-deletes the conversation", async () => {
    const t = setup();
    const softDelete = vi.spyOn(t.handlers, "softDeleteConversation").mockImplementation(() => {});
    await t.handlers.handleKillSession("s1", t.res, { delete: true });
    expect(softDelete).toHaveBeenCalledWith("s1");
  });
});
