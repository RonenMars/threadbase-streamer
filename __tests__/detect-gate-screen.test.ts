import { detectGateScreen } from "../src/services/questions/detectPermissionGate";

// Rendered-screen form of a real Bash-approval gate (post-xterm lines, box
// gutters intact) — mirrors the prod gate measured in the 2026-08-08 spec.
const GATE_SCREEN = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│   Locate integration branch and its state          │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
];

describe("detectGateScreen", () => {
  it("claims a painted gate: footer + numbered Yes/No options (positive control)", () => {
    const gate = detectGateScreen(GATE_SCREEN);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for: git reflog *",
      "No",
    ]);
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(gate?.cursor).toBe(1);
    expect(gate?.prompt).toBe("Do you want to proceed?");
  });

  // Each negative below is the SAME fixture with exactly one anchor flipped —
  // the positive control above proves the base fixture fires, so a null here
  // is attributable to the flipped anchor alone.

  it("stays silent without the gate footer", () => {
    const noFooter = GATE_SCREEN.filter((l) => !/Esc to cancel/i.test(l));
    expect(detectGateScreen(noFooter)).toBeNull();
  });

  it("stays silent when options are not the Yes/No family (prose numbered list)", () => {
    const prose = GATE_SCREEN.map((l) =>
      l
        .replace("❯ 1. Yes  ", "❯ 1. Alpha")
        .replace(
          "2. Yes, and don't ask again for: git reflog *",
          "2. Beta                                       ",
        )
        .replace("3. No ", "3. Gam"),
    );
    expect(detectGateScreen(prose)).toBeNull();
  });

  it("defers to the AskUserQuestion path when its footer is on screen", () => {
    const askScreen = [
      ...GATE_SCREEN.slice(0, -1),
      "│ Enter to select · Tab/Arrow keys to navigate · Esc to cancel │",
      GATE_SCREEN[GATE_SCREEN.length - 1],
    ];
    expect(detectGateScreen(askScreen)).toBeNull();
  });

  it("requires at least two options", () => {
    const oneOption = GATE_SCREEN.filter(
      (l) => !l.includes("2. Yes, and don't ask again") && !l.includes("3. No"),
    );
    expect(detectGateScreen(oneOption)).toBeNull();
  });
});
