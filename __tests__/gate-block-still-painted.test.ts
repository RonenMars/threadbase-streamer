import { gateBlockStillPainted } from "../src/services/questions/detectPermissionGate.js";

const RULE = "─".repeat(40);

describe("gateBlockStillPainted", () => {
  it("is true for a half-painted real gate (options, no footer, no composer below)", () => {
    expect(
      gateBlockStillPainted(["Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell Claude"]),
    ).toBe(true);
  });

  it("is false for a numbered list in prose above the composer rule", () => {
    expect(
      gateBlockStillPainted(["Options:", "1. Rebase", "2. Squash", "", RULE, "❯ ", RULE]),
    ).toBe(false);
  });

  it("is false for a single numbered row", () => {
    expect(gateBlockStillPainted(["Step:", "1. Only one"])).toBe(false);
  });

  it("is false when there are no options", () => {
    expect(gateBlockStillPainted(["hello"])).toBe(false);
  });
});
