import { toClientConversationLines } from "./codexConversationLine";

export type LastTextMessage = { role: "user" | "assistant"; text: string; timestamp: string };

/**
 * The newest user/assistant message in a transcript batch that carries text,
 * for a live session's `lastMessageText` / `lastMessageRole`.
 *
 * Codex and Cursor lines go through the same normalizer the WS transcript uses,
 * so every provider is read in Claude shape. Sidechain (subagent) and meta lines
 * are skipped, and so are tool-only lines, so the value does not blank mid-turn.
 * Text is truncated to 200 characters, as the conversation cache does.
 */
export function lastTextMessage(lines: string[]): LastTextMessage | null {
  const clientLines = toClientConversationLines(lines).lines;
  for (let i = clientLines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(clientLines[i]);
    } catch {
      continue;
    }
    const role = entry?.message?.role ?? entry?.type;
    if (role !== "user" && role !== "assistant") continue;
    if (entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.find((b) => b?.type === "text" && typeof b.text === "string")?.text
          : undefined;
    if (!text?.trim()) continue;
    return { role, text: text.slice(0, 200), timestamp: entry.timestamp };
  }
  return null;
}
