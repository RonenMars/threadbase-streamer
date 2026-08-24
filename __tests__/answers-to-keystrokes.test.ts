import { describe, expect, it } from "vitest";
import {
  answersToKeystrokes,
  IncompleteAnswerError,
  UnknownOptionError,
  UnsupportedPromptShapeError,
} from "../src/services/questions/answersToKeystrokes";
import type { AskQuestion } from "../src/types";

const DOWN = "\x1b[B";
const ENTER = "\r";

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
  it("multi-select question → UnsupportedPromptShapeError, even with a valid label", () => {
    // Used to answer with the first label as if single-select.
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"], true)], { "Q?": "A" })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
  it("more than one label for a single-select question → UnsupportedPromptShapeError", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": ["A", "B"] })).toThrow(
      UnsupportedPromptShapeError,
    );
  });
});
