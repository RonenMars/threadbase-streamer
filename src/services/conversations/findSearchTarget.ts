export interface SearchTargetMatch {
  messageIndex: number;
  uuid: string | null;
  snippet: string;
  /**
   * All matching message indexes, ascending. When any plain-text match exists
   * only text matches are listed (they are the navigable/highlightable ones);
   * otherwise the thinking/tool fallback matches are. Capped at the LAST
   * MAX_MATCH_INDEXES entries — navigation starts at the tail-most match.
   */
  matchIndexes: number[];
  /** Uncapped true match count (the "of M" in the client counter). */
  totalMatches: number;
}

// Structural view of the scanner's parsed message — mirrors the fields
// handleGetConversation already reads off it, so no scanner import is needed.
export interface SearchableMessage {
  text?: string;
  uuid?: string | null;
  isThinking?: boolean;
  thinkingContent?: string;
  metadata?: {
    toolUseBlocks?: Array<{ input?: unknown }>;
    toolResults?: Array<{ content?: unknown }>;
  };
}

const SNIPPET_CONTEXT = 60;
const MAX_MATCH_INDEXES = 1000;

function buildSnippet(source: string, matchStart: number, matchLength: number): string {
  const start = Math.max(0, matchStart - SNIPPET_CONTEXT);
  const end = Math.min(source.length, matchStart + matchLength + SNIPPET_CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  return `${prefix}${source.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

// Thinking and tool payloads are searchable so a hit inside a tool card can
// still anchor the scroll, even though mobile only highlights plain text.
function extendedBody(m: SearchableMessage): string {
  const parts: string[] = [];
  if (m.isThinking && m.thinkingContent) parts.push(m.thinkingContent);
  for (const b of m.metadata?.toolUseBlocks ?? []) {
    if (b.input !== undefined) parts.push(JSON.stringify(b.input));
  }
  for (const r of m.metadata?.toolResults ?? []) {
    if (r.content !== undefined) parts.push(JSON.stringify(r.content));
  }
  return parts.join("\n");
}

function collectMatches(
  messages: SearchableMessage[],
  needle: string,
  body: (m: SearchableMessage) => string,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (body(messages[i]).toLowerCase().includes(needle)) indexes.push(i);
  }
  return indexes;
}

// Resolves a search hit to its matching messages: the anchor is the LAST
// message chronologically whose body contains the query (case-insensitive
// literal substring — no tokenization, and no regex built from user input).
// Text matches are preferred over thinking/tool matches because only text is
// visually highlightable on mobile.
export function findSearchTarget(
  messages: SearchableMessage[],
  query: string,
): SearchTargetMatch | null {
  const needle = query.toLowerCase();

  let body = (m: SearchableMessage) => m.text ?? "";
  let matches = collectMatches(messages, needle, body);
  if (matches.length === 0) {
    body = extendedBody;
    matches = collectMatches(messages, needle, body);
  }
  if (matches.length === 0) return null;

  const anchorIndex = matches[matches.length - 1];
  const anchorBody = body(messages[anchorIndex]);
  const at = anchorBody.toLowerCase().indexOf(needle);
  return {
    messageIndex: anchorIndex,
    uuid: messages[anchorIndex].uuid ?? null,
    snippet: buildSnippet(anchorBody, at, query.length),
    matchIndexes: matches.slice(-MAX_MATCH_INDEXES),
    totalMatches: matches.length,
  };
}
