/**
 * Canonicalize a JSONL file path so the same file always resolves to the same
 * cache row / watcher key regardless of separator style.
 *
 * chokidar delivers native backslash paths on Windows, while the scanner
 * populates conversation_meta.file_path with forward slashes. Without
 * normalizing both to one separator, cache lookups (invalidateByFilePath /
 * getIdByFilePath / fileIndex) and watcher keys (watch/unwatch/poke) silently
 * miss scanner-populated rows on Windows — the delete no-ops and the poke
 * self-heal is dead. POSIX only works by coincidence (both separators are "/").
 *
 * Rules:
 *   - Trim surrounding whitespace
 *   - Convert backslashes to forward slashes
 *
 * Do NOT lowercase: even on case-insensitive Windows filesystems, lowercasing
 * would diverge the key from the scanner's case-preserved file_path. Only the
 * separator is normalized; case is preserved.
 */
export function canonicalizeFilePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/");
}
