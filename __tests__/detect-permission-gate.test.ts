import { describe, expect, it } from "vitest";
import {
  detectGateScreen,
  detectPickerScreen,
  hasPermissionOsc,
  hasWaitingForInputOsc,
  scrapePermissionGate,
} from "../src/services/questions/detectPermissionGate";

// The exact OSC 777 sequence captured from a live gate (tb-grace.log pty.chunk
// #53): tmux-wrapped passthrough around `]777;notify;Claude Code;Claude needs
// your permission` terminated by BEL.
const OSC_777_RAW =
  "\x1bPtmux;\x1b\x1b]777;notify;Claude Code;Claude needs your permission\x07\x1b\\";

describe("hasPermissionOsc", () => {
  it("detects the OSC 777 notify (tmux-wrapped form)", () => {
    expect(hasPermissionOsc(OSC_777_RAW)).toBe(true);
  });
  it("detects the bare (unwrapped) OSC 777 form", () => {
    expect(hasPermissionOsc("\x1b]777;notify;Claude Code;Claude needs your permission\x07")).toBe(
      true,
    );
  });
  it("ignores ordinary output", () => {
    expect(hasPermissionOsc("just some terminal text\r\n")).toBe(false);
    expect(hasPermissionOsc("\x1b[2J\x1b[H")).toBe(false);
  });

  // Regression: Claude Code emits OSC 777 for BOTH a permission gate and the
  // end of a turn. Matching the prefix alone made the end-of-turn notify open a
  // permission card that could never populate or close (11 sessions stranded in
  // the local prod logs). The body must discriminate.
  it("does NOT treat the end-of-turn notify as a permission gate", () => {
    expect(
      hasPermissionOsc("\x1b]777;notify;Claude Code;Claude is waiting for your input\x07"),
    ).toBe(false);
    expect(
      hasPermissionOsc(
        "\x1bPtmux;\x1b\x1b]777;notify;Claude Code;Claude is waiting for your input\x07\x1b\\",
      ),
    ).toBe(false);
  });
});

describe("hasWaitingForInputOsc", () => {
  it("detects the end-of-turn notify (bare and tmux-wrapped)", () => {
    expect(
      hasWaitingForInputOsc("\x1b]777;notify;Claude Code;Claude is waiting for your input\x07"),
    ).toBe(true);
    expect(
      hasWaitingForInputOsc(
        "\x1bPtmux;\x1b\x1b]777;notify;Claude Code;Claude is waiting for your input\x07\x1b\\",
      ),
    ).toBe(true);
  });

  it("does not fire on a permission notify or ordinary output", () => {
    expect(hasWaitingForInputOsc(OSC_777_RAW)).toBe(false);
    expect(hasWaitingForInputOsc("just some terminal text\r\n")).toBe(false);
  });
});

describe("scrapePermissionGate", () => {
  it("reads the REAL on-screen numbers, not a 1-based index", () => {
    // The trap: a gate can number its options 2 / 3, not 1 / 2.
    const lines = [
      "Claude needs your permission to use Bash",
      "",
      "❯ 2. Yes",
      "  3. No, and tell Claude what to do differently",
      "Esc to cancel",
    ];
    const gate = scrapePermissionGate(lines);
    expect(gate).not.toBeNull();
    expect(gate?.options).toEqual([
      { index: 2, label: "Yes" },
      { index: 3, label: "No, and tell Claude what to do differently" },
    ]);
    expect(gate?.cursor).toBe(2);
    expect(gate?.prompt).toBe("Claude needs your permission to use Bash");
  });

  it("handles 1-based numbering and a box-drawing gutter on the prompt", () => {
    const lines = ["│ Do you want to proceed?", "│ ❯ 1. Yes", "│   2. No"];
    const gate = scrapePermissionGate(lines);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    expect(gate?.options).toEqual([
      { index: 1, label: "Yes" },
      { index: 2, label: "No" },
    ]);
    expect(gate?.cursor).toBe(1);
    expect(gate?.detail).toBeUndefined();
  });

  it("captures the descriptive block above the prompt as `detail`", () => {
    const lines = [
      "╭──────────────────────────────────────╮",
      "│ Bash command",
      "│",
      "│   git push origin main",
      "│   Push the merge commit to origin/main",
      "│",
      "│ Do you want to proceed?",
      "│ ❯ 1. Yes",
      "│   2. Yes, and don't ask again for git push commands",
      "│   3. No, and tell Claude what to do differently",
      "╰──────────────────────────────────────╯",
    ];
    const gate = scrapePermissionGate(lines);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    expect(gate?.detail).toBe(
      "Bash command\ngit push origin main\nPush the merge commit to origin/main",
    );
    expect(gate?.options).toEqual([
      { index: 1, label: "Yes" },
      { index: 2, label: "Yes, and don't ask again for git push commands" },
      { index: 3, label: "No, and tell Claude what to do differently" },
    ]);
    expect(gate?.cursor).toBe(1);
  });

  it("leaves `detail` undefined when there are no descriptive lines above the prompt", () => {
    const lines = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
    const gate = scrapePermissionGate(lines);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    expect(gate?.detail).toBeUndefined();
  });

  it("stops `detail` capture at a 2-blank gap so prior scrollback isn't swept in", () => {
    const lines = [
      "unrelated build output from earlier",
      "",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ];
    const gate = scrapePermissionGate(lines);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    expect(gate?.detail).toBeUndefined();
  });

  it("returns null when no numbered options are painted yet", () => {
    expect(scrapePermissionGate(["Claude needs your permission", ""])).toBeNull();
    expect(scrapePermissionGate([])).toBeNull();
  });

  it("ignores a numbered list in prose above the gate box", () => {
    const lines = [
      "⏺ Here is the plan:",
      "  1. Rebase onto main",
      "  2. Squash-merge",
      "",
      "╭──────────────────────────────────────────────╮",
      "│ Bash command                                 │",
      "│   /opt/homebrew/bin/git reflog -8            │",
      "│                                              │",
      "│ Do you want to proceed?                      │",
      "│ ❯ 1. Yes                                     │",
      "│   2. No                                      │",
      "│                                              │",
      "│ Esc to cancel · Tab to amend                 │",
      "╰──────────────────────────────────────────────╯",
    ];
    const gate = scrapePermissionGate(lines);
    // Only the gate's own two options — the prose rows are not the gate's.
    expect(gate?.options).toEqual([
      { index: 1, label: "Yes" },
      { index: 2, label: "No" },
    ]);
    expect(gate?.cursor).toBe(1);
    // The prompt must be the gate's question, not the line above the prose.
    expect(gate?.prompt).toBe("Do you want to proceed?");
  });

  it("still collects an option whose label wrapped onto the next line", () => {
    const lines = [
      "│ Do you want to proceed?                      │",
      "│ ❯ 1. Yes                                     │",
      "│   2. Yes, and don't ask again for:           │",
      "│      /opt/homebrew/bin/git reflog *          │",
      "│   3. No                                      │",
      "│ Esc to cancel                                │",
    ];
    const gate = scrapePermissionGate(lines);
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(gate?.prompt).toBe("Do you want to proceed?");
  });
});

