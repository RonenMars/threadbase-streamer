// src/agent/handle-start-agent-session.ts
//
// Pure function (deps + body in, response out) for multi-agent session
// creation. Server.ts wraps this in HTTP plumbing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid"; // already a transitive dep of tb-streamer
import type { ManagedSession } from "../types";
import type { AgentClient } from "./agent-client";
import type { AgentConfig } from "./agent-config";
import { AgentErrorCode, agentErrorResponse } from "./errors";

export interface StartSessionBody {
  conversationId?: string;
}

export interface StartAgentSessionDeps {
  sessionStore: {
    addManaged: (session: ManagedSession) => void;
    initAgentSession: (sessionId: string, dedupeCapacity: number) => void;
  };
  agentClient: AgentClient;
  conversationsDir: string;
  agentConfig: AgentConfig;
}

export interface StartAgentSessionResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Validate body shape. Accept only `{}` or `{conversationId: string}`.
 * Anything else is `INVALID_BODY`.
 */
function validateBody(body: unknown): { ok: true; conversationId: string | null } | { ok: false } {
  if (body === null || body === undefined || typeof body !== "object") {
    return { ok: false };
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { ok: true, conversationId: null };
  }
  if (keys.length === 1 && keys[0] === "conversationId") {
    const v = (body as { conversationId: unknown }).conversationId;
    if (typeof v === "string" && v.length > 0) {
      return { ok: true, conversationId: v };
    }
  }
  return { ok: false };
}

export async function handleStartAgentSession(
  body: unknown,
  deps: StartAgentSessionDeps,
): Promise<StartAgentSessionResult> {
  const parsed = validateBody(body);
  if (!parsed.ok) {
    return {
      status: 400,
      body: agentErrorResponse(
        AgentErrorCode.INVALID_BODY,
        "Body must be {} or {conversationId: string}",
      ),
    };
  }

  let conversationId = parsed.conversationId;
  if (conversationId) {
    // Resume — JSONL must exist
    const jsonlPath = join(deps.conversationsDir, `${conversationId}.jsonl`);
    if (!existsSync(jsonlPath)) {
      return {
        status: 404,
        body: agentErrorResponse(
          AgentErrorCode.CONVERSATION_NOT_FOUND,
          `No conversation found for id ${conversationId}`,
        ),
      };
    }
  }

  const sessionId = nanoid();
  if (!conversationId) conversationId = sessionId;

  // Build a minimal ManagedSession. PTY-specific fields stay undefined/null;
  // the spec (§3.3) says they're returned as null in multi-agent mode.
  const now = new Date();
  const session: ManagedSession = {
    id: sessionId,
    conversationId,
    projectPath: "",
    projectName: "",
    branch: "",
    status: "running",
    startedAt: now,
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    currentTurnId: null,
  };

  try {
    deps.sessionStore.addManaged(session);
    deps.sessionStore.initAgentSession(sessionId, deps.agentConfig.dedupe.perSessionCapacity);
    await deps.agentClient.startSession(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Temporal unavailable";
    return {
      status: 503,
      body: agentErrorResponse(AgentErrorCode.TEMPORAL_UNAVAILABLE, message),
    };
  }

  return {
    status: 200,
    body: { sessionId, conversationId, status: "running" },
  };
}
