// src/agent/handle-send-agent-input.ts
//
// Pure function for multi-agent user-input. Server.ts wraps this in HTTP
// plumbing. Implements spec §3.2 + §5 (payload guard) + §6 (lock check).

import type { UserInputSignal } from "@threadbase/agent-types";
import { nanoid } from "nanoid";
import type { ConversationCache } from "../conversation-cache";
import { getLogger } from "../logger";
import type { ManagedSession } from "../types";
import type { AgentClient } from "./agent-client";
import type { AgentConfig } from "./agent-config";
import { AgentErrorCode, agentErrorResponse } from "./errors";
import { mapTailToConversationTurns } from "./history-mapper";
import { measureSignalPayload, shouldLogTrajectory } from "./payload-guard";

const log = getLogger("agent.send-input");

export interface SendInputBody {
  text?: string;
}

export interface SendAgentInputDeps {
  sessionStore: {
    getManaged: (sessionId: string) => ManagedSession | null;
  };
  cache: ConversationCache;
  agentClient: AgentClient;
  agentConfig: AgentConfig;
}

export interface SendAgentInputResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleSendAgentInput(
  sessionId: string,
  body: SendInputBody,
  deps: SendAgentInputDeps,
): Promise<SendAgentInputResult> {
  // 1. Validate body
  if (typeof body.text !== "string" || body.text.length === 0) {
    return {
      status: 400,
      body: agentErrorResponse(
        AgentErrorCode.INPUT_REQUIRED,
        "Body must contain a non-empty `text` field",
      ),
    };
  }

  // 2. Look up session
  const session = deps.sessionStore.getManaged(sessionId);
  if (!session) {
    return {
      status: 404,
      body: agentErrorResponse(AgentErrorCode.SESSION_NOT_FOUND, `Session ${sessionId} not found`),
    };
  }

  // 3. Session-busy check
  if (session.currentTurnId) {
    return {
      status: 429,
      body: agentErrorResponse(
        AgentErrorCode.SESSION_BUSY,
        "A turn is already in flight; retry shortly",
        { retryAfterMs: deps.agentConfig.sessionBusyRetryMs },
      ),
    };
  }

  const turnId = nanoid();
  // 4. Acquire the lock by setting currentTurnId before any I/O.
  session.currentTurnId = turnId;

  // 5. Build conversation history from cache
  const conversationId = session.conversationId ?? session.id;
  const tail = deps.cache.getConversationTail(conversationId);
  const conversationHistory = mapTailToConversationTurns(tail);

  // 6. Compose signal
  const signal: UserInputSignal = {
    turnId,
    prompt: body.text,
    conversationHistory,
  };

  // 7. Payload-size guard
  const measurement = measureSignalPayload(signal, deps.agentConfig.payload.limitBytes);
  const turnCount = conversationHistory.length;
  if (shouldLogTrajectory(turnCount, measurement.bytes, deps.agentConfig.payload)) {
    log.warn(`session payload trajectory`, {
      sessionId,
      turnCount,
      observedBytes: measurement.bytes,
      limitBytes: deps.agentConfig.payload.limitBytes,
      pctOfLimit: Math.round((measurement.bytes / deps.agentConfig.payload.limitBytes) * 100),
    });
  }
  if (measurement.exceedsLimit) {
    session.currentTurnId = null; // release lock — no signal will be sent
    return {
      status: 413,
      body: agentErrorResponse(
        AgentErrorCode.SESSION_HISTORY_FULL,
        "Conversation history exceeds payload limit",
        {
          limitBytes: deps.agentConfig.payload.limitBytes,
          observedBytes: measurement.bytes,
        },
      ),
    };
  }

  // 8. Send signal
  try {
    await deps.agentClient.sendUserInput(sessionId, signal);
  } catch (err) {
    session.currentTurnId = null; // release lock on failure
    const message = err instanceof Error ? err.message : "Temporal unavailable";
    return {
      status: 503,
      body: agentErrorResponse(AgentErrorCode.TEMPORAL_UNAVAILABLE, message),
    };
  }

  return { status: 202, body: { turnId, status: "queued" } };
}
