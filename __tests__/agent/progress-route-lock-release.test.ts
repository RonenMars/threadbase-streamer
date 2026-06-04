import crypto from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createProgressDedupeLRU } from "../../src/agent/dedupe";
import { createProgressRoutes } from "../../src/api/routes/progress.routes";

const SECRET = "unit-secret";

function sign(body: string) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeDeps(sessionOverrides: Record<string, unknown> = {}) {
  const session = {
    id: "sess_test",
    currentTurnId: "turn_running",
    progressDedupeIds: createProgressDedupeLRU(64),
    ...sessionOverrides,
  };
  const sessionStore = {
    getManaged: vi.fn(() => session),
  };
  const wsHub = { broadcast: vi.fn() };
  const conversationWriter = { appendAssistantTurn: vi.fn(async () => undefined) };
  const agentConfig = {
    enabled: true,
    webhook: { hmacSecret: SECRET, timestampSkewSeconds: 300 },
    dedupe: { perSessionCapacity: 64 },
  };
  return { sessionStore, wsHub, conversationWriter, agentConfig, session };
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.route("/internal", createProgressRoutes(deps as any));
  return app;
}

async function post(app: Hono, sessionId: string, body: object): Promise<Response> {
  const raw = JSON.stringify(body);
  return app.request(`/internal/sessions/${sessionId}/progress`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-progress-signature": sign(raw),
      "x-progress-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-progress-event-id": (body as { eventId: string }).eventId,
    },
    body: raw,
  });
}

describe("progress route — lock release", () => {
  it("clears session.currentTurnId on stage=done for the matching turn", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const event = {
      sessionId: "sess_test",
      turnId: "turn_running",
      eventId: "evt_1",
      seq: 0,
      type: "agent_output",
      stage: "done",
      timestamp: Math.floor(Date.now() / 1000),
      payload: { content: "answer" },
    };
    const res = await post(app, "sess_test", event);
    expect(res.status).toBe(200);
    expect(deps.session.currentTurnId).toBeNull();
  });

  it("clears session.currentTurnId on terminal_failure for the matching turn", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const event = {
      sessionId: "sess_test",
      turnId: "turn_running",
      eventId: "evt_2",
      seq: 0,
      type: "terminal_failure",
      timestamp: Math.floor(Date.now() / 1000),
      payload: { reason: "boom" },
    };
    const res = await post(app, "sess_test", event);
    expect(res.status).toBe(200);
    expect(deps.session.currentTurnId).toBeNull();
  });

  it("does NOT clear currentTurnId when the event is for a different turn", async () => {
    const deps = makeDeps({ currentTurnId: "turn_running" });
    const app = makeApp(deps);
    const event = {
      sessionId: "sess_test",
      turnId: "turn_other", // not the running one
      eventId: "evt_3",
      seq: 0,
      type: "agent_output",
      stage: "done",
      timestamp: Math.floor(Date.now() / 1000),
      payload: { content: "stale" },
    };
    await post(app, "sess_test", event);
    expect(deps.session.currentTurnId).toBe("turn_running");
  });

  it("does NOT clear currentTurnId on stage=processing or stage=review", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const event = {
      sessionId: "sess_test",
      turnId: "turn_running",
      eventId: "evt_4",
      seq: 0,
      type: "stage_transition",
      stage: "review",
      timestamp: Math.floor(Date.now() / 1000),
    };
    await post(app, "sess_test", event);
    expect(deps.session.currentTurnId).toBe("turn_running");
  });
});
