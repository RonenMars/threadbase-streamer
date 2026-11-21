import { describe, expect, it } from "vitest";
import {
  answersToKeystrokes,
  IncompleteAnswerError,
  InvalidTextError,
  MAX_FREE_TEXT,
  planAnswer,
  UnknownOptionError,
  UnsupportedPromptShapeError,
} from "../src/services/questions/answersToKeystrokes";
import type { AskQuestion } from "../src/types";

const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const RIGHT = "\x1b[C";

function q(question: string, labels: string[], multiSelect = false): AskQuestion {
  return {
    question,
    header: "H",
    multiSelect,
    options: labels.map((l) => ({ label: l, description: "" })),
  };
}

describe("answersToKeystrokes — the one supported shape: one single-select question, one label", () => {
  it("first option → just Enter (cursor starts at 0)", () => {
    expect(answersToKeystrokes([q("Q?", ["A", "B", "C"])], { "Q?": "A" })).toBe(ENTER);
  });
  it("third of four → two downs + Enter", () => {
    expect(answersToKeystrokes([q("Q?", ["A", "B", "C", "D"])], { "Q?": "C" })).toBe(
      DOWN + DOWN + ENTER,
    );
  });
  it("a one-element array is the same as the label", () => {
    expect(answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": ["B"] })).toBe(DOWN + ENTER);
  });
  it("throws UnknownOptionError when a label matches no option", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": "Nope" })).toThrow(
      UnknownOptionError,
    );
  });
});

