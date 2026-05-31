import { describe, expect, it } from "vitest";
import { isPidAlive } from "../../src/lifecycle/process-liveness";

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for PID 999999 (almost certainly absent)", () => {
    expect(isPidAlive(999999)).toBe(false);
  });

  it("returns false for negative / zero PIDs", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
