import { describe, expect, it } from "vitest";
import { resolveAnswer } from "../src/services/questions/resolveAnswer";
import type { AskQuestion } from "../src/types";

const pending = {
  toolUseId: "t1",
  questions: [
    {
      question: "Q?",
      header: "H",
      multiSelect: false,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    },
  ] as AskQuestion[],
};

describe("resolveAnswer", () => {
  it("no pending → no_pending_question", () => {
    expect(resolveAnswer(undefined, { toolUseId: "t1", answers: { "Q?": "A" } })).toEqual({
      ok: false,
      reason: "no_pending_question",
    });
  });
  it("wrong toolUseId → tool_use_mismatch", () => {
    expect(resolveAnswer(pending, { toolUseId: "WRONG", answers: { "Q?": "A" } })).toEqual({
      ok: false,
      reason: "tool_use_mismatch",
    });
  });
  it("unknown label → unknown_option", () => {
    expect(resolveAnswer(pending, { toolUseId: "t1", answers: { "Q?": "Z" } })).toEqual({
      ok: false,
      reason: "unknown_option",
    });
  });
  it("valid answer → ok + keys (B = 1 down + Enter)", () => {
    expect(resolveAnswer(pending, { toolUseId: "t1", answers: { "Q?": "B" } })).toEqual({
      ok: true,
      keys: "\x1b[B\r",
    });
  });
});
