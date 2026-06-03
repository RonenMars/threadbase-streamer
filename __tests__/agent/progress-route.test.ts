// __tests__/agent/progress-route.test.ts
import crypto from "node:crypto";
import type { ProgressEvent } from "@threadbase/agent-types";
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

function sign(body: string, secret: string): string {
	return crypto.createHmac("sha256", secret).update(body).digest("hex");
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
): Promise<Response> {
	return app.request(`/internal/sessions/${body.sessionId}/progress`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-progress-signature": sig,
			"x-progress-timestamp": String(Math.floor(Date.now() / 1000)),
			"x-progress-event-id": body.eventId,
		},
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
