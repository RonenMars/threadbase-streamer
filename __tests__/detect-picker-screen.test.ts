import { detectPickerScreen } from "../src/services/questions/detectPermissionGate";

// #863. Rendered by the RonenMars/threadbase-mobile#953 retest rig (Claude Code
// 2.1.267, @xterm/headless at 120x40), from the picker's first line down.
const THEME_PICKER = [
  " Let's get started.",
  "",
  " Choose the text style that looks best with your terminal",
  " To change this later, run /theme",
  "",
  "   1. Auto (match terminal)",
  " ❯ 2. Dark mode ✔",
  "   3. Light mode",
  "   4. Dark mode (colorblind-friendly)",
  "   5. Light mode (colorblind-friendly)",
  "   6. Dark mode (ANSI colors only)",
  "   7. Light mode (ANSI colors only)",
  "",
  " ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "  1  function greet() {",
  '  2 -  console.log("Hello, World!");',
  '  2 +  console.log("Hello, Claude!");',
  "  3  }",
  " ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  "  Syntax theme: Monokai Extended (ctrl+t to disable)",
];

const LOGIN_PICKER = [
  " Select login method:",
  "",
  " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
  "   2. Anthropic Console account · API usage billing",
  "   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
];

// Claude Code 2.1.267's composer, captured at 120 columns: "❯" + NBSP between
// two full-width ─ rules. The status line is neutral; the structure is exact.
const RULE = "─".repeat(120);
const STATUS = "  ⏵⏵ auto mode on (shift+tab to cycle)";
const composer = (...rows: string[]) => [RULE, ...rows, RULE, STATUS];

describe("detectPickerScreen", () => {
  it("claims the first-run theme picker, whose trailing preview hides it from the other detectors", () => {
    const gate = detectPickerScreen(THEME_PICKER);
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(gate?.cursor).toBe(2);
    expect(gate?.prompt).toBe("To change this later, run /theme");
  });

  it("claims the login picker", () => {
    expect(detectPickerScreen(LOGIN_PICKER)?.options).toHaveLength(3);
  });

  // The composer's prompt glyph is the same ❯ as a selection cursor.
  it("does not claim a numbered line typed into the composer", () => {
    expect(detectPickerScreen(["  earlier output", "", ...composer("❯\u00a01. do X")])).toBeNull();
  });

  it("does not claim a pasted numbered list in the composer", () => {
    expect(
      detectPickerScreen(["  earlier output", "", ...composer("❯\u00a01. do X", "  2. do Y")]),
    ).toBeNull();
  });

  // #724: an answered menu stays painted above the live composer.
  it("does not claim an answered menu left above the composer", () => {
    const screen = [
      "  What did you actually want here?",
      "❯ 1. It's already done",
      "  2. Make Android run on pull_request too",
      "",
      "⏺ Since the workflow already defaults to Android, there's nothing to change.",
      "",
      ...composer("❯\u00a0"),
    ];
    expect(detectPickerScreen(screen)).toBeNull();
  });

  // #821: a numbered list in prose carries no selection cursor.
  it("does not claim a numbered list in prose", () => {
    const screen = ["⏺ Here is the plan:", "  1. Update the parser", "  2. Add the tests", ""];
    expect(detectPickerScreen(screen)).toBeNull();
  });

  it("leaves a boxed block to detectGateScreen", () => {
    const screen = [
      "╭──────────────────────────────╮",
      "│ Do you want to proceed?      │",
      "│ ❯ 1. Yes                     │",
      "│   2. No                      │",
      "╰──────────────────────────────╯",
    ];
    expect(detectPickerScreen(screen)).toBeNull();
  });
});
