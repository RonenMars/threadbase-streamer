/**
 * Cursor CLI agent-transcripts JSONL → Claude-shaped conversation lines.
 *
 * Cursor writes `{ role, message: { content: [{ type, text } | { type:
 * "tool_use", name, input }] } }` (no `type` envelope field, no per-line CLI
 * version), plus `{ type: "turn_ended" }` markers. Mobile's parser only
 * understands Claude Code JSONL, so chat-bearing lines are rewritten to that
 * shape from the scanner's parse — the same one REST serves them from.
 */

import { createHash } from "node:crypto";
import { parseCursorJsonlLine } from "@threadbase-sh/scanner";
import type { NormalizeResult } from "../services/providers/capabilities";
import { toClaudeShapedLine } from "./claudeShapedLine";

const KNOWN_ROLES = new Set(["user", "assistant", "tool", "system"]);
// Envelope types Cursor writes that carry no chat content.
const KNOWN_MARKER_TYPES = new Set(["turn_ended"]);

type CursorEntry = {
  role?: string;
  type?: string;
  message?: { content?: unknown; role?: string };
};

function parseEntry(line: string): CursorEntry | null {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

/** True when a line is Cursor agent-transcripts shaped (not Claude or Codex JSONL). */
export function isCursorTranscriptLine(line: string): boolean {
  const entry = parseEntry(line);
  if (!entry) return false;
  if (typeof entry.type === "string") return KNOWN_MARKER_TYPES.has(entry.type);
  return typeof entry.role === "string" && KNOWN_ROLES.has(entry.role);
}

export function classifyCursorLine(line: string): NormalizeResult {
  const entry = parseEntry(line);
  if (!entry) return { kind: "unknown", raw: line, reason: "line is not valid JSON" };

  if (typeof entry.type === "string" && KNOWN_MARKER_TYPES.has(entry.type)) {
    return { kind: "ignored", reason: `${entry.type} carries no chat content` };
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

  const message = parseCursorJsonlLine(line);
  if (!message) {
    return { kind: "ignored", reason: "message has no text or tool calls" };
  }

  // Cursor lines carry no id. Derive one from the line itself so the same line
  // read twice (replay, reconnect) dedupes on the client.
  const uuid = `cursor-${role}-${createHash("sha1").update(line).digest("hex").slice(0, 16)}`;
  return { kind: "message", line: toClaudeShapedLine(message, uuid) };
}