// Everything below used to write bytes (or crash with a bare Error). Each now
// throws a typed error BEFORE any keystroke is built.
describe("answersToKeystrokes — fails closed on shapes it cannot answer", () => {
  it("missing answer → IncompleteAnswerError", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], {})).toThrow(IncompleteAnswerError);
  });
  it("empty array → IncompleteAnswerError", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": [] })).toThrow(
      IncompleteAnswerError,
    );
  });
  it("multi-question form → UnsupportedPromptShapeError, even with every answer supplied", () => {
    // Used to replay one ↓…⏎ block per question, blind to the TUI's cursor.
    const qs = [q("Q1", ["A", "B"]), q("Q2", ["X", "Y", "Z"])];
    expect(() => answersToKeystrokes(qs, { Q1: "B", Q2: "Z" })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("multi-select question whose checkbox marker could not be read → UnsupportedPromptShapeError (#728)", () => {
    const unverified = { ...q("Q?", ["A", "B"], true), multiSelectUnverified: true };
    expect(() => answersToKeystrokes([unverified], { "Q?": ["A"] })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("more than one label for a single-select question → UnsupportedPromptShapeError", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": ["A", "B"] })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
});

// Verified on Claude Code 2.1.316: Space toggles the row under the cursor, Right
// arrow opens "Review your answers", Enter on "Submit answers" submits. Enter on
// an option row toggles it instead, so a multi-select answer never ends in a bare
// Enter on the picker.
describe("answersToKeystrokes — multi-select question", () => {
  const four = [q("Q?", ["A", "B", "C", "D"], true)];

  it("two of four: walk down, toggle each, Right, Enter", () => {
    expect(answersToKeystrokes(four, { "Q?": ["B", "D"] })).toBe(
      DOWN + SPACE + DOWN + DOWN + SPACE + RIGHT + ENTER,
    );
  });
  it("one option", () => {
    expect(answersToKeystrokes(four, { "Q?": ["A"] })).toBe(SPACE + RIGHT + ENTER);
    expect(answersToKeystrokes(four, { "Q?": ["C"] })).toBe(DOWN + DOWN + SPACE + RIGHT + ENTER);
  });
  it("a single string is a one-item list", () => {
    expect(answersToKeystrokes(four, { "Q?": "C" })).toBe(
      answersToKeystrokes(four, { "Q?": ["C"] }),
    );
  });
  it("answer order and duplicates do not change the keys", () => {
    expect(answersToKeystrokes(four, { "Q?": ["D", "B", "D"] })).toBe(
      answersToKeystrokes(four, { "Q?": ["B", "D"] }),
    );
  });
  it("an unknown label → UnknownOptionError, even beside a valid one", () => {
    expect(() => answersToKeystrokes(four, { "Q?": ["A", "Nope"] })).toThrow(UnknownOptionError);
  });
  it("no label → IncompleteAnswerError", () => {
    expect(() => answersToKeystrokes(four, { "Q?": [] })).toThrow(IncompleteAnswerError);
    expect(() => answersToKeystrokes(four, {})).toThrow(IncompleteAnswerError);
  });
});

// Claude Code appends "Type something." and "Chat about this" after the model's
// options. A structured (JSONL) card does not carry them, a screen-scraped card
// does; both must answer them the same way (captured on 2.1.328: rows 4 and 5
// of a 3-option question).
describe("answersToKeystrokes — the two terminal-only rows", () => {
  const structured = [q("Q?", ["A", "B", "C"])];
  const scraped = [q("Q?", ["A", "B", "C", "Type something.", "Chat about this"])];

  it("'Chat about this' on a structured card is a virtual row after 'Type something.'", () => {
    expect(answersToKeystrokes(structured, { "Q?": "Chat about this" })).toBe(
      DOWN.repeat(4) + ENTER,
    );
  });
  it("'Chat about this' on a screen card uses the row already in options, no duplicate", () => {
    expect(answersToKeystrokes(scraped, { "Q?": "Chat about this" })).toBe(DOWN.repeat(4) + ENTER);
  });
  it("a real option is unchanged by the virtual rows", () => {
    expect(answersToKeystrokes(structured, { "Q?": "C" })).toBe(DOWN.repeat(2) + ENTER);
    expect(answersToKeystrokes(scraped, { "Q?": "C" })).toBe(DOWN.repeat(2) + ENTER);
  });
  it("the bare label 'Type something.' is refused: Enter on the empty field declines the question", () => {
    expect(() => answersToKeystrokes(structured, { "Q?": "Type something." })).toThrow(
      UnsupportedPromptShapeError,
    );
    expect(() => answersToKeystrokes(scraped, { "Q?": "Type something." })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("multi-select gets no virtual rows", () => {
    const multi = [q("Q?", ["A", "B"], true)];
    expect(() => answersToKeystrokes(multi, { "Q?": ["Chat about this"] })).toThrow(
      UnknownOptionError,
    );
  });
});

describe("planAnswer — free text for the 'Type something.' row", () => {
  const structured = [q("Q?", ["A", "B", "C"])];
  const scraped = [q("Q?", ["A", "B", "C", "Type something.", "Chat about this"])];
  const plan = (qs: AskQuestion[], other: unknown) =>
    planAnswer(qs, { "Q?": { other } as { other: string } });

  it("targets the row after the real options, on both card sources", () => {
    expect(plan(structured, "hi")).toEqual({ freeText: { row: 3, text: "hi" } });
    expect(plan(scraped, "hi")).toEqual({ freeText: { row: 3, text: "hi" } });
  });
  it("encodes a newline as Option+Enter (ESC CR), whichever way the client wrote it", () => {
    const want = { freeText: { row: 3, text: "a\x1b\rb" } };
    expect(plan(structured, "a\nb")).toEqual(want);
    expect(plan(structured, "a\r\nb")).toEqual(want);
    expect(plan(structured, "a\rb")).toEqual(want);
  });
  it("keeps the text otherwise as typed, surrounding spaces included", () => {
    expect(plan(structured, "  hi  ")).toEqual({ freeText: { row: 3, text: "  hi  " } });
  });
  it("accepts exactly MAX_FREE_TEXT characters and rejects one more", () => {
    expect(() => plan(structured, "x".repeat(MAX_FREE_TEXT))).not.toThrow();
    expect(() => plan(structured, "x".repeat(MAX_FREE_TEXT + 1))).toThrow(InvalidTextError);
  });
  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["only newlines", "\n \r\n"],
    ["not a string", 5],
    ["missing", undefined],
    ["an escape sequence", "\x1b[B"],
    ["a NUL", "a\x00b"],
    ["a tab", "a\tb"],
    ["DEL", "a\x7fb"],
  ])("rejects %s with InvalidTextError", (_name, value) => {
    expect(() => plan(structured, value)).toThrow(InvalidTextError);
  });
  it("is refused for multi-select and for a multi-question form", () => {
    expect(() => plan([q("Q?", ["A", "B"], true)], "hi")).toThrow(UnsupportedPromptShapeError);
    expect(() => plan([q("Q?", ["A"]), q("R?", ["B"])], "hi")).toThrow(UnsupportedPromptShapeError);
  });
  it("a card whose scrape lost the 'Type something.' row has nowhere to type: refused, not row -1", () => {
    // The field shows the typed text in place of its label, so a re-scrape can
    // carry "Chat about this" without "Type something.".
    expect(() => plan([q("Q?", ["A", "B", "Chat about this"])], "hi")).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("answersToKeystrokes cannot express it and fails closed", () => {
    expect(() => answersToKeystrokes(structured, { "Q?": { other: "hi" } })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("a plain label still plans as keys", () => {
    expect(planAnswer(structured, { "Q?": "B" })).toEqual({ keys: DOWN + ENTER });
  });
});
