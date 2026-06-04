// src/api/routes/progress.routes.ts
//
// Webhook receiver for worker → tb-streamer progress events.
//
// Auth: HMAC over the raw request body, header X-Progress-Signature.
// Auth bypass: the auth middleware skips this prefix because validation
// happens inside the handler (mirrors /api/__update).
//
// Idempotency: per-session LRU on the ManagedSession record. Duplicates
// return 200 with deduped:true and do not broadcast.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AgentOutputPayload, ProgressEvent, Stage } from "@threadbase/agent-types";
import { Hono } from "hono";
import type { WSMessage } from "../../types";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface AgentDeps {
  sessionStore: {
    getManaged: (sessionId: string) => {
      id: string;
      progressDedupeIds?: { hasSeen: (id: string) => boolean };
      currentTurnId?: string | null;
    } | null;
  };
  wsHub: { broadcast: (m: WSMessage) => void };
  conversationWriter: {
    appendAssistantTurn: (a: {
      sessionId: string;
      turnId: string;
      content: string;
      reviewerOverruled?: boolean;
    }) => Promise<void>;
  } | null;
  agentConfig: {
    enabled: boolean;
    webhook: { hmacSecret: string; timestampSkewSeconds: number };
    dedupe: { perSessionCapacity: number };
  };
}

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || signature.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isWithinSkew(timestampHeader: string | undefined, skewSeconds: number): boolean {
  if (!timestampHeader) return true; // header optional in milestone B
  const t = Number(timestampHeader);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - t) <= skewSeconds;
}

function stageToRole(stage: Stage | string | undefined): "worker" | "reviewer" | "signoff" {
  if (stage === "review") return "reviewer";
  if (stage === "sign-off") return "signoff";
  return "worker";
}

export const createProgressRoutes = (deps: ApiDeps & AgentDeps) => {
  const app = new Hono<AppEnv>();

  app.post("/sessions/:sessionId/progress", async (c) => {
    if (!deps.agentConfig.enabled) {
      return c.json({ error: "multi-agent mode not enabled" }, 404);
    }
    const sessionId = c.req.param("sessionId");
    const session = deps.sessionStore.getManaged(sessionId);
    if (!session) {
      return c.json({ error: "unknown session" }, 404);
    }

    // Read raw body from the underlying Node IncomingMessage stream — mirrors
    // /api/__update. Hono's c.req.arrayBuffer() returns empty when the request
    // arrives via @hono/node-server's bindings, leaving HMAC verification with
    // the wrong byte buffer. In tests (app.request), c.env.incoming is absent
    // and arrayBuffer() works fine — fall back to it.
    let rawBuf: Buffer;
    try {
      const incoming = c.env?.incoming;
      rawBuf = incoming ? await readRawBody(incoming) : Buffer.from(await c.req.arrayBuffer());
    } catch {
      return c.json({ error: "could not read body" }, 400);
    }
    const sigHeader = c.req.header("x-progress-signature") ?? "";
    if (!verifySignature(rawBuf, sigHeader, deps.agentConfig.webhook.hmacSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (
      !isWithinSkew(
        c.req.header("x-progress-timestamp"),
        deps.agentConfig.webhook.timestampSkewSeconds,
      )
    ) {
      return c.json({ error: "stale timestamp" }, 401);
    }

    let event: ProgressEvent;
    try {
      event = JSON.parse(rawBuf.toString("utf8")) as ProgressEvent;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (!event.eventId || !event.sessionId || !event.turnId) {
      return c.json({ error: "missing required fields" }, 400);
    }

    // Dedupe (per spec §7.1). If the session lacks a dedupe map (e.g., it was
    // created in PTY mode and re-used), the receiver still works — every event
    // is treated as new.
    if (session.progressDedupeIds?.hasSeen(event.eventId)) {
      return c.json({ ok: true, deduped: true }, 200);
    }

    // ─── Translate to WSMessage and broadcast ───────────────────────────
    if (event.type === "stage_transition") {
      const msg: WSMessage = {
        type: "session_update",
        sessionId: event.sessionId,
        // turnId disambiguates which turn this stage applies to. Critical
        // for `queued` (identifies the waiting turn) and `rework` (with
        // reworkAttempt). Existing single-turn consumers can ignore it.
        turnId: event.turnId,
        // Existing session_update consumers expect status; we leave it
        // undefined here (stage is the new-only field).
        stage: event.stage,
        reworkAttempt: event.reworkAttempt,
        stalledSinceMs: 0,
      } as WSMessage;
      deps.wsHub.broadcast(msg);
    } else if (event.type === "agent_output") {
      const payload = (event.payload ?? {}) as unknown as AgentOutputPayload;
      const msg: WSMessage = {
        type: "agent_output",
        sessionId: event.sessionId,
        turnId: event.turnId,
        role: stageToRole(event.stage),
        content: payload.content ?? "",
        partial: payload.partial,
        reviewerOverruled: payload.reviewerOverruled,
        stage: event.stage,
        reworkAttempt: event.reworkAttempt,
      } as WSMessage;
      deps.wsHub.broadcast(msg);

      // Persist final answer to JSONL.
      if (event.stage === "done" && deps.conversationWriter && payload.content) {
        await deps.conversationWriter.appendAssistantTurn({
          sessionId: event.sessionId,
          turnId: event.turnId,
          content: payload.content,
          reviewerOverruled: payload.reviewerOverruled,
        });
      }

      // Release the session lock when the turn completes (spec §6).
      if (event.stage === "done" && session.currentTurnId === event.turnId) {
        (session as { currentTurnId: string | null }).currentTurnId = null;
      }
    } else if (event.type === "terminal_failure") {
      const reason = (event.payload as { reason?: string } | undefined)?.reason ?? "unknown";
      const msg: WSMessage = {
        type: "turn_failure",
        sessionId: event.sessionId,
        turnId: event.turnId,
        reason,
      } as WSMessage;
      deps.wsHub.broadcast(msg);

      // Release the session lock on failure (spec §6).
      if (session.currentTurnId === event.turnId) {
        (session as { currentTurnId: string | null }).currentTurnId = null;
      }
    }

    return c.json({ ok: true }, 200);
  });

  return app;
};
