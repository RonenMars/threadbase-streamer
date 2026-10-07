import { createHash } from "crypto";
import type { NormalizeResult } from "../services/providers/capabilities";

// Explicit list: new vendor events must remain visible as compatibility drift.
// Shape reference: github/copilot-sdk docs/features/streaming-events.md.
const NON_CHAT_EVENTS = new Set([
  "session.start",
  "session.resume",
  "session.idle",
  "session.shutdown",
  "session.info",
  "session.model_change",
  "session.compaction_start",
  "session.compaction_complete",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.usage",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
]);

/** Copilot events → the common chat envelope. Not bulk history indexing. */
export function classifyCopilotLine(raw: string): NormalizeResult {
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unknown", raw, reason: "expected an event object" };
    }
    event = parsed;
  } catch {
    return { kind: "unknown", raw, reason: "invalid JSON" };
  }
  if (typeof event.type === "string" && NON_CHAT_EVENTS.has(event.type)) {
    return { kind: "ignored", reason: `${event.type} is not a complete chat message` };
  }
  if (event.type !== "user.message" && event.type !== "assistant.message") {
    return { kind: "unknown", raw, reason: `unrecognized Copilot event: ${String(event.type)}` };
  }
  const data = event.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("content" in data) ||
    typeof data.content !== "string"
  ) {
    return { kind: "unknown", raw, reason: "message content must be text" };
  }
  const role = event.type === "user.message" ? "user" : "assistant";
  const content: unknown[] = [];
  if (data.content) content.push({ type: "text", text: data.content });
  if ("toolRequests" in data && Array.isArray(data.toolRequests)) {
    for (const tool of data.toolRequests) {
      if (
        !tool ||
        typeof tool !== "object" ||
        typeof tool.toolCallId !== "string" ||
        typeof tool.name !== "string"
      ) {
        return { kind: "unknown", raw, reason: "malformed tool request" };
      }
      content.push({
        type: "tool_use",
        id: tool.toolCallId,
        name: tool.name,
        input: tool.arguments ?? {},
      });
    }
  }
  if (content.length === 0) return { kind: "ignored", reason: "empty message" };
  return {
    kind: "message",
    line: JSON.stringify({
      type: role,
      uuid:
        typeof event.id === "string"
          ? event.id
          : `copilot-${createHash("sha256").update(raw).digest("hex")}`,
      ...(typeof event.timestamp === "string" && { timestamp: event.timestamp }),
      message: { role, content },
    }),
  };
}
