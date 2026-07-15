import { describe, expect, it } from "vitest";
import {
  isCodexInjectedContext,
  isCodexRolloutLine,
  normalizeCodexLineToClaudeShape,
  toClientConversationLines,
} from "../src/utils/codexConversationLine";

describe("normalizeCodexLineToClaudeShape", () => {
  it("converts a Codex user response_item into Claude type:user shape", () => {
    const raw = JSON.stringify({
      timestamp: "2026-07-15T11:01:16.649Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello from mobile" }],
      },
    });
    const out = normalizeCodexLineToClaudeShape(raw);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toEqual([{ type: "text", text: "Hello from mobile" }]);
    expect(parsed.timestamp).toBe("2026-07-15T11:01:16.649Z");
    expect(typeof parsed.uuid).toBe("string");
  });

  it("converts a Codex assistant response_item into type:assistant", () => {
    const raw = JSON.stringify({
      timestamp: "2026-07-15T11:01:20.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Understood." }],
      },
    });
    const parsed = JSON.parse(normalizeCodexLineToClaudeShape(raw)!);
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.content[0].text).toBe("Understood.");
  });

  it("drops event_msg duplicates, session_meta, and developer role", () => {
    expect(
      normalizeCodexLineToClaudeShape(
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "x" } }),
      ),
    ).toBeNull();
    expect(
      normalizeCodexLineToClaudeShape(
        JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: "/tmp" } }),
      ),
    ).toBeNull();
    expect(
      normalizeCodexLineToClaudeShape(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "<permissions instructions>" }],
          },
        }),
      ),
    ).toBeNull();
  });

  it("drops AGENTS.md / instructions injected as fake user turns", () => {
    expect(isCodexInjectedContext("# AGENTS.md instructions\n\n<INSTRUCTIONS>\nHi")).toBe(true);
    expect(
      normalizeCodexLineToClaudeShape(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx" }],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("toClientConversationLines", () => {
  it("passes Claude lines through unchanged (preserves seq alignment)", () => {
    const claude = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    expect(toClientConversationLines([claude])).toEqual([claude]);
    expect(isCodexRolloutLine(claude)).toBe(false);
  });

  it("normalizes a Codex batch and drops non-chat lines", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "c1" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "real question" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "real question" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
    ];
    const out = toClientConversationLines(lines);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).type).toBe("user");
    expect(JSON.parse(out[1]).type).toBe("assistant");
  });
});
