import { describe, expect, it } from "vitest";
import type { AskQuestion, WSMessage } from "../src/types";

describe("question WS types", () => {
  it("accepts a well-formed question message", () => {
    const msg: WSMessage = {
      type: "question",
      sessionId: "s1",
      toolUseId: "toolu_1",
      questions: [
        { question: "Q?", header: "H", multiSelect: false, options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ] },
      ],
    };
    const q: AskQuestion = (msg as Extract<WSMessage, { type: "question" }>).questions[0];
    expect(q.options).toHaveLength(2);
  });
});
