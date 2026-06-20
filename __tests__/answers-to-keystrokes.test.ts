import { describe, expect, it } from "vitest";
import {
  answersToKeystrokes,
  UnknownOptionError,
} from "../src/services/questions/answersToKeystrokes";
import type { AskQuestion } from "../src/types";

const DOWN = "\x1b[B";
const ENTER = "\r";

function q(question: string, labels: string[]): AskQuestion {
  return {
    question,
    header: "H",
    multiSelect: false,
    options: labels.map((l) => ({ label: l, description: "" })),
  };
}

describe("answersToKeystrokes (single-select v1)", () => {
  it("first option → just Enter (cursor starts at 0)", () => {
    expect(answersToKeystrokes([q("Q?", ["A", "B", "C"])], { "Q?": "A" })).toBe(ENTER);
  });
  it("third of four → two downs + Enter", () => {
    expect(answersToKeystrokes([q("Q?", ["A", "B", "C", "D"])], { "Q?": "C" })).toBe(
      DOWN + DOWN + ENTER,
    );
  });
  it("multi-question → blocks concatenated in question order", () => {
    const qs = [q("Q1", ["A", "B"]), q("Q2", ["X", "Y", "Z"])];
    // Q1 → B = 1 down; Q2 → Z = 2 downs
    expect(answersToKeystrokes(qs, { Q1: "B", Q2: "Z" })).toBe(DOWN + ENTER + DOWN + DOWN + ENTER);
  });
  it("throws UnknownOptionError when a label matches no option", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], { "Q?": "Nope" })).toThrow(
      UnknownOptionError,
    );
  });
  it("throws when an answer for a question is missing", () => {
    expect(() => answersToKeystrokes([q("Q?", ["A", "B"])], {})).toThrow();
  });
});
