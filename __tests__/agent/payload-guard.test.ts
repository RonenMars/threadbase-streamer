import type { UserInputSignal } from "@threadbase/agent-types";
import { describe, expect, it } from "vitest";
import { measureSignalPayload, shouldLogTrajectory } from "../../src/agent/payload-guard";

const baseSignal = (overrides: Partial<UserInputSignal> = {}): UserInputSignal => ({
  turnId: "turn_test",
  prompt: "hello",
  conversationHistory: [],
  ...overrides,
});

describe("measureSignalPayload", () => {
  it("returns byte count of the serialized signal", () => {
    const signal = baseSignal();
    const { bytes } = measureSignalPayload(signal, 1572864);
    // Should be roughly the byte length of JSON.stringify(signal)
    const expected = Buffer.byteLength(JSON.stringify(signal), "utf8");
    expect(bytes).toBe(expected);
  });

  it("flags exceedsLimit=false when payload is under limit", () => {
    const result = measureSignalPayload(baseSignal(), 1572864);
    expect(result.exceedsLimit).toBe(false);
  });

  it("flags exceedsLimit=true when payload exceeds limit", () => {
    const huge = baseSignal({ prompt: "x".repeat(2_000_000) });
    const result = measureSignalPayload(huge, 1572864);
    expect(result.exceedsLimit).toBe(true);
    expect(result.bytes).toBeGreaterThan(1572864);
  });

  it("flags exceedsLimit=true exactly at threshold + 1", () => {
    // Build a signal whose serialized form is exactly the limit, then +1.
    const limit = 1000;
    const filler = "a".repeat(900); // serialize to roughly 900 bytes inside JSON quotes
    const signal = baseSignal({ prompt: filler });
    const { bytes } = measureSignalPayload(signal, limit);
    const overLimit = measureSignalPayload(signal, bytes - 1);
    expect(overLimit.exceedsLimit).toBe(true);
  });
});

describe("shouldLogTrajectory", () => {
  it("does not log before turn 20 by default", () => {
    expect(
      shouldLogTrajectory(1, 100, { trajectoryLogBytes: 512000, trajectoryLogTurns: 20 }),
    ).toBe(false);
    expect(
      shouldLogTrajectory(19, 100, { trajectoryLogBytes: 512000, trajectoryLogTurns: 20 }),
    ).toBe(false);
  });

  it("logs at turn 20 and every 5 turns after", () => {
    const cfg = { trajectoryLogBytes: 512000, trajectoryLogTurns: 20 };
    expect(shouldLogTrajectory(20, 100, cfg)).toBe(true);
    expect(shouldLogTrajectory(25, 100, cfg)).toBe(true);
    expect(shouldLogTrajectory(30, 100, cfg)).toBe(true);
    // In between, no log
    expect(shouldLogTrajectory(21, 100, cfg)).toBe(false);
    expect(shouldLogTrajectory(22, 100, cfg)).toBe(false);
  });

  it("logs whenever payload bytes >= trajectoryLogBytes, even before turn 20", () => {
    const cfg = { trajectoryLogBytes: 512000, trajectoryLogTurns: 20 };
    expect(shouldLogTrajectory(5, 600000, cfg)).toBe(true);
    expect(shouldLogTrajectory(8, 512000, cfg)).toBe(true);
  });

  it("does not log when neither turn count nor bytes trigger", () => {
    const cfg = { trajectoryLogBytes: 512000, trajectoryLogTurns: 20 };
    expect(shouldLogTrajectory(5, 100, cfg)).toBe(false);
  });
});