// The selection cursor is NOT always `❯`. Claude Code paints a plain ASCII `>`
// (U+003E — measured from the PTY bytes of a real Windows gate, whose rows
// render as " > 1. Yes" / "   2. No"). While the regex took `❯` alone, the
// highlighted row matched nothing, so it was dropped from the options AND then
// picked up by the prompt search as the question: the user saw a bold
// "1. Yes" caption over two radio rows, leaving "switch to auto mode" as the
// only way to approve a single command.
describe("scrapePermissionGate — cursor glyph variants", () => {
  // Same gate, one glyph swapped. The `❯` case is the control: it already
  // worked, and proves the widening did not disturb it.
  const gateWithCursor = (cursor: string) => [
    " Bash command",
    ' cd "C:/Users/PC/Desktop/dev/x" && ls -R . | head -50',
    " List subdirectories and read project README",
    "",
    " Do you want to proceed?",
    `${cursor} 1. Yes`,
    "   2. Yes, and switch to auto mode",
    "   3. Yes, and don't ask again for ls commands",
    "   4. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
  ];

  for (const [name, cursor] of [
    ["❯ (U+276F, the original)", " ❯"],
    ["> (U+003E, what Windows paints)", " >"],
    ["› (U+203A, the single-angle form)", " ›"],
  ] as const) {
    it(`scrapes every option and the real prompt when the cursor is ${name}`, () => {
      const gate = scrapePermissionGate(gateWithCursor(cursor));
      expect(gate?.options).toEqual([
        { index: 1, label: "Yes" },
        { index: 2, label: "Yes, and switch to auto mode" },
        { index: 3, label: "Yes, and don't ask again for ls commands" },
        { index: 4, label: "No" },
      ]);
      // The highlighted row must be reported as the cursor, never swallowed...
      expect(gate?.cursor).toBe(1);
      // ...and never promoted into the prompt.
      expect(gate?.prompt).toBe("Do you want to proceed?");
    });
  }
});

// `>` is also the Markdown blockquote marker, so `> 1. Foo` in Claude's prose
// is option-shaped now that the class is widened. Nothing downstream opens a
// card from it, and two independent guards are why:
//
//   detectGateScreen   — requires the "Esc to cancel" gate footer, which prose
//                        never has. Untouched by the widening.
//   detectPickerScreen — requires no composer rule below the cursor row, and
//                        Claude keeps its composer (drawn between two full-width
//                        `─` rules) painted for the whole turn.
//
// The two remaining callers cannot open a card at all: the OSC arm needs a real
// `needs your permission` notify, and the refresh arm only ever updates a gate
// that is already open.
describe("blockquoted prose is not a gate", () => {
  const prose = [
    "⏺ Here is the plan:",
    "",
    "  > 1. Rebase onto main",
    "  > 2. Squash-merge",
    "",
    "────────────────────────────────────────────────",
    " ❯ ",
    "────────────────────────────────────────────────",
    "  ? for shortcuts",
  ];

  it("has no gate footer, so detectGateScreen refuses it", () => {
    expect(detectGateScreen(prose)).toBeNull();
  });

  it("sits above a live composer, so detectPickerScreen refuses it", () => {
    expect(detectPickerScreen(prose)).toBeNull();
  });
});
