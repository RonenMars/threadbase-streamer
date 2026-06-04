// src/agent/history-mapper.ts
//
// Converts a CachedTail (the shape ConversationCache returns) into a
// ConversationTurn[] (the shape the worker's UserInputSignal expects).
//
// Rules per spec §4:
// - Text blocks: keep, concatenate with "\n".
// - tool_use, tool_result, thinking blocks: drop.
// - Messages with empty content after stripping: drop.
// - Unknown roles: drop with WARN.

import type { ConversationTurn } from "@threadbase/agent-types";
import type { CachedTail } from "../conversation-cache";
import { getLogger } from "../logger";

const log = getLogger("agent.history-mapper");

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "thinking"; thinking: string }
  | { type: string; [key: string]: unknown };

function extractText(message: { text?: string; content?: unknown[] | null }): string {
  // Prefer structured content[] over flat text if both are present.
  if (Array.isArray(message.content)) {
    const blocks = message.content as ContentBlock[];
    const textParts: string[] = [];
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        textParts.push(block.text);
      }
      // tool_use / tool_result / thinking: ignored by design.
    }
    return textParts.join("\n");
  }
  return typeof message.text === "string" ? message.text : "";
}

export function mapTailToConversationTurns(tail: CachedTail | null): ConversationTurn[] {
  if (!tail || !Array.isArray(tail.messages) || tail.messages.length === 0) {
    return [];
  }

  const turns: ConversationTurn[] = [];
  for (const message of tail.messages) {
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      log.warn("unknown role in tail; skipping", {
        role,
        conversationId: tail.conversationId,
      });
      continue;
    }
    const content = extractText(message);
    if (!content || content.length === 0) {
      continue;
    }
    turns.push({ role, content });
  }
  return turns;
}
