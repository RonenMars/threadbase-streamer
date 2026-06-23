import { describe, expect, it } from "vitest";
import { detectAskUserQuestion } from "../src/services/questions/detectAskUserQuestion";

const realLine = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Let me ask." },
      {
        type: "tool_use",
        id: "toolu_9",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Format?",
              header: "Format",
              options: [
                { label: "Summary", description: "brief" },
                { label: "Detailed", description: "full" },
              ],
            },
          ],
        },
      },
    ],
  },
});

describe("detectAskUserQuestion", () => {
  it("extracts toolUseId and questions, defaulting multiSelect to false", () => {
    const r = detectAskUserQuestion(realLine);
    expect(r?.toolUseId).toBe("toolu_9");
    expect(r?.questions[0].header).toBe("Format");
    expect(r?.questions[0].multiSelect).toBe(false);
  });
  it("returns null for a deferred_tools_delta line (registration, not a question)", () => {
    const delta = JSON.stringify({
      type: "user",
      attachment: { type: "deferred_tools_delta", addedNames: ["AskUserQuestion", "CronCreate"] },
    });
    expect(detectAskUserQuestion(delta)).toBeNull();
  });
  it("returns null for an unrelated tool_use", () => {
    const other = JSON.stringify({
      message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] },
    });
    expect(detectAskUserQuestion(other)).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    expect(detectAskUserQuestion("{not json")).toBeNull();
  });
});
