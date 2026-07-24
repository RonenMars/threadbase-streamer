/**
 * Codex rollout JSONL → Claude-shaped conversation lines for WS clients.
 *
 * Mobile's `parseLineToMessage` only understands Claude Code JSONL
 * (`type: "user"|"assistant"`, `message.role`, text blocks). Codex writes
 * `response_item` / `event_msg` / `session_meta` instead, so raw Codex lines
 * never become live bubbles. This helper normalizes chat-bearing Codex lines
 * into the Claude shape and drops everything else (including the duplicate
 * `event_msg` copies of each turn and `developer` role payloads).
 */

import type { NormalizeResult } from "../services/providers/capabilities";

type CodexContentBlock = {
  type?: string;
  text?: string;
};

function extractCodexText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const block = item as CodexContentBlock;
      const t = block?.type;
      if (
        (t === "input_text" || t === "output_text" || t === "text") &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

// Rollout envelope types this adapter understands. Anything outside this set is
// reported as `unknown` rather than dropped — a Codex release that renames or
// adds an envelope must be visible, not silently render an empty conversation.
// See docs/architecture/2026-07-24-provider-compatibility.md.
const KNOWN_CODEX_TYPES = new Set(["response_item", "event_msg", "session_meta", "turn_context"]);

/**
 * Classify one Codex rollout line (C2).
 *
 * Distinguishes "recognized, deliberately not rendered" (`ignored`) from "this
 * adapter has never seen this shape" (`unknown`). Both were `null` before, which
 * is why provider schema drift used to surface as an empty screen with no error.
 */
export function classifyCodexLine(line: string): NormalizeResult {
  let entry: {
    type?: string;
    timestamp?: string;
    payload?: {
      type?: string;
      role?: string;
      content?: unknown;
      id?: string;
    };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return { kind: "unknown", raw: line, reason: "line is not valid JSON" };
  }

  if (typeof entry.type !== "string" || !KNOWN_CODEX_TYPES.has(entry.type)) {
    return {
      kind: "unknown",
      raw: line,
      reason: `unrecognized rollout envelope type: ${String(entry.type)}`,
    };
  }

  // Recognized envelopes that legitimately carry no renderable chat.
  // event_msg duplicates each turn; session_meta/turn_context are headers.
  if (entry.type !== "response_item") {
    return { kind: "ignored", reason: `${entry.type} carries no chat content` };
  }

  const payload = entry.payload;
  if (payload?.type !== "message") {
    return { kind: "ignored", reason: `response_item payload is ${String(payload?.type)}` };
  }

  const role = payload.role;
  if (role !== "user" && role !== "assistant") {
    // `developer` and friends are known Codex roles we deliberately hide.
    return { kind: "ignored", reason: `role ${String(role)} is not rendered` };
  }

  const text = extractCodexText(payload.content);
  if (!text) {
    return { kind: "ignored", reason: "message has no extractable text" };
  }

  // Synthetic Codex context dumps (AGENTS.md / permissions instructions) are
  // written as `role: user` before any real user turn. Hide them from the live
  // overlay so the chat doesn't open with fake user bubbles.
  if (role === "user" && isCodexInjectedContext(text)) {
    return { kind: "ignored", reason: "synthetic injected context" };
  }

  return { kind: "message", line: buildClaudeShapedLine(entry, payload, role, text) };
}

/**
 * Returns a Claude-shaped JSONL line, or null when the input is not a
 * user/assistant chat message that clients should render.
 *
 * Thin wrapper over classifyCodexLine so existing callers keep their signature.
 * New code should prefer classifyCodexLine, which explains WHY a line produced
 * nothing.
 */
export function normalizeCodexLineToClaudeShape(line: string): string | null {
  const result = classifyCodexLine(line);
  return result.kind === "message" ? result.line : null;
}

function buildClaudeShapedLine(
  entry: { timestamp?: string },
  payload: { id?: string },
  role: "user" | "assistant",
  text: string,
): string {
  const timestamp =
    typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  // Prefer payload.id when present; otherwise derive a stable-enough id from
  // timestamp+role+text prefix so WS seenIds can dedupe without colliding
  // across consecutive turns in the same second.
  const uuid =
    typeof payload.id === "string" && payload.id.length > 0
      ? payload.id
      : `codex-${role}-${timestamp}-${hashPrefix(text)}`;

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

/** True when a Codex rollout line is Codex-shaped (not Claude JSONL). */
export function isCodexRolloutLine(line: string): boolean {
  try {
    const entry = JSON.parse(line) as { type?: string };
    return (
      entry.type === "response_item" ||
      entry.type === "event_msg" ||
      entry.type === "session_meta" ||
      entry.type === "turn_context"
    );
  } catch {
    return false;
  }
}

/**
 * Map a batch of raw JSONL lines to client-facing lines. Codex batches are
 * normalized (and filtered); Claude batches pass through unchanged so seq
 * alignment is preserved.
 */
export function toClientConversationLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  // Heuristic: if any line in the batch is Codex-shaped, treat the whole batch
  // as Codex (a mixed batch shouldn't happen — one file, one provider).
  const codex = lines.some(isCodexRolloutLine);
  if (!codex) return lines;
  const out: string[] = [];
  for (const line of lines) {
    const normalized = normalizeCodexLineToClaudeShape(line);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function isCodexInjectedContext(text: string): boolean {
  // AGENTS.md / instruction dumps Codex prepends as the first "user" turn.
  if (text.startsWith("# AGENTS.md") || text.includes("<INSTRUCTIONS>")) return true;
  // Permissions / sandbox preamble sometimes arrives as a giant user-role blob.
  if (
    text.startsWith("<permissions instructions>") ||
    text.includes("Filesystem sandboxing defines")
  ) {
    return true;
  }
  // Streamer-injected prompts passed as Codex CLI argv (no --system-prompt flag).
  // DEFAULT_SYSTEM_PROMPT + BROWSE_SYSTEM_PROMPT land as role:user in the rollout.
  if (text.includes("limit the options to at most 3")) return true;
  if (text.includes("You are working within the project boundary:")) return true;
  if (
    text.includes(
      "Do not read, write, or execute commands that access files or directories outside this boundary",
    )
  ) {
    return true;
  }
  return false;
}

function hashPrefix(text: string): string {
  // Short non-crypto fingerprint for id uniqueness within a session.
  let h = 0;
  const sample = text.slice(0, 64);
  for (let i = 0; i < sample.length; i++) {
    h = (h * 31 + sample.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
