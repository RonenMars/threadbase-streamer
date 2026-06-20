import { describe, expect, it } from "vitest";
import { questionsFromLines } from "../src/services/questions/questionBroadcast";

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
