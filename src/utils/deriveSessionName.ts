/**
 * Derive a session title from its first user message.
 *
 * Mirrors `@threadbase-sh/scanner`'s `deriveSessionNameFromFirstMessage`
 * (first line of the first user message, truncated) so a live session gets
 * the same title a resumed/scanned one would compute from the same JSONL —
 * without waiting on the scanner or cache to observe the line.
 */
export function deriveSessionName(firstMessageText: string): string {
  const firstLine = firstMessageText.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 80);
}
