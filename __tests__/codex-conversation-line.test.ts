import { describe, expect, it } from "vitest";
import { toolResultText } from "../src/utils/claudeShapedLine";
import {
  classifyCodexLine,
  isCodexInjectedContext,
  isCodexRolloutLine,
  normalizeCodexLineToClaudeShape,
  toClientConversationLines,
} from "../src/utils/codexConversationLine";

// The `ignored` vs `unknown` split is the point of C2: before it, every
// non-chat line returned null, so "a header we skip on purpose" and "a shape
// this adapter has never seen" were indistinguishable — and a Codex schema
// change rendered an empty conversation with no error anywhere.
describe("classifyCodexLine", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("reports an unrecognized envelope type as unknown, not a silent drop", () => {
    const result = classifyCodexLine(
      line({ type: "tool_invocation_v2", payload: { type: "message", role: "user" } }),
    );

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toMatch(/unrecognized rollout envelope/);
      // The raw line is retained so the event can be diagnosed.
      expect(result.raw).toContain("tool_invocation_v2");
    }
  });

  it("reports unparseable JSON as unknown", () => {
    const result = classifyCodexLine("{not json");
    expect(result.kind).toBe("unknown");
  });

  it.each([
    ["session_meta", { type: "session_meta", payload: { id: "x" } }],
    ["turn_context", { type: "turn_context", payload: {} }],
    ["event_msg", { type: "event_msg", payload: { type: "message" } }],
  ])("reports a recognized non-chat envelope (%s) as ignored", (_name, entry) => {
    const result = classifyCodexLine(line(entry));
    expect(result.kind).toBe("ignored");
  });

  it("reports a non-rendered role as ignored, with a reason", () => {
    const result = classifyCodexLine(
      line({
        type: "response_item",
        payload: { type: "message", role: "developer", content: "internal" },
      }),
    );

    expect(result.kind).toBe("ignored");
    if (result.kind === "ignored") expect(result.reason).toMatch(/developer/);
  });

  it("reports synthetic injected context as ignored, not unknown", () => {
    const result = classifyCodexLine(
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md\nrules here" }],
        },
      }),
    );

    expect(result.kind).toBe("ignored");
  });

  it("returns the normalized line for real chat content", () => {
    const result = classifyCodexLine(
      line({
        timestamp: "2026-07-15T11:01:16.649Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      }),
    );

    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(JSON.parse(result.line)).toMatchObject({ type: "assistant" });
    }
  });

  // The refactor must not change what clients actually receive.
  it("stays consistent with normalizeCodexLineToClaudeShape", () => {
    const cases = [
      line({ type: "session_meta", payload: {} }),
      line({ type: "brand_new_type", payload: {} }),
      "{not json",
      line({
        // A timestamp is supplied deliberately: without one the generated uuid
        // falls back to `new Date()`, so two calls on the same input differ.
        // That non-determinism predates C2 — noted, not fixed here.
        timestamp: "2026-07-15T11:01:16.649Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      }),
    ];

    for (const raw of cases) {
      const classified = classifyCodexLine(raw);
      const legacy = normalizeCodexLineToClaudeShape(raw);
      expect(legacy).toBe(classified.kind === "message" ? classified.line : null);
    }
  });
});

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
    const parsed = JSON.parse(out as string);
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
    const normalized = normalizeCodexLineToClaudeShape(raw);
    expect(normalized).not.toBeNull();
    const parsed = JSON.parse(normalized as string);
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
            content: [
              { type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx" },
            ],
          },
        }),
      ),
    ).toBeNull();
  });

  it("drops streamer DEFAULT/BROWSE system prompts injected as user turns", () => {
    expect(
      isCodexInjectedContext(
        "When presenting options or choices to the user, limit the options to at most 3.",
      ),
    ).toBe(true);
    expect(
      isCodexInjectedContext(
        "You are working within the project boundary: /tmp/proj. Do not read, write, or execute commands that access files or directories outside this boundary.",
      ),
    ).toBe(true);
    expect(
      normalizeCodexLineToClaudeShape(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "When presenting options or choices to the user, limit the options to at most 3.",
              },
            ],
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
    expect(toClientConversationLines([claude], [4])).toEqual({ lines: [claude], seqs: [4] });
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
    const { lines: out, seqs } = toClientConversationLines(lines);
    expect(seqs).toBeNull();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).type).toBe("user");
    expect(JSON.parse(out[1]).type).toBe("assistant");
  });
});

