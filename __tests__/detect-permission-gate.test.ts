import { describe, expect, it } from "vitest";
import {
  hasPermissionOsc,
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
});
