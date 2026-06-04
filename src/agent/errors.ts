// src/agent/errors.ts
//
// Structured error codes for multi-agent HTTP endpoints.
// Existing PTY-mode endpoints keep their unstructured {error: "msg"} shape;
// the retrofit is captured in tb-multi-agent/docs/plans/structured-error-codes-retrofit.md.

export const AgentErrorCode = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_HISTORY_FULL: "SESSION_HISTORY_FULL",
  SESSION_BUSY: "SESSION_BUSY",
  INVALID_SESSION_STATE: "INVALID_SESSION_STATE",
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  INPUT_REQUIRED: "INPUT_REQUIRED",
  INVALID_BODY: "INVALID_BODY",
  TEMPORAL_UNAVAILABLE: "TEMPORAL_UNAVAILABLE",
  NOT_APPLICABLE_IN_MULTI_AGENT_MODE: "NOT_APPLICABLE_IN_MULTI_AGENT_MODE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];

/**
 * Build a structured error response. `error` and `code` are canonical;
 * `extra` may carry hint fields like `retryAfterMs` or `limitBytes` but
 * cannot override the canonical fields.
 */
export function agentErrorResponse(
  code: AgentErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): { error: string; code: AgentErrorCode } & Record<string, unknown> {
  return { ...extra, error: message, code };
}
