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
});