// Tool/reasoning items keep the key shape a real Codex 0.15x rollout item has
// (values shortened): the live line is built from the scanner's parse of it.
describe("classifyCodexLine tool and reasoning items", () => {
  const item = (payload: Record<string, unknown>) =>
    JSON.stringify({
      timestamp: "2026-09-18T10:00:00.000Z",
      ordinal: 10,
      type: "response_item",
      payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: "t1" } },
    });
  const content = (raw: string) => {
    const result = classifyCodexLine(raw);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("not a message");
    return JSON.parse(result.line);
  };

  it("renders a function call as an assistant tool_use keyed on call_id", () => {
    const parsed = content(
      item({
        type: "function_call",
        id: "fc_1",
        name: "exec_command",
        arguments: '{"cmd":"ls"}',
        call_id: "call_A",
      }),
    );
    expect(parsed).toMatchObject({ type: "assistant", uuid: "fc_1" });
    expect(parsed.message.content).toEqual([
      { type: "tool_use", id: "call_A", name: "exec_command", input: { cmd: "ls" } },
    ]);
  });

  it("renders a tool output as a user tool_result carrying the plain output", () => {
    const parsed = content(
      item({
        type: "custom_tool_call_output",
        id: "ctco_1",
        call_id: "call_A",
        output: [{ type: "input_text", text: "Script completed" }],
      }),
    );
    expect(parsed).toMatchObject({ type: "user", uuid: "ctco_1" });
    expect(parsed.message.content).toEqual([
      { type: "tool_result", tool_use_id: "call_A", content: "Script completed", is_error: false },
    ]);
  });

  it("renders a readable reasoning summary as thinking", () => {
    const parsed = content(
      item({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "**Checking**" }],
        encrypted_content: "gAAAA",
      }),
    );
    expect(parsed.message.content).toEqual([{ type: "thinking", thinking: "**Checking**" }]);
  });

  it("ignores encrypted-only reasoning", () => {
    expect(
      classifyCodexLine(
        item({ type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAA" }),
      ).kind,
    ).toBe("ignored");
  });
});

describe("toClientConversationLines seq alignment", () => {
  it("keeps seqs parallel to the kept lines when a Codex batch is filtered", () => {
    const lines = [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "m1",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", id: "fc", name: "shell", arguments: "{}", call_id: "c" },
      }),
    ];
    const out = toClientConversationLines(lines, [null, 7, 8]);
    expect(out.seqs).toEqual([7, 8]);
    expect(out.lines.map((l) => JSON.parse(l).uuid)).toEqual(["m1", "fc"]);
  });

  it("routes a Cursor batch through the Cursor normalizer", () => {
    const lines = [
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", name: "Shell", input: { command: "ls" } },
          ],
        },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ];
    const out = toClientConversationLines(lines, [3, null]);
    expect(out.seqs).toEqual([3]);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.content.map((b: { type: string }) => b.type)).toEqual([
      "text",
      "tool_use",
    ]);
  });
});

describe("toolResultText", () => {
  it("sends a Codex result's output verbatim so newlines are not escaped", () => {
    expect(toolResultText({ output: "line 1\nline 2" })).toBe("line 1\nline 2");
  });

  it("keeps any other result in its JSON form", () => {
    expect(toolResultText({ stdout: "ok", exitCode: 0 })).toBe('{"stdout":"ok","exitCode":0}');
  });
});
