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
  const sessionStore = {
    getManaged: vi.fn(() => ({
      id: "sess_t",
      status: "running",
      progressDedupeIds: dedupe,
    })),
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
