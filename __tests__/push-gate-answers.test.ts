import { describe, expect, it } from "vitest";
import { gateAnswers } from "../src/services/push/waitingInputNotifier";

/**
 * Which gates get Allow / Deny buttons on the lock screen. The dangerous
 * mistake is a button that grants more than once, so the negatives each sit
 * next to a positive that uses the same shape.
 */

const gate = (...labels: string[]) => ({
  gateId: "g",
  options: labels.map((label, i) => ({ index: i + 1, label })),
});

describe("gateAnswers", () => {
  it("answers Claude's allow-once and refusal by position", () => {
    expect(
      gateAnswers(
        gate(
          "Yes",
          "Yes, and don't ask again for: git reflog *",
          "No, and tell Claude what to do differently",
        ),
      ),
    ).toEqual({ gateId: "g", allowOption: 0, denyOption: 2 });
  });

  it("answers Codex's Yes / No approval", () => {
    expect(gateAnswers(gate("Yes", "No"))).toEqual({ gateId: "g", allowOption: 0, denyOption: 1 });
  });

  it("never offers a persistent grant as Allow", () => {
    expect(gateAnswers(gate("Yes, and don't ask again for ls commands", "No"))).toBeUndefined();
  });

  it("gives Codex's directory-trust gate no buttons", () => {
    expect(
      gateAnswers(gate("Yes, continue", "No, quit", "Yes, continue (remember for all projects)")),
    ).toBeUndefined();
  });

  it("gives an option-less gate no buttons", () => {
    expect(gateAnswers(gate())).toBeUndefined();
  });
});
