import {
  detectStartupChoiceGate,
  startupChoiceAnswerKeys,
} from "../src/services/questions/detectStartupChoiceGate";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

// Captured verbatim from Claude Code v2.1.278 by clearing hasTrustDialogAccepted
// for a scratch project. The cursor glyph is `❯` when TERM is declared and ASCII
// `>` when it is not, so both forms are exercised.
const trustGate = (cursor: string) => [
  "────────────────────────────────────────────────────────────────────────",
  " Accessing workspace:",
  " C:\\Users\\PC\\AppData\\Local\\Temp\\tb-trust-1789985172228",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code,",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  " Security guide",
  ` ${cursor} No, exit`,
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
];

describe("startupChoiceAnswerKeys", () => {
  it("confirms in place when the cursor is already on the target", () => {
    expect(startupChoiceAnswerKeys(1, 1)).toBe("\r");
  });

  it("walks down to a later option", () => {
    expect(startupChoiceAnswerKeys(1, 2)).toBe(`${DOWN}\r`);
    expect(startupChoiceAnswerKeys(1, 3)).toBe(`${DOWN}${DOWN}\r`);
  });

  it("walks up to an earlier option", () => {
    expect(startupChoiceAnswerKeys(3, 1)).toBe(`${UP}${UP}\r`);
  });
});

describe("detectStartupChoiceGate", () => {
  for (const [name, cursor] of [
    ["❯ (TERM declared)", "❯"],
    ["> (ASCII fallback, no TERM)", ">"],
  ] as const) {
    it(`claims the workspace-trust gate with cursor ${name}`, () => {
      const gate = detectStartupChoiceGate(trustGate(cursor));
      expect(gate).not.toBeNull();
      expect(gate?.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
      expect(gate?.cursor).toBe(1);
    });
  }

  // The prose above the options is one column to the left, because the cursor
  // glyph plus its space is what indents the labels. That is the boundary.
  it("does not sweep the prose above the options into the block", () => {
    const gate = detectStartupChoiceGate(trustGate("❯"));
    expect(gate?.options).toHaveLength(2);
    expect(gate?.options.map((o) => o.label)).not.toContain("Security guide");
    expect(gate?.prompt).toBe("Security guide");
  });

  // A digit does nothing on this gate; the bytes have to move the cursor.
  it("carries arrow-key answerKeys, not a digit", () => {
    const gate = detectStartupChoiceGate(trustGate("❯"));
    expect(gate?.options[0].answerKeys).toBe("\r");
    expect(gate?.options[1].answerKeys).toBe(`${DOWN}\r`);
  });

  it("computes answerKeys relative to where the cursor actually is", () => {
    const moved = [
      " Security guide",
      "   No, exit",
      " ❯ Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ];
    const gate = detectStartupChoiceGate(moved);
    expect(gate?.cursor).toBe(2);
    expect(gate?.options[0].answerKeys).toBe(`${UP}\r`);
    expect(gate?.options[1].answerKeys).toBe("\r");
  });

  it("refuses a screen with no confirm footer", () => {
    const noFooter = trustGate("❯").filter((l) => !/Enter to confirm/.test(l));
    expect(detectStartupChoiceGate(noFooter)).toBeNull();
  });

  // Numbered blocks belong to detectGateScreen; this must not race it.
  it("refuses a numbered permission gate", () => {
    const numbered = [
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      " Enter to confirm · Esc to cancel",
    ];
    expect(detectStartupChoiceGate(numbered)).toBeNull();
  });

  it("refuses an AskUserQuestion menu", () => {
    const ask = [" Pick one", " ❯ Alpha", "   Beta", " Enter to select · Esc to cancel"];
    expect(detectStartupChoiceGate(ask)).toBeNull();
  });

  // A lone cursor row is a composer prompt, not a choice list.
  it("refuses a single option", () => {
    const single = [" Something", " ❯ Only one", " Enter to confirm"];
    expect(detectStartupChoiceGate(single)).toBeNull();
  });
});
