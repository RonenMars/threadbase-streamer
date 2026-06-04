import { describe, expect, it } from "vitest";
import { mapTailToConversationTurns } from "../../src/agent/history-mapper";
import type { CachedTail } from "../../src/conversation-cache";

function tail(messages: Array<{ role: string; text?: string; content?: unknown[] }>): CachedTail {
  return {
    conversationId: "conv_test",
    sessionUuid: null,
    messages: messages.map((m, i) => ({
      message_index: i,
      role: m.role,
      timestamp: new Date().toISOString(),
      text: m.text ?? "",
      content: m.content ?? null,
    })),
  } as unknown as CachedTail;
}

describe("mapTailToConversationTurns", () => {
  it("returns [] for null input (new conversation)", () => {
    expect(mapTailToConversationTurns(null)).toEqual([]);
  });

  it("returns [] for empty messages array", () => {
    expect(mapTailToConversationTurns(tail([]))).toEqual([]);
  });

  it("maps a single user message", () => {
    const result = mapTailToConversationTurns(tail([{ role: "user", text: "hello" }]));
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps a full user/assistant round-trip", () => {
    const result = mapTailToConversationTurns(
      tail([
        { role: "user", text: "what is 2+2?" },
        { role: "assistant", text: "4" },
      ]),
    );
    expect(result).toEqual([
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "4" },
    ]);
  });

  it("skips tool_use blocks but keeps assistant text", () => {
    const result = mapTailToConversationTurns(
      tail([
        {
          role: "assistant",
          text: "let me check",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "x", name: "search", input: {} },
          ],
        },
      ]),
    );
    expect(result).toEqual([{ role: "assistant", content: "let me check" }]);
  });

  it("skips thinking blocks but keeps assistant text", () => {
    const result = mapTailToConversationTurns(
      tail([
        {
          role: "assistant",
          text: "the answer is 4",
          content: [
            { type: "thinking", thinking: "computing..." },
            { type: "text", text: "the answer is 4" },
          ],
        },
      ]),
    );
    expect(result).toEqual([{ role: "assistant", content: "the answer is 4" }]);
  });

  it("drops messages whose content is empty after stripping", () => {
    const result = mapTailToConversationTurns(
      tail([
        { role: "user", text: "hi" },
        {
          role: "assistant",
          text: "",
          content: [{ type: "tool_use", id: "x", name: "search", input: {} }],
        },
        { role: "user", text: "still there?" },
      ]),
    );
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "still there?" },
    ]);
  });

  it("skips unknown roles", () => {
    const result = mapTailToConversationTurns(
      tail([
        { role: "user", text: "hi" },
        { role: "system", text: "noise" },
        { role: "user", text: "back" },
      ]),
    );
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "back" },
    ]);
  });
});
