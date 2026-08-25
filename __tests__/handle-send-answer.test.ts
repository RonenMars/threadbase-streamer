import { describe, expect, it } from "vitest";
import { resolveAnswer } from "../src/services/questions/resolveAnswer";
import type { AskQuestion } from "../src/types";

const question = (text: string, multiSelect = false): AskQuestion => ({
  question: text,
  header: "H",
  multiSelect,
  options: [
    { label: "A", description: "" },
    { label: "B", description: "" },
  ],
});

const pending = { toolUseId: "t1", questions: [question("Q?")] };

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

  // Typed refusals instead of a rethrown bare Error (which reached the client
  // as a 500 through the error middleware).
  it("missing answer → incomplete_answer", () => {
    expect(resolveAnswer(pending, { toolUseId: "t1", answers: {} })).toEqual({
      ok: false,
      reason: "incomplete_answer",
    });
  });
  it("multi-question pending → unsupported_prompt_shape", () => {
    const multi = { toolUseId: "t1", questions: [question("Q1?"), question("Q2?")] };
    expect(resolveAnswer(multi, { toolUseId: "t1", answers: { "Q1?": "A", "Q2?": "B" } })).toEqual({
      ok: false,
      reason: "unsupported_prompt_shape",
    });
  });
  it("multi-select pending → unsupported_prompt_shape", () => {
    const multiSelect = { toolUseId: "t1", questions: [question("Q?", true)] };
    expect(resolveAnswer(multiSelect, { toolUseId: "t1", answers: { "Q?": "A" } })).toEqual({
      ok: false,
      reason: "unsupported_prompt_shape",
    });
  });
});
