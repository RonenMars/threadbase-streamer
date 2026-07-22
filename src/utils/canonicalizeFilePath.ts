import { normalize } from "path";

/**
 * File-path identity across the scanner/cache boundary.
 *
 * Two path forms exist in this process and they are NOT interchangeable on
 * Windows:
 *
 *   - **canonical** (forward slashes) — every cache key: conversation_meta
 *     .file_path, the fileIndex, watcher keys, externalTails.
 *   - **native** (the platform separator) — what the scanner emits in
 *     ConversationMeta.filePath, and what chokidar delivers.
 *
 * Both writers of conversation_meta.file_path (upsertFull, insertSkeleton)
 * store the canonical form, so the storage invariant is "cache keys are always
 * canonical". The scanner has no such rule: it emits native paths, verified by
 * measurement on win32.
 *
 * The rule when the two meet: **normalize for the comparison, emit in the
 * consumer's form.** Canonicalize both sides to join them, then key the result
 * with whichever form the code receiving it will look up by. Joining a
 * scanner-derived path against a cache-derived one without normalizing fails
 * silently — an empty map or a false, never an exception — and is invisible on
 * POSIX, where the two forms are identical.
 */

/**
 * Canonicalize a path for use as a cache/DB/watcher key.
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

/**
 * Convert a canonical path back to the platform-native form.
 *
 * Use only when handing a path *back* to something that keys by native paths —
 * in practice the scanner's statCache, whose entries it looks up by its own
 * ConversationMeta.filePath. A no-op on POSIX; on win32 `normalize` rewrites
 * forward slashes to backslashes.
 */
export function toNativeFilePath(filePath: string): string {
  return normalize(filePath.trim());
}

/**
 * Build the canonical live-path set that `reconcileDeletions` compares against
 * `conversation_meta.file_path`.
 *
 * Exists as a named function rather than an inline `.map()` so the conversion
 * has one place to be tested and one place to be got wrong: the scanner's
 * filePath is native, the rows it is checked against are canonical, and a
 * missed conversion here means every row falls through to the existsSync
 * backstop instead of being recognised as live.
 */
export function canonicalLivePathSet(metas: Iterable<{ filePath?: string | null }>): Set<string> {
  const live = new Set<string>();
  for (const meta of metas) {
    if (meta.filePath) live.add(canonicalizeFilePath(meta.filePath));
  }
  return live;
}

/**
 * Join scanner metadata against canonically-keyed stat rows, producing the map
 * the scanner expects back as `statCache`.
 *
 * This is the boundary rule made concrete: the lookup is done in canonical
 * form (because that is how the rows are keyed) while the result is keyed by
 * the meta's own native path (because that is what the scanner looks up by).
 * Getting either half wrong yields an empty or unusable map and silently
 * disables the scanner's stat cache — no error, just a full re-parse of every
 * conversation on every rescan.
 */
export function joinStatCacheByNativePath<TStat, TMeta extends { filePath?: string | null }>(
  metas: Iterable<TMeta>,
  canonicalStats: Map<string, TStat>,
): Map<string, { stat: TStat; meta: TMeta }> {
  const joined = new Map<string, { stat: TStat; meta: TMeta }>();
  for (const meta of metas) {
    if (!meta.filePath) continue;
    const stat = canonicalStats.get(canonicalizeFilePath(meta.filePath));
    if (stat) joined.set(meta.filePath, { stat, meta });
  }
  return joined;
}
