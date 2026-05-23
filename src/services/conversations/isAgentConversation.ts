import { closeSync, openSync, readSync, statSync } from "fs";

export const AGENT_ENTRYPOINT = "sdk-cli";

const PROBE_BYTES = 64 * 1024;
const MARKER = `"entrypoint":"${AGENT_ENTRYPOINT}"`;

// Per-file decision cache. Filled lazily; cleared only on process restart.
const fileDecisionCache = new Map<string, boolean>();

export function isAgentLine(line: { entrypoint?: string }): boolean {
  return line.entrypoint === AGENT_ENTRYPOINT;
}

// Probes the first 64 KB of the JSONL for the sdk-cli marker. The first line is
// often housekeeping (queue-operation, permission-mode) that omits entrypoint,
// so we cannot stop after a single line.
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
    const size = Math.min(statSync(filePath).size, PROBE_BYTES);
    if (size === 0) return false;
    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0);
    const decision = buf.toString("utf8").includes(MARKER);
    fileDecisionCache.set(filePath, decision);
    return decision;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export function clearAgentFileCacheForTests(): void {
  fileDecisionCache.clear();
}
