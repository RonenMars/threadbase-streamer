import { describe, expect, it } from "vitest";
import {
  questionsFromLines,
  shouldBroadcastQuestion,
} from "../src/services/questions/questionBroadcast";

const line = JSON.stringify({
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_5",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Q?",
              header: "H",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
      },
    ],
  },
});

describe("questionsFromLines", () => {
  it("produces one question message + pending record per AskUserQuestion line", () => {
    const r = questionsFromLines("s1", ["plain text line", line]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      type: "question",
      sessionId: "s1",
      toolUseId: "toolu_5",
    });
    expect(r.pending[0].toolUseId).toBe("toolu_5");
  });
  it("produces nothing for non-question lines", () => {
    expect(questionsFromLines("s1", ["{}", "not json"]).messages).toHaveLength(0);
  });
});

describe("shouldBroadcastQuestion", () => {
  it("broadcasts a never-seen question (no prior content key)", () => {
    expect(
      shouldBroadcastQuestion({
        newContentKey: "k1",
        lastContentKey: undefined,
        newToolUseId: "toolu_5",
        priorToolUseId: undefined,
      }),
    ).toBe(true);
  });

  it("broadcasts when content key differs from the last shown", () => {
    expect(
      shouldBroadcastQuestion({
        newContentKey: "k2",
        lastContentKey: "k1",
        newToolUseId: "toolu_5",
        priorToolUseId: "toolu_4",
      }),
    ).toBe(true);
  });

  it("re-broadcasts an already-shown question when the toolUseId changed (screen → real)", () => {
    // Live-screen path showed it under a synthetic id; the JSONL flush carries
    // the real id. Re-broadcast so the client can answer without a mismatch.
    expect(
      shouldBroadcastQuestion({
        newContentKey: "k1",
        lastContentKey: "k1",
        newToolUseId: "toolu_5",
        priorToolUseId: "screen:s1:42",
      }),
    ).toBe(true);
  });

  it("suppresses a true duplicate (same content key, same toolUseId)", () => {
    expect(
      shouldBroadcastQuestion({
        newContentKey: "k1",
        lastContentKey: "k1",
        newToolUseId: "toolu_5",
        priorToolUseId: "toolu_5",
      }),
    ).toBe(false);
  });
});
