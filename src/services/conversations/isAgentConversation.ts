import { closeSync, openSync, readSync, statSync } from "fs";

export const AGENT_ENTRYPOINT = "sdk-cli";

// Chunked scan: read 64 KB at a time and early-exit on the first marker hit.
// The marker can sit deep in the file (observed up to ~217 KB after long
// housekeeping/queue-operation prefixes), so a one-shot 64 KB read misses
// many real agent JSONLs. PROBE_MAX_BYTES caps total work for pathological
// files; 2 MB covers every sample I measured with headroom.
const CHUNK_BYTES = 64 * 1024;
const PROBE_MAX_BYTES = 2 * 1024 * 1024;
// Overlap consecutive chunks so a marker that straddles the boundary is still
// found. The marker is 22 bytes; 32 bytes overlap is enough.
const CHUNK_OVERLAP = 32;
const MARKER = `"entrypoint":"${AGENT_ENTRYPOINT}"`;

// Per-file decision cache. Filled lazily; cleared only on process restart.
const fileDecisionCache = new Map<string, boolean>();

export function isAgentLine(line: { entrypoint?: string }): boolean {
  return line.entrypoint === AGENT_ENTRYPOINT;
}

export function isAgentFile(filePath: string): boolean {
  const cached = fileDecisionCache.get(filePath);
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
      fileDecisionCache.set(filePath, false);
      return false;
    }

    const ceiling = Math.min(fileSize, PROBE_MAX_BYTES);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let carry = "";

    while (offset < ceiling) {
      const toRead = Math.min(CHUNK_BYTES, ceiling - offset);
      const got = readSync(fd, buf, 0, toRead, offset);
      if (got <= 0) break;
      const chunk = carry + buf.toString("utf8", 0, got);
      if (chunk.includes(MARKER)) {
        fileDecisionCache.set(filePath, true);
        return true;
      }
      carry = chunk.slice(-CHUNK_OVERLAP);
      offset += got;
    }

    fileDecisionCache.set(filePath, false);
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export function clearAgentFileCacheForTests(): void {
  fileDecisionCache.clear();
}
