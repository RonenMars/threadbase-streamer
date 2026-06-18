// __tests__/agent/agent-client.test.ts
import type { UserInputSignal } from "@threadbase-sh/agent-types";
import { describe, expect, it, vi } from "vitest";
import { createAgentClient } from "../../src/agent/agent-client";

function makeFakeTemporalClient() {
  const start = vi.fn(async (_wf: unknown, opts: any) => ({
    workflowId: opts.workflowId,
  }));
  const signal = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const query = vi.fn(async () => "idle");

  const handle = { signal, cancel, query };

  return {
    workflow: {
      start,
      getHandle: vi.fn(() => handle),
    },
    __spies: {
      start,
      signal,
      cancel,
      query,
      getHandle: undefined as undefined,
    },
  };
}

describe("AgentClient", () => {
  it("startSession uses session-<id> as the workflowId and REJECT_DUPLICATE reuse policy", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({
      temporalClient: fake as any,
      taskQueue: "agent-tasks",
    });

    const wfId = await client.startSession("sess_abc");
    expect(wfId).toBe("session-sess_abc");

    const callArgs = fake.workflow.start.mock.calls[0]?.[1];
    expect(callArgs.workflowId).toBe("session-sess_abc");
    expect(callArgs.taskQueue).toBe("agent-tasks");
    expect(callArgs.args).toEqual(["sess_abc"]);
    expect(callArgs.workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
  });

  it("sendUserInput signals the right handle with the userInput payload", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({
      temporalClient: fake as any,
      taskQueue: "x",
    });
    await client.startSession("sess_signal");

    const payload: UserInputSignal = {
      turnId: "turn-x",
      prompt: "hello",
      conversationHistory: [],
    };
    await client.sendUserInput("sess_signal", payload);

    expect(fake.workflow.getHandle).toHaveBeenCalledWith("session-sess_signal");
    // The signal call should pass an object whose .name is 'userInput' and
    // the payload as a single arg.
    const sigCall = (fake as any).workflow.getHandle().signal.mock.calls[0];
    expect(sigCall[0].name).toBe("userInput");
    expect(sigCall[1]).toEqual(payload);
  });

  it("endSession cancels the orchestrator handle", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({
      temporalClient: fake as any,
      taskQueue: "x",
    });
    await client.startSession("sess_end");
    await client.endSession("sess_end");
    expect((fake as any).workflow.getHandle().cancel).toHaveBeenCalled();
  });

  it("getSessionStage queries the orchestrator's stageQuery", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({
      temporalClient: fake as any,
      taskQueue: "x",
    });
    await client.startSession("sess_q");
    await client.getSessionStage("sess_q");
    const qCall = (fake as any).workflow.getHandle().query.mock.calls[0];
    expect(qCall[0].name).toBe("stage");
  });
});
