// src/agent/agent-client.ts
//
// Thin Temporal client wrapper used by tb-streamer in multi-agent mode.
// Does NOT import workflow code from tb-multi-agent — we identify the
// workflow and its signals/queries by name. The workflow's wire contract
// lives in @threadbase/agent-types.

import type { Client } from "@temporalio/client";
import type { UserInputSignal } from "@threadbase/agent-types";

// `defineSignal` / `defineQuery` only ship in `@temporalio/workflow` (a worker-
// side package we deliberately do NOT pull into the streamer). The handle
// methods `.signal(...)` and `.query(...)` accept either a plain string OR a
// definition object with `{ type, name }`. We construct minimal definition
// objects here — Temporal matches by name, the rest of the shape is virtual
// branding.
//
// Same identifiers as tb-multi-agent's src/workflows/signals.ts.
const userInputSignal = { type: "signal", name: "userInput" } as unknown as {
  type: "signal";
  name: "userInput";
};
const stageQuery = { type: "query", name: "stage" } as unknown as {
  type: "query";
  name: "stage";
};

const ORCHESTRATOR_WORKFLOW_TYPE = "orchestratorWorkflow";

export interface AgentClient {
  startSession(sessionId: string): Promise<string>;
  sendUserInput(sessionId: string, payload: UserInputSignal): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  getSessionStage(sessionId: string): Promise<string>;
}

export interface AgentClientOpts {
  temporalClient: Client;
  taskQueue: string;
}

const sessionWorkflowId = (sessionId: string): string => `session-${sessionId}`;

export function createAgentClient({ temporalClient, taskQueue }: AgentClientOpts): AgentClient {
  return {
    async startSession(sessionId: string): Promise<string> {
      const handle = await temporalClient.workflow.start(ORCHESTRATOR_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: sessionWorkflowId(sessionId),
        args: [sessionId],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      } as any);
      return handle.workflowId;
    },
    async sendUserInput(sessionId: string, payload: UserInputSignal): Promise<void> {
      await temporalClient.workflow
        .getHandle(sessionWorkflowId(sessionId))
        .signal(userInputSignal as any, payload);
    },
    async endSession(sessionId: string): Promise<void> {
      await temporalClient.workflow.getHandle(sessionWorkflowId(sessionId)).cancel();
    },
    async getSessionStage(sessionId: string): Promise<string> {
      return temporalClient.workflow
        .getHandle(sessionWorkflowId(sessionId))
        .query(stageQuery as any);
    },
  };
}
