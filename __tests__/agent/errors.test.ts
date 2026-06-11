import { describe, expect, it } from "vitest";
import { AgentErrorCode, agentErrorResponse } from "../../src/agent/errors";

describe("AgentErrorCode", () => {
  it("includes all required codes from the spec", () => {
    const required = [
      "SESSION_NOT_FOUND",
      "SESSION_HISTORY_FULL",
      "SESSION_BUSY",
      "INVALID_SESSION_STATE",
      "CONVERSATION_NOT_FOUND",
      "INPUT_REQUIRED",
      "INVALID_BODY",
      "TEMPORAL_UNAVAILABLE",
      "NOT_APPLICABLE_IN_MULTI_AGENT_MODE",
      "INTERNAL_ERROR",
    ];
    for (const code of required) {
      expect(AgentErrorCode[code as keyof typeof AgentErrorCode]).toBe(code);
    }
  });
});

describe("agentErrorResponse", () => {
  it("returns { error, code } for a minimal call", () => {
    const result = agentErrorResponse(AgentErrorCode.SESSION_NOT_FOUND, "session missing");
    expect(result).toEqual({ error: "session missing", code: "SESSION_NOT_FOUND" });
  });

  it("merges extra fields into the response", () => {
    const result = agentErrorResponse(
      AgentErrorCode.SESSION_HISTORY_FULL,
      "history exceeds limit",
      { limitBytes: 1572864, observedBytes: 2000000 },
    );
    expect(result).toEqual({
      error: "history exceeds limit",
      code: "SESSION_HISTORY_FULL",
      limitBytes: 1572864,
      observedBytes: 2000000,
    });
  });

  it("does not let extra fields override `error` or `code`", () => {
    // Defensive: callers should not be able to override the canonical fields.
    const result = agentErrorResponse(AgentErrorCode.INPUT_REQUIRED, "input missing", {
      error: "tampered",
      code: "WRONG",
    } as any);
    expect(result.error).toBe("input missing");
    expect(result.code).toBe("INPUT_REQUIRED");
  });
});
