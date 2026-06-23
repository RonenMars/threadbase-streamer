import { describe, expect, it } from "vitest";
import type { AskQuestion } from "../src/types";

// Pure guard used by the 60s auto-expiry timer in server.ts:
//   if (current?.toolUseId === armedId) → cancel
// Extracted here as a pure function so the decision logic can be tested
// without standing up the full StreamerServer.
function shouldCancelOnTimer(
  current: { toolUseId: string; questions: AskQuestion[] } | undefined,
  armedToolUseId: string,
): boolean {
  return current?.toolUseId === armedToolUseId;
}

describe("cancel-pending-guard (60s timer toolUseId check)", () => {
  it("cancels when the current pending matches the armed toolUseId", () => {
    const current = { toolUseId: "t1", questions: [] };
    expect(shouldCancelOnTimer(current, "t1")).toBe(true);
  });

  it("does NOT cancel when a newer question replaced the armed one", () => {
    const current = { toolUseId: "t2", questions: [] };
    expect(shouldCancelOnTimer(current, "t1")).toBe(false);
  });

  it("does NOT cancel when there is no pending question", () => {
    expect(shouldCancelOnTimer(undefined, "t1")).toBe(false);
  });
});
