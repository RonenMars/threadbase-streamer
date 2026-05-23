import { closeSync, openSync, readSync, statSync } from "fs";

// Default agent entrypoints. Override via THREADBASE_AGENT_ENTRYPOINTS
// (comma-separated). Interactive Claude Code emits entrypoint="cli" and is
// never in this set.
//   - sdk-cli      → Claude Agent SDK, claude-mem, hook-spawned automation
//   - claude-vscode → VS Code extension when invoked headlessly (memory
//                     summarizers, etc.). Real interactive VS Code sessions
//                     also use this value, so toggling via env var lets users
//                     keep them visible if they want.
export const DEFAULT_AGENT_ENTRYPOINTS: ReadonlySet<string> = new Set(["sdk-cli", "claude-vscode"]);

// Chunked scan: read 64 KB at a time with early-exit. We look for the first
// `"entrypoint":` occurrence in the file:
//   - matches an agent marker → return true
//   - matches some other entrypoint value (e.g. "cli") → return false
//   - never appears → return false
// The entrypoint is fixed per-conversation, so the first occurrence is
// authoritative. This keeps both agent and human files fast (typical first
// hit is within the first chunk), while still tolerating long housekeeping
// prefixes (observed agent markers as deep as 2.3 MB in 4.5 MB observer files).
const CHUNK_BYTES = 64 * 1024;
const ENTRYPOINT_PROBE = `"entrypoint":`;
// Overlap consecutive chunks so a marker that straddles the boundary is still
// found. The longest entrypoint we look for is ~24 chars; 64 bytes overlap is
// plenty.
const CHUNK_OVERLAP = 64;

// Per-file decision cache, keyed by `${filePath}::${sortedEntrypointsKey}` so
// changing the set invalidates entries. Filled lazily; cleared on restart.
const fileDecisionCache = new Map<string, boolean>();

function markersFor(entrypoints: ReadonlySet<string>): string[] {
  return [...entrypoints].map((e) => `"entrypoint":"${e}"`);
}

function cacheKey(filePath: string, entrypoints: ReadonlySet<string>): string {
  return `${filePath}::${[...entrypoints].sort().join(",")}`;
}

export function isAgentLine(
  line: { entrypoint?: string },
  entrypoints: ReadonlySet<string> = DEFAULT_AGENT_ENTRYPOINTS,
): boolean {
  return line.entrypoint !== undefined && entrypoints.has(line.entrypoint);
}

export function isAgentFile(
  filePath: string,
  entrypoints: ReadonlySet<string> = DEFAULT_AGENT_ENTRYPOINTS,
): boolean {
  if (entrypoints.size === 0) return false;
  const key = cacheKey(filePath, entrypoints);
  const cached = fileDecisionCache.get(key);
  if (cached !== undefined) return cached;

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }

  try {
    const fileSize = statSync(filePath).size;
    if (fileSize === 0) {
      fileDecisionCache.set(key, false);
      return false;
    }

    const markers = markersFor(entrypoints);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let carry = "";

    while (offset < fileSize) {
      const toRead = Math.min(CHUNK_BYTES, fileSize - offset);
      const got = readSync(fd, buf, 0, toRead, offset);
      if (got <= 0) break;
      const chunk = carry + buf.toString("utf8", 0, got);

      // Agent match wins.
      for (const marker of markers) {
        if (chunk.includes(marker)) {
          fileDecisionCache.set(key, true);
          return true;
        }
      }

      // If we see ANY entrypoint field, it's per-conversation and stable —
      // since none of the agent markers matched, this is a non-agent file.
      // Stops 11 MB human JSONLs from being read in full.
      if (chunk.includes(ENTRYPOINT_PROBE)) {
        fileDecisionCache.set(key, false);
        return false;
      }

      carry = chunk.slice(-CHUNK_OVERLAP);
      offset += got;
    }

    fileDecisionCache.set(key, false);
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// Comma-separated parser. Empty string → empty set (filtering off in practice
// even when filterAgentConversations=true, since no entrypoint qualifies).
export function parseAgentEntrypointsEnv(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return DEFAULT_AGENT_ENTRYPOINTS;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts);
}

export function clearAgentFileCacheForTests(): void {
  fileDecisionCache.clear();
}
