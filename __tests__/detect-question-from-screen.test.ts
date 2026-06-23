import { describe, expect, it } from "vitest";
import {
  detectQuestionFromScreen,
  isSubmitConfirmationScreen,
  questionContentKey,
} from "../src/services/questions/detectQuestionFromScreen";

// The multi-question TUI's final confirmation screen.
const SUBMIT_SCREEN = [
  "Ready to submit your answers?",
  "❯ 1. Submit answers",
  "  2. Cancel",
  "Enter to select · Esc to cancel",
];

// A rendered AskUserQuestion menu — the exact shape that has NO JSONL yet and
// was previously dumped as raw TUI text in the mobile chat.
const MENU = [
  "╭──────────────────────────────────────────────╮",
  "Which area are you focused on?",
  "❯ 1. macOS / Chrome",
  "  2. iOS / Safari",
  "  3. Android",
  "  6. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  "╰──────────────────────────────────────────────╯",
];

// The real on-device rendered tail: 6 options, each with a wrapped description
// line, and a box-border row inserted between option 5 and 6. Captured from the
// streamer's pty.prompt_detect diagnostic during a live multi-question flow.
const REAL_MENU = [
  "Which area of your projects do you want to focus on?",
  "❯ 1. iOS (PockeDev, Schedulock, Tabby)",
  "     Native Swift apps.",
  "  2. Dev Tools (Culler, wo, ghost-complete)",
  "     Rust PTY proxy for Ghostty autocomplete.",
  "  3. Libs (Gitty + libgit2 fork)",
  "     Swift package wrapping libgit2 with async API for iOS/macOS. Has its own docs site (gittykit.dev). Foundation for",
  "     PockeDev.",
  "  4. Browser/Web (WebRuler, Ghostty Config, botik)",
  "     WebRuler is a Chrome extension for alignment checking, Ghostty Config is a Svelte visual config tool, botik is your",
  "     multi-channel AI assistant on Fly.io.",
  "  5. Type something.",
  "────────────────────────────────────────────────────────────────────────────",
  "  6. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

describe("detectQuestionFromScreen", () => {
  it("parses the real on-device menu: wrapped descriptions + a border between options", () => {
    const r = detectQuestionFromScreen(REAL_MENU);
    expect(r).not.toBeNull();
    expect(r?.questions[0].question).toBe("Which area of your projects do you want to focus on?");
    expect(r?.questions[0].options.map((o) => o.label)).toEqual([
      "iOS (PockeDev, Schedulock, Tabby)",
      "Dev Tools (Culler, wo, ghost-complete)",
      "Libs (Gitty + libgit2 fork)",
      "Browser/Web (WebRuler, Ghostty Config, botik)",
      "Type something.",
      "Chat about this",
    ]);
  });

  it("detects a ?-suffixed menu with no ❯-required Format-1/2 match", () => {
    const r = detectQuestionFromScreen(MENU);
    expect(r).not.toBeNull();
    expect(r?.questions).toHaveLength(1);
    expect(r?.questions[0].question).toBe("Which area are you focused on?");
    expect(r?.questions[0].options.map((o) => o.label)).toEqual([
      "macOS / Chrome",
      "iOS / Safari",
      "Android",
      "Chat about this",
    ]);
    // Mapped to the AskQuestion shape so the existing QuestionCard renders it.
    expect(r?.questions[0].header).toBe("");
    expect(r?.questions[0].multiSelect).toBe(false);
  });

  it("detects a menu drawn inside a box (│ gutters on every row)", () => {
    const boxed = [
      "╭──────────────────────────────────────╮",
      "│ Which area are you focused on?        │",
      "│ ❯ 1. macOS / Chrome                   │",
      "│   2. iOS / Safari                     │",
      "│ Enter to select · Esc to cancel       │",
      "╰──────────────────────────────────────╯",
    ];
    const r = detectQuestionFromScreen(boxed);
    expect(r?.questions[0].question).toBe("Which area are you focused on?");
    expect(r?.questions[0].options.map((o) => o.label)).toEqual(["macOS / Chrome", "iOS / Safari"]);
  });

  it("returns null without the 'Enter to select' footer (not a menu)", () => {
    const noFooter = MENU.filter((l) => !/Enter to select/.test(l));
    expect(detectQuestionFromScreen(noFooter)).toBeNull();
  });

  it("returns null for a permission gate (Yes/No options), leaving it to OSC 777", () => {
    const gate = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "Enter to select · Esc to cancel",
    ];
    expect(detectQuestionFromScreen(gate)).toBeNull();
  });

  it("returns null when the header doesn't end with '?'", () => {
    const statusy = [
      "Sonnet 4.6 | ~/Desktop/dev/apps",
      "❯ 1. macOS / Chrome",
      "  2. iOS / Safari",
      "Enter to select · Esc to cancel",
    ];
    expect(detectQuestionFromScreen(statusy)).toBeNull();
  });

  it("parses the 'Ready to submit your answers?' confirmation as a card (Submit answers / Cancel)", () => {
    const r = detectQuestionFromScreen(SUBMIT_SCREEN);
    expect(r).not.toBeNull();
    expect(r?.questions[0].question).toBe("Ready to submit your answers?");
    expect(r?.questions[0].options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  });
});

describe("isSubmitConfirmationScreen", () => {
  it("detects the submit-confirmation screen", () => {
    expect(isSubmitConfirmationScreen(SUBMIT_SCREEN)).toBe(true);
  });

  it("is false for a normal AskUserQuestion menu", () => {
    expect(isSubmitConfirmationScreen(MENU)).toBe(false);
  });

  it("is false when the Ask footer is absent", () => {
    const noFooter = SUBMIT_SCREEN.filter((l) => !/Enter to select/.test(l));
    expect(isSubmitConfirmationScreen(noFooter)).toBe(false);
  });
});

describe("questionContentKey", () => {
  it("is stable for the same question+options regardless of source", () => {
    const detected = detectQuestionFromScreen(MENU);
    expect(detected).not.toBeNull();
    const fromScreen = detected?.questions ?? [];
    // Same content as JSONL would yield (header/description differ but the key
    // only uses question text + labels).
    const fromJsonl = [
      {
        question: "Which area are you focused on?",
        header: "Area",
        multiSelect: false,
        options: [
          { label: "macOS / Chrome", description: "desktop" },
          { label: "iOS / Safari", description: "" },
          { label: "Android", description: "" },
          { label: "Chat about this", description: "" },
        ],
      },
    ];
    expect(questionContentKey(fromScreen)).toBe(questionContentKey(fromJsonl));
  });
});
