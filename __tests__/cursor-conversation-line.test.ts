import { parseCursorJsonlLine } from "@threadbase-sh/scanner";
import { classifyCursorLine } from "../src/utils/cursorConversationLine";

describe("classifyCursorLine", () => {
  it("normalizes a user text line to a Claude-shaped message", () => {
    const result = classifyCursorLine(
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    );
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    const parsed = JSON.parse(result.line);
    expect(parsed.type).toBe("user");
    expect(parsed.message.content[0].text).toBe("hello");
  });

  it("ignores tool roles", () => {
    expect(
      classifyCursorLine(JSON.stringify({ role: "tool", message: { content: [{ text: "x" }] } })),
    ).toEqual({ kind: "ignored", reason: "role tool is not rendered" });
  });

  it("reports unrecognized shapes as unknown", () => {
    const result = classifyCursorLine(JSON.stringify({ type: "mystery" }));
    expect(result.kind).toBe("unknown");
  });

  it("reports non-JSON as unknown", () => {
    const result = classifyCursorLine("not-json");
    expect(result.kind).toBe("unknown");
  });

  it("ignores turn_ended markers instead of reporting them unknown", () => {
    expect(
      classifyCursorLine(JSON.stringify({ type: "turn_ended", status: "error", error: "x" })),
    ).toEqual({ kind: "ignored", reason: "turn_ended carries no chat content" });
  });

  // Real Cursor assistant line shape: text plus id-less tool_use blocks.
  const toolLine = JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "Checking the PR." },
        { type: "tool_use", name: "Shell", input: { command: "gh pr view 1" } },
      ],
    },
  });

  it("renders tool_use blocks with the scanner's derived ids", () => {
    const result = classifyCursorLine(toolLine);
    if (result.kind !== "message") throw new Error(result.kind);
    const blocks = JSON.parse(result.line).message.content;
    expect(blocks[0]).toEqual({ type: "text", text: "Checking the PR." });
    expect(blocks[1]).toMatchObject({ type: "tool_use", name: "Shell" });
    expect(blocks[1].id).toMatch(/^cursor-tool-[0-9a-f]{16}$/);
  });

  it("renders a tool-only line", () => {
    const result = classifyCursorLine(
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "Glob", input: { glob_pattern: "*" } }] },
      }),
    );
    expect(result.kind).toBe("message");
  });

  it("derives the same uuid for the same line", () => {
    const a = classifyCursorLine(toolLine);
    const b = classifyCursorLine(toolLine);
    if (a.kind !== "message" || b.kind !== "message") throw new Error("not a message");
    expect(JSON.parse(a.line).uuid).toBe(JSON.parse(b.line).uuid);
    expect(JSON.parse(a.line).uuid).toMatch(/^cursor-assistant-[0-9a-f]{16}$/);
  });

  it("ignores a line with neither text nor tool calls", () => {
    expect(
      classifyCursorLine(JSON.stringify({ role: "assistant", message: { content: [] } })).kind,
    ).toBe("ignored");
  });

  it("uses the scanner's uuid for the line's index, so a live copy matches REST", () => {
    const live = classifyCursorLine(toolLine, 4);
    if (live.kind !== "message") throw new Error(live.kind);
    expect(JSON.parse(live.line).uuid).toBe(parseCursorJsonlLine(toolLine, 4)?.uuid);
    expect(JSON.parse(live.line).uuid).toMatch(/^cursor-assistant-4-[0-9a-f]{16}$/);
  });

  it("keeps two identical lines distinct when their indexes differ", () => {
    const a = classifyCursorLine(toolLine, 4);
    const b = classifyCursorLine(toolLine, 9);
    if (a.kind !== "message" || b.kind !== "message") throw new Error("not a message");
    expect(JSON.parse(a.line).uuid).not.toBe(JSON.parse(b.line).uuid);
  });
});
