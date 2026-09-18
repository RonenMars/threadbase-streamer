import type { ConversationMessage } from "@threadbase-sh/scanner";

/**
 * A scanner-parsed message → one Claude Code JSONL line, the only shape
 * mobile's live parser (`parseLineToMessage`) renders.
 *
 * Content comes from the same scanner parse that serves the message over REST,
 * so a live bubble and its reloaded copy carry the same blocks and ids:
 * thinking, text, tool_use (toolUseBlocks), tool_result (toolResults).
 */
export function toClaudeShapedLine(message: ConversationMessage, uuid: string): string {
  const content: unknown[] = [];
  if (message.isThinking && message.thinkingContent) {
    content.push({ type: "thinking", thinking: message.thinkingContent });
  }
  if (message.text) content.push({ type: "text", text: message.text });
  for (const b of message.metadata?.toolUseBlocks ?? []) {
    content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  for (const r of message.metadata?.toolResults ?? []) {
    content.push({
      type: "tool_result",
      tool_use_id: r.toolUseId,
      content: toolResultText(r.content),
      is_error: r.isError ?? false,
    });
  }
  return JSON.stringify({
    type: message.role,
    uuid,
    timestamp: message.timestamp || new Date().toISOString(),
    message: { role: message.role, content },
  });
}

/**
 * A scanner tool result's content as the string a client renders. Codex results
 * carry their program output as `content.output`: send that verbatim, the way a
 * live Claude tool_result carries its text, not a JSON object whose newlines
 * arrive escaped. Every other result keeps its JSON form.
 */
export function toolResultText(content: Record<string, unknown> | undefined): string {
  const output = content?.output;
  return typeof output === "string" ? output : JSON.stringify(content);
}
