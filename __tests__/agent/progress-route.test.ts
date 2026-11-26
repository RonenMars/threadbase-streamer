// __tests__/agent/progress-route.test.ts
import crypto from "node:crypto";
import type { ProgressEvent } from "@threadbase-sh/agent-types";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createProgressDedupeLRU } from "../../src/agent/dedupe";
import { createProgressRoutes } from "../../src/api/routes/progress.routes";

const SECRET = "unit-secret";

function makeDeps(
  overrides: Partial<{
    broadcastSpy: ReturnType<typeof vi.fn>;
    writeSpy: ReturnType<typeof vi.fn>;
    dedupe: ReturnType<typeof createProgressDedupeLRU>;
  }> = {},
) {
  const broadcastSpy = overrides.broadcastSpy ?? vi.fn();
  const writeSpy = overrides.writeSpy ?? vi.fn(async () => undefined);
  const dedupe = overrides.dedupe ?? createProgressDedupeLRU(64);

  const wsHub = { broadcast: broadcastSpy };
  const session: Record<string, unknown> = {
    id: "sess_t",
    status: "running",
    progressDedupeIds: dedupe,
  };
  const sessionStore = {
    getManaged: vi.fn(() => session),
    updateManaged: (_id: string, u: Record<string, unknown>) => Object.assign(session, u),
    get: () => ({ id: session.id, status: session.status }),
  };
  const conversationWriter = { appendAssistantTurn: writeSpy };
  const agentConfig = {
    enabled: true,
    webhook: { hmacSecret: SECRET, timestampSkewSeconds: 300 },
    dedupe: { perSessionCapacity: 64 },
    temporal: { address: "x", namespace: "x", taskQueue: "x" },
    conversationsDir: "",
  };

  return {
    session,
    pendingPermission: new Map<string, any>(),
    pendingPermissionKey: new Map<string, string>(),
    ptyAttachedIds: () => new Set<string>(),
    wsHub,
    sessionStore,
    conversationWriter,
    agentConfig,
    broadcastSpy,
    writeSpy,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const TS = String(nowSeconds());

/** The signed payload is `${timestamp}.${rawBody}`; the timestamp is covered. */
function sign(body: string, secret: string, ts: string = TS): string {
  return crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.route("/internal", createProgressRoutes(deps as any));
  return app;
}

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    sessionId: "sess_t",
    turnId: "turn_t",
    eventId: "evt_1",
    seq: 0,
    type: "stage_transition",
    stage: "processing",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as ProgressEvent;
}

async function post(
  app: Hono,
  body: ProgressEvent,
  sig: string,
  ts: string | null = TS,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-progress-signature": sig,
    "x-progress-event-id": body.eventId,
  };
  if (ts !== null) headers["x-timestamp"] = ts;
  return app.request(`/internal/sessions/${body.sessionId}/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("progress route", () => {
  it("rejects requests with a missing signature with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const res = await post(app, event(), "");
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects requests with a bad signature with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event();
    const res = await post(app, body, "deadbeef".repeat(8));
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid signature and broadcasts to the WSHub", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_ok" });
    const raw = JSON.stringify(body);
    const res = await post(app, body, sign(raw, SECRET));
    expect(res.status).toBe(200);
    expect(deps.broadcastSpy).toHaveBeenCalledTimes(1);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("session_update");
    expect(msg.sessionId).toBe("sess_t");
    expect(msg.stage).toBe("processing");
  });

  it("rejects a missing X-Timestamp with 401, even when the signature is otherwise correct", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_nots" });
    const raw = JSON.stringify(body);
    const res = await post(app, body, sign(raw, SECRET), null);
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects an unparseable X-Timestamp with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_badts" });
    const raw = JSON.stringify(body);
    for (const ts of [
      "abc",
      "",
      "1e9",
      "-5",
      "12.5",
      `${TS}.5`,
      ` ${TS}`,
      `${TS}e0`,
      `0x${Number(TS).toString(16)}`,
    ]) {
      const res = await post(app, body, sign(raw, SECRET, ts), ts);
      expect(res.status).toBe(401);
    }
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 401 even though its signature covers that timestamp", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_stale" });
    const raw = JSON.stringify(body);
    const old = String(nowSeconds() - 301);
    const res = await post(app, body, sign(raw, SECRET, old), old);
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects a timestamp too far in the future with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_future" });
    const raw = JSON.stringify(body);
    const ahead = String(nowSeconds() + 301);
    const res = await post(app, body, sign(raw, SECRET, ahead), ahead);
    expect(res.status).toBe(401);
  });

  it("rejects a body-only signature (no legacy fallback) with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_legacy" });
    const raw = JSON.stringify(body);
    const bodyOnly = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    const res = await post(app, body, bodyOnly);
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects a replay with a refreshed header: the timestamp is covered by the signature", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_replay" });
    const raw = JSON.stringify(body);
    const old = String(nowSeconds() - 3600);
    const captured = sign(raw, SECRET, old);
    const res = await post(app, body, captured, TS);
    expect(res.status).toBe(401);
  });

  it("honours timestampSkewSeconds from config", async () => {
    const deps = makeDeps();
    deps.agentConfig.webhook.timestampSkewSeconds = 10;
    const app = makeApp(deps);
    const body = event({ eventId: "evt_skew" });
    const raw = JSON.stringify(body);
    const ts = String(nowSeconds() - 60);
    const res = await post(app, body, sign(raw, SECRET, ts), ts);
    expect(res.status).toBe(401);
  });

  it("dedupes a repeated eventId — second POST returns 200 deduped:true and does NOT broadcast", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_dup" });
    const raw = JSON.stringify(body);
    const sig = sign(raw, SECRET);

    const r1 = await post(app, body, sig);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });

    const r2 = await post(app, body, sig);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, deduped: true });
    expect(deps.broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards an agent_output event as an agent_output WSMessage", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_out",
      type: "agent_output",
      stage: "processing",
      payload: { content: "draft text" },
    } as Partial<ProgressEvent>);
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("agent_output");
    expect(msg.content).toBe("draft text");
    expect(msg.role).toBe("worker");
  });

  it("writes the JSONL line on a FINAL agent_output (stage === 'done')", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_done",
      type: "agent_output",
      stage: "done",
      payload: { content: "the final answer", reviewerOverruled: true },
    } as Partial<ProgressEvent>);
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    expect(deps.writeSpy).toHaveBeenCalledTimes(1);
    expect(deps.writeSpy.mock.calls[0][0]).toEqual({
      sessionId: "sess_t",
      turnId: "turn_t",
      content: "the final answer",
      reviewerOverruled: true,
    });
  });

  it("forwards a terminal_failure event as a turn_failure WSMessage but does NOT write JSONL", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_fail",
      type: "terminal_failure",
      payload: { reason: "activity exhausted retries" },
    } as Partial<ProgressEvent>);
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("turn_failure");
    expect(msg.reason).toBe("activity exhausted retries");
    expect(deps.writeSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    const deps = makeDeps();
    (deps.sessionStore.getManaged as any).mockReturnValueOnce(null);
    const app = makeApp(deps);
    const body = event();
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(404);
  });
});

describe("progress route: sign-off gates", () => {
  const OPEN = {
    gateId: "gate_1",
    prompt: "Release this answer?",
    options: ["Approve", "Request changes", "Stop"],
  };

  async function send(
    deps: ReturnType<typeof makeDeps>,
    eventId: string,
    over: Partial<ProgressEvent>,
  ): Promise<Response> {
    const body = event({ eventId, stage: "sign-off", ...over });
    return post(makeApp(deps), body, sign(JSON.stringify(body), SECRET));
  }

  it("gate_open broadcasts a permission card, records the gate and sets waiting_input", async () => {
    const deps = makeDeps();
    const res = await send(deps, "e1", { type: "gate_open", payload: OPEN } as any);
    expect(res.status).toBe(200);

    const card = deps.broadcastSpy.mock.calls
      .map((c) => c[0])
      .find((m: any) => m.type === "permission");
    expect(card).toEqual({
      type: "permission",
      sessionId: "sess_t",
      prompt: "Release this answer?",
      options: [
        { index: 1, label: "Approve" },
        { index: 2, label: "Request changes" },
        { index: 3, label: "Stop" },
      ],
      contentKey: expect.any(String),
      gateId: "gate_1",
    });
    expect(deps.pendingPermission.get("sess_t")).toMatchObject({
      gateId: "gate_1",
      agentTurnId: "turn_t",
    });
    expect(deps.pendingPermissionKey.get("sess_t")).toBe(card.contentKey);
    expect(deps.session.status).toBe("waiting_input");
    expect(deps.broadcastSpy.mock.calls.map((c) => c[0])).toContainEqual({
      type: "session_update",
      session: { id: "sess_t", status: "waiting_input" },
    });
  });

  it("gate_closed for the open gate cancels the card and sets running", async () => {
    const deps = makeDeps();
    await send(deps, "e1", { type: "gate_open", payload: OPEN } as any);
    deps.broadcastSpy.mockClear();
    await send(deps, "e2", {
      type: "gate_closed",
      payload: { gateId: "gate_1", optionIndex: 0, timedOut: false },
    } as any);

    const sent = deps.broadcastSpy.mock.calls.map((c) => c[0]);
    expect(sent).toContainEqual({ type: "permission_cancelled", sessionId: "sess_t" });
    expect(sent).toContainEqual({
      type: "session_update",
      session: { id: "sess_t", status: "running" },
    });
    expect(deps.pendingPermission.has("sess_t")).toBe(false);
    expect(deps.pendingPermissionKey.has("sess_t")).toBe(false);
    expect(deps.session.status).toBe("running");
  });

  it("gate_closed for an older gate leaves the open card alone", async () => {
    const deps = makeDeps();
    await send(deps, "e1", { type: "gate_open", payload: OPEN } as any);
    deps.broadcastSpy.mockClear();
    await send(deps, "e2", {
      type: "gate_closed",
      payload: { gateId: "gate_0", optionIndex: 1, timedOut: false },
    } as any);

    expect(deps.broadcastSpy).not.toHaveBeenCalled();
    expect(deps.pendingPermission.get("sess_t")?.gateId).toBe("gate_1");
    expect(deps.session.status).toBe("waiting_input");
  });

  it("never closes a card the worker did not open", async () => {
    const deps = makeDeps();
    deps.pendingPermission.set("sess_t", { options: [], gateId: "gate_1" });
    await send(deps, "e1", {
      type: "gate_closed",
      payload: { gateId: "gate_1", optionIndex: 0, timedOut: false },
    } as any);
    await send(deps, "e2", { type: "terminal_failure", payload: { reason: "x" } } as any);

    expect(deps.pendingPermission.has("sess_t")).toBe(true);
    expect(deps.broadcastSpy.mock.calls.map((c) => c[0])).not.toContainEqual(
      expect.objectContaining({ type: "permission_cancelled" }),
    );
  });

  it("a terminal_failure while a gate is open cancels the card", async () => {
    const deps = makeDeps();
    await send(deps, "e1", { type: "gate_open", payload: OPEN } as any);
    deps.broadcastSpy.mockClear();
    await send(deps, "e2", { type: "terminal_failure", payload: { reason: "cancelled" } } as any);

    expect(deps.broadcastSpy.mock.calls.map((c) => c[0])).toContainEqual({
      type: "permission_cancelled",
      sessionId: "sess_t",
    });
    expect(deps.pendingPermission.has("sess_t")).toBe(false);
  });
});
