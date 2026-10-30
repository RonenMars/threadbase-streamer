import { readFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { z } from "zod";

// A sub-agent has no PTY, so recent writes are the fallback signal. Claude's
// sidecar `finished` and an unanswered tool_use in the transcript override it.
export const SUBAGENT_ACTIVE_MS = 60_000;
// ponytail: an open tool call counts as active for at most this long, so a
// killed agent's dangling tool_use stops reading as live. Bash caps at 10 min;
// a nested agent can run longer and will read as finished until it writes.
export const SUBAGENT_TOOL_CALL_MAX_MS = 10 * 60_000;
const TAIL_BYTES = 64 * 1024;

const sidecar = z.object({
  agentType: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  finished: z.boolean().optional(),
});

export interface SubagentInfo {
  subagentType?: string;
  subagentDescription?: string;
  subagentName?: string;
  /**
   * False once the sidecar says `finished`. Otherwise true while the
   * transcript was written to within SUBAGENT_ACTIVE_MS, or while its last
   * tool call has no result yet (up to SUBAGENT_TOOL_CALL_MAX_MS).
   */
  subagentActive: boolean;
}

/** True when the transcript's tail holds a tool_use with no tool_result. */
async function hasOpenToolCall(filePath: string): Promise<boolean> {
  const fh = await open(filePath, "r");
  let text: string;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  // A line cut by the window fails to parse and is skipped.
  const lines = text.split("\n");
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const l of lines) {
    let o: { message?: { content?: unknown } };
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (!Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content as { type?: string; id?: string; tool_use_id?: string }[]) {
      if (b.type === "tool_use" && b.id) uses.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) results.add(b.tool_use_id);
    }
  }
  return [...uses].some((id) => !results.has(id));
}

/** True while a Claude sidecar exists and has not been marked finished. */
export function isSubagentSidecarOpen(filePath: string): boolean {
  try {
    const raw = readFileSync(filePath.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const parsed = sidecar.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.finished !== true;
  } catch {
    return false;
  }
}

/**
 * Label and liveness for a sub-agent row. Claude writes `agent-<id>.meta.json`
 * beside `agent-<id>.jsonl`; Codex and Cursor have no sidecar, so they get
 * liveness only. A missing or malformed sidecar is not an error: the row just
 * goes unlabelled.
 */
export async function readSubagentInfo(
  filePath: string,
  lastActivity: string,
  now = Date.now(),
): Promise<SubagentInfo> {
  const quietMs = now - new Date(lastActivity).getTime();
  const info: SubagentInfo = { subagentActive: quietMs < SUBAGENT_ACTIVE_MS };
  let finished = false;
  try {
    const raw = await readFile(filePath.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const parsed = sidecar.safeParse(JSON.parse(raw));
    if (parsed.success) {
      info.subagentType = parsed.data.agentType;
      info.subagentDescription = parsed.data.description;
      info.subagentName = parsed.data.name;
      finished = parsed.data.finished === true;
    }
  } catch {
    // no sidecar for this provider, or unreadable
  }
  if (finished) info.subagentActive = false;
  else if (!info.subagentActive && quietMs < SUBAGENT_TOOL_CALL_MAX_MS) {
    info.subagentActive = await hasOpenToolCall(filePath).catch(() => false);
  }
  return info;
}
