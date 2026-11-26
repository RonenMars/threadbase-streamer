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
// Claude marks a sidecar `finished` when a sub-agent's run ends while it waits
// on a background task (`sleep`, a build), and rewrites it when the task
// reports back. ponytail: the wait counts as live for at most this long, so an
// agent whose task never reports stops reading as running; a task that
// outlives it reads as finished until the agent writes again.
export const SUBAGENT_BG_WAIT_MAX_MS = 60 * 60_000;
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

async function readTail(filePath: string): Promise<string[]> {
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8").split("\n");
  } finally {
    await fh.close();
  }
}

type Block = { type?: string; id?: string; tool_use_id?: string; content?: unknown };

/** Parsed content of every line in the tail; a line cut by the window is skipped. */
function tailContents(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const l of lines) {
    try {
      out.push((JSON.parse(l) as { message?: { content?: unknown } }).message?.content);
    } catch {}
  }
  return out;
}

/** True when the transcript's tail holds a tool_use with no tool_result. */
async function hasOpenToolCall(filePath: string): Promise<boolean> {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const content of tailContents(await readTail(filePath))) {
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b.type === "tool_use" && b.id) uses.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) results.add(b.tool_use_id);
    }
  }
  return [...uses].some((id) => !results.has(id));
}

const BG_LAUNCHED = /Command running in background with ID: (\w+)/;
const BG_REPORTED = /<task-id>(\w+)<\/task-id>/;

/**
 * True when the tail holds a background Bash launch whose task id has no
 * `<task-id>` notification after it. Only Bash launches are recognised.
 */
async function hasPendingBackgroundTask(filePath: string): Promise<boolean> {
  const launched = new Set<string>();
  const reported = new Set<string>();
  for (const content of tailContents(await readTail(filePath))) {
    if (typeof content === "string") {
      const id = BG_REPORTED.exec(content)?.[1];
      if (id) reported.add(id);
    } else if (Array.isArray(content)) {
      for (const b of content as Block[]) {
        const text = b.type === "tool_result" && typeof b.content === "string" ? b.content : "";
        const id = BG_LAUNCHED.exec(text)?.[1];
        if (id) launched.add(id);
      }
    }
  }
  return [...launched].some((id) => !reported.has(id));
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
  if (finished) {
    info.subagentActive =
      quietMs < SUBAGENT_BG_WAIT_MAX_MS &&
      (await hasPendingBackgroundTask(filePath).catch(() => false));
  } else if (!info.subagentActive && quietMs < SUBAGENT_TOOL_CALL_MAX_MS) {
    info.subagentActive = await hasOpenToolCall(filePath).catch(() => false);
  }
  return info;
}
