/**
 * Cursor CLI agent-transcripts JSONL → Claude-shaped conversation lines.
 *
 * Cursor writes `{ role, message: { content: [{ type, text }] } }` (no `type`
 * envelope field, no per-line CLI version). Mobile's parser only understands
 * Claude Code JSONL, so chat-bearing lines are rewritten to that shape.
 */

import type { NormalizeResult } from "../services/providers/capabilities";

const KNOWN_ROLES = new Set(["user", "assistant", "tool", "system"]);

type ContentBlock = {
  type?: string;
  text?: string;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const block = item as ContentBlock;
      if ((block?.type === "text" || block?.type === undefined) && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function classifyCursorLine(line: string): NormalizeResult {
  let entry: {
    role?: string;
    type?: string;
    message?: { content?: unknown; role?: string };
    content?: unknown;
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return { kind: "unknown", raw: line, reason: "line is not valid JSON" };
  }

  const role = entry.role ?? entry.message?.role;
  if (typeof role !== "string" || !KNOWN_ROLES.has(role)) {
    return {
      kind: "unknown",
      raw: line,
      reason: `unrecognized cursor transcript role: ${String(role)}`,
    };
  }

  if (role !== "user" && role !== "assistant") {
    return { kind: "ignored", reason: `role ${role} is not rendered` };
  }

  const text = extractText(entry.message?.content ?? entry.content);
  if (!text) {
    return { kind: "ignored", reason: "message has no extractable text" };
  }

  return { kind: "message", line: buildClaudeShapedLine(role, text) };
}

function buildClaudeShapedLine(role: "user" | "assistant", text: string): string {
  const timestamp = new Date().toISOString();
  const uuid = `cursor-${role}-${timestamp}-${hashPrefix(text)}`;
  return JSON.stringify({
    type: role,
    uuid,
    timestamp,
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function hashPrefix(text: string): string {
  let h = 0;
  const slice = text.slice(0, 48);
  for (let i = 0; i < slice.length; i++) h = (h * 31 + slice.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
