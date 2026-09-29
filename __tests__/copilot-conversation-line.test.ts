import { classifyCopilotLine } from "../src/utils/copilotConversationLine";

describe("Copilot event normalization", () => {
  it.each(["user", "assistant"])("normalizes %s text with stable event identity", (role) => {
    const result = classifyCopilotLine(
      JSON.stringify({
        id: "event-id",
        timestamp: "2026-09-01T00:00:00Z",
        type: `${role}.message`,
        data: { content: "hello" },
      }),
    );
    expect(result.kind).toBe("message");
    if (result.kind === "message")
      expect(JSON.parse(result.line)).toEqual({
        type: role,
        uuid: "event-id",
        timestamp: "2026-09-01T00:00:00Z",
        message: { role, content: [{ type: "text", text: "hello" }] },
      });
  });
  it("ignores recognized duplicate deltas but surfaces unknown or malformed events", () => {
    expect(
      classifyCopilotLine('{"type":"assistant.message_delta","data":{"deltaContent":"hi"}}').kind,
    ).toBe("ignored");
    for (const raw of [
      "null",
      "[]",
      "{",
      '{"type":"future.event"}',
      '{"type":"user.message","data":null}',
    ]) {
      expect(classifyCopilotLine(raw)).toMatchObject({ kind: "unknown", raw });
    }
  });
});

import { readFileSync } from "fs";
import { join } from "path";

it("classifies every event in the documentation-derived fixture", () => {
  const lines = readFileSync(
    join(__dirname, "fixtures/providers/copilot/documented-shape/conversation.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  expect(lines.map((line) => classifyCopilotLine(line).kind)).toEqual([
    "ignored",
    "message",
    "ignored",
    "message",
  ]);
});
