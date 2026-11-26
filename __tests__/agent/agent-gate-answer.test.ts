// POST /api/sessions/:id/permission/answer for a multi-agent sign-off gate.
// The card came from the worker (progress route, gate_open), so the answer is
// a gateAnswer signal to the turn's workflow — never keystrokes.
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { describe, expect, it, vi } from "vitest";
import {
  SessionHandlers,
  type SessionHandlersDeps,
} from "../../src/api/handlers/sessions.handlers";
import { permissionGateKey } from "../../src/services/questions/detectPermissionGate";

const SESSION = "sess_a";
const GATE = {
  prompt: "Release this answer?",
  options: [
    { index: 1, label: "Approve" },
    { index: 2, label: "Request changes" },
    { index: 3, label: "Stop" },
  ],
  gateId: "gate_1",
  agentTurnId: "turn_9",
};

function harness(sendGateAnswer = vi.fn(async () => undefined)) {
  const written: string[] = [];
  const pendingPermission = new Map<string, any>([[SESSION, { ...GATE }]]);
  const deps = {
    pendingQuestions: new Map(),
    pendingQuestionKey: new Map(),
    pendingPermission,
    pendingPermissionKey: new Map([[SESSION, permissionGateKey(GATE)]]),
    sessionSubscribers: new Map(),
    sessionStore: { getManaged: () => ({ id: SESSION, currentTurnId: "turn_9" }) },
    log: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    wsHub: { broadcast: () => {}, broadcastToClients: () => {} },
    ptyManager: {
      hasSession: () => false,
      getOutputLines: async () => [],
      sendKeys: (_id: string, keys: string) => written.push(keys),
    },
    agentClient: { sendGateAnswer },
  };
  return {
    handlers: new SessionHandlers(deps as unknown as SessionHandlersDeps),
    written,
    pendingPermission,
    sendGateAnswer,
  };
}

async function answer(h: ReturnType<typeof harness>, body: unknown) {
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
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  await h.handlers.handlePermissionAnswer(SESSION, req, res);
  return { status, body: JSON.parse(payload) };
}

describe("permission answer: agent sign-off gate", () => {
  it("signals gateAnswer to the turn and writes no keys", async () => {
    const h = harness();
    const r = await answer(h, {
      gateId: "gate_1",
      contentKey: permissionGateKey(GATE),
      optionIndex: 1,
      optionLabel: "Request changes",
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(h.sendGateAnswer).toHaveBeenCalledWith("turn_9", { gateId: "gate_1", optionIndex: 1 });
    expect(h.written).toEqual([]);
    // The worker's gate_closed retires the card, not the answer.
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });

  it("refuses an answer to another gate without signalling", async () => {
    const h = harness();
    const r = await answer(h, { gateId: "gate_0", optionIndex: 0 });
    expect(r).toEqual({ status: 409, body: { ok: false, reason: "gate_mismatch" } });
    expect(h.sendGateAnswer).not.toHaveBeenCalled();
  });

  it("refuses an option the card does not have", async () => {
    const h = harness();
    const r = await answer(h, { gateId: "gate_1", optionIndex: 3 });
    expect(r).toEqual({ status: 409, body: { ok: false, reason: "unknown_option" } });
    expect(h.sendGateAnswer).not.toHaveBeenCalled();
  });

  it("answers 503 and keeps the card when the signal fails", async () => {
    const h = harness(
      vi.fn(async () => {
        throw new Error("temporal down");
      }),
    );
    const r = await answer(h, { gateId: "gate_1", optionIndex: 0 });
    expect(r).toEqual({ status: 503, body: { ok: false, reason: "temporal down" } });
    expect(h.pendingPermission.has(SESSION)).toBe(true);
  });
});
