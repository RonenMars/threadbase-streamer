// src/agent/handle-end-agent-session.ts
//
// Pure function (deps in, response out) for ending a multi-agent session:
// cancel its session workflow, then mark the session idle. Without the cancel
// the workflow keeps running in Temporal after the session is gone.

import { WorkflowNotFoundError } from "@temporalio/client";
import type { ManagedSession } from "../types";
import type { AgentClient } from "./agent-client";
import { AgentErrorCode, agentErrorResponse } from "./errors";

export interface EndAgentSessionDeps {
  sessionStore: {
    getManaged: (sessionId: string) => ManagedSession | null;
    updateManaged: (sessionId: string, updates: Partial<ManagedSession>) => ManagedSession | null;
  };
  agentClient: Pick<AgentClient, "endSession">;
}

export async function handleEndAgentSession(
  sessionId: string,
  deps: EndAgentSessionDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = deps.sessionStore.getManaged(sessionId);
  if (!session) return { status: 404, body: { error: "Session not found" } };
  if (session.status === "idle") {
    return { status: 200, body: { status: "already_idle", sessionId } };
  }

  try {
    await deps.agentClient.endSession(sessionId);
  } catch (err) {
    // The workflow already closed (or was terminated by hand): the session is
    // over either way, so it still goes idle.
    if (!(err instanceof WorkflowNotFoundError)) {
      const message = err instanceof Error ? err.message : "Temporal unavailable";
      return {
        status: 503,
        body: agentErrorResponse(AgentErrorCode.TEMPORAL_UNAVAILABLE, message),
      };
    }
  }

  deps.sessionStore.updateManaged(sessionId, {
    status: "idle",
    completedAt: new Date(),
    currentTurnId: null,
  });
  return { status: 200, body: { event: "stopped", sessionId } };
}
