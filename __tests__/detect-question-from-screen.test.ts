import { describe, expect, it } from "vitest";
import {
  detectQuestionFromScreen,
  questionContentKey,
} from "../src/services/questions/detectQuestionFromScreen";

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

describe("detectQuestionFromScreen", () => {
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
