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

// Chunked scan: read 64 KB at a time and early-exit on the first marker hit.
// The marker can sit deep in the file (observed up to ~217 KB after long
// housekeeping/queue-operation prefixes), so a one-shot 64 KB read misses
// many real agent JSONLs. PROBE_MAX_BYTES caps total work for pathological
// files; 2 MB covers every sample I measured with headroom.
const CHUNK_BYTES = 64 * 1024;
const PROBE_MAX_BYTES = 2 * 1024 * 1024;
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
    const ceiling = Math.min(fileSize, PROBE_MAX_BYTES);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let carry = "";

    while (offset < ceiling) {
      const toRead = Math.min(CHUNK_BYTES, ceiling - offset);
      const got = readSync(fd, buf, 0, toRead, offset);
      if (got <= 0) break;
      const chunk = carry + buf.toString("utf8", 0, got);
      for (const marker of markers) {
        if (chunk.includes(marker)) {
          fileDecisionCache.set(key, true);
          return true;
        }
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
