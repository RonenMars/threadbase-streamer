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
  /** The project directory, relative to the browse root, as on a PTY start. */
  path?: string;
}

export interface StartAgentSessionDeps {
  sessionStore: {
    addManaged: (session: ManagedSession) => void;
    initAgentSession: (sessionId: string, dedupeCapacity: number) => void;
  };
  agentClient: AgentClient;
  conversationsDir: string;
  agentConfig: AgentConfig;
  /** Resolves a body `path` the way a PTY start does; throws when it is not allowed. */
  resolveProjectPath: (path: string) => Promise<string>;
}

export interface StartAgentSessionResult {
  status: number;
  body: Record<string, unknown>;
}

const BODY_KEYS = ["conversationId", "path"];

/**
 * Validate body shape. Accept `{}`, with an optional `conversationId` and an
 * optional `path`, each a non-empty string. Anything else is `INVALID_BODY`.
 */
function validateBody(
  body: unknown,
): { ok: true; conversationId: string | null; path: string | null } | { ok: false } {
  if (body === null || body === undefined || typeof body !== "object") {
    return { ok: false };
  }
  const fields = body as Record<string, unknown>;
  for (const [key, v] of Object.entries(fields)) {
    if (!BODY_KEYS.includes(key) || typeof v !== "string" || v.length === 0) return { ok: false };
  }
  return {
    ok: true,
    conversationId: (fields.conversationId as string | undefined) ?? null,
    path: (fields.path as string | undefined) ?? null,
  };
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
        "Body must be {} with an optional conversationId and path, each a string",
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

  let projectPath = "";
  if (parsed.path) {
    try {
      projectPath = await deps.resolveProjectPath(parsed.path);
    } catch (err) {
      return {
        status: 400,
        body: agentErrorResponse(
          AgentErrorCode.INVALID_BODY,
          err instanceof Error ? err.message : "Invalid path",
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
    projectPath,
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
    await (projectPath
      ? deps.agentClient.startSession(sessionId, { projectPath })
      : deps.agentClient.startSession(sessionId));
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
