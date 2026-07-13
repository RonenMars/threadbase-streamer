import { detectShellPrompt } from "../src/services/questions/detectShellPrompt";

describe("detectShellPrompt — y/N family", () => {
  it("maps [y/N] to Yes/No with literal y\\r / n\\r keys", () => {
    const p = detectShellPrompt(["Some script output", "Continue? [y/N] "]);
    expect(p).not.toBeNull();
    expect(p?.prompt).toBe("Continue? [y/N]");
    expect(p?.options).toEqual([
      { index: 1, label: "Yes", answerKeys: "y\r" },
      { index: 2, label: "No", answerKeys: "n\r" },
    ]);
  });

  it("matches (y/n), [Y/n] and parenthesised forms", () => {
    expect(detectShellPrompt(["Overwrite (y/n)?"])?.options[0].label).toBe("Yes");
    expect(detectShellPrompt(["Proceed [Y/n] "])?.options[1].answerKeys).toBe("n\r");
    expect(detectShellPrompt(["Delete it? (Y/N)"])?.options).toHaveLength(2);
  });

  it("ignores trailing blank lines when finding the prompt", () => {
    const p = detectShellPrompt(["Continue? [y/N]", "", "   ", ""]);
    expect(p?.prompt).toBe("Continue? [y/N]");
  });
});

describe("detectShellPrompt — numbered menu", () => {
  it("scrapes contiguous numbered rows ending the screen", () => {
    const p = detectShellPrompt([
      "Pick an environment:",
      "1) staging",
      "2) production",
      "3) local",
    ]);
    expect(p?.prompt).toBe("Pick an environment:");
    expect(p?.options).toEqual([
      { index: 1, label: "staging", answerKeys: "1\r" },
      { index: 2, label: "production", answerKeys: "2\r" },
      { index: 3, label: "local", answerKeys: "3\r" },
    ]);
  });

  it("answers numbered prompts by the ON-SCREEN number (dot form)", () => {
    const p = detectShellPrompt(["Choose:", "1. apple", "2. banana"]);
    expect(p?.options.map((o) => o.answerKeys)).toEqual(["1\r", "2\r"]);
  });

  it("scrapes numbered options above a 'Press enter to confirm' footer (Codex trust dialog)", () => {
    const p = detectShellPrompt([
      "Hooks need review",
      "1 hook is new or changed.",
      "Hooks can run outside the sandbox after you trust them.",
      "1. Trust all and continue",
      "2. Continue without trusting (hooks won't run)",
      "Press enter to confirm or esc to go back",
    ]);
    expect(p?.options).toEqual([
      { index: 1, label: "Trust all and continue", answerKeys: "1\r" },
      { index: 2, label: "Continue without trusting (hooks won't run)", answerKeys: "2\r" },
    ]);
  });

  it("falls back to a default prompt when no header line precedes the menu", () => {
    const p = detectShellPrompt(["1) a", "2) b"]);
    expect(p?.prompt).toBe("Select an option");
  });

  it("does not fire for a single numbered line (needs >= 2 options)", () => {
    expect(detectShellPrompt(["1) only one"])).toBeNull();
  });
});

describe("detectShellPrompt — bare confirmation", () => {
  it("maps 'press enter' to a single Continue option sending \\r", () => {
    const p = detectShellPrompt(["Press enter to continue"]);
    expect(p?.options).toEqual([{ index: 1, label: "Continue", answerKeys: "\r" }]);
  });

  it("matches a trailing 'Continue?' with no y/n hint", () => {
    expect(detectShellPrompt(["Continue?"])?.options[0].answerKeys).toBe("\r");
  });
});

describe("detectShellPrompt — conservative negatives", () => {
  it("returns null for ordinary prose", () => {
    expect(detectShellPrompt(["Building the project...", "Done in 4.2s"])).toBeNull();
  });

  it("returns null for empty / all-blank input", () => {
    expect(detectShellPrompt([])).toBeNull();
    expect(detectShellPrompt(["", "  ", ""])).toBeNull();
  });

  it("defers to structured detectors when Claude's TUI box is on screen", () => {
    // A permission gate paints a box + 'Esc to cancel' — never a shell prompt.
    expect(
      detectShellPrompt([
        "╭─────────────────────────╮",
        "│ Do you want to proceed? │",
        "│ ❯ 1. Yes                │",
        "│   2. No                 │",
        "╰─────────────────────────╯",
      ]),
    ).toBeNull();
  });

  it("defers when an AskUserQuestion footer is present", () => {
    expect(
      detectShellPrompt(["Which option?", "1. a", "2. b", "Enter to select · Esc to cancel"]),
    ).toBeNull();
  });
});
