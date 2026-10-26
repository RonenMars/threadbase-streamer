import { readFile } from "node:fs/promises";
import { z } from "zod";

// ponytail: a sub-agent has no PTY, so "active" is a write-recency guess. A
// sub-agent blocked on a long tool call for longer than this reads as finished
// until its next line lands. Upgrade: match the parent's open Agent/Task tool_use.
export const SUBAGENT_ACTIVE_MS = 60_000;

const sidecar = z.object({
  agentType: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
});

export interface SubagentInfo {
  subagentType?: string;
  subagentDescription?: string;
  subagentName?: string;
  /** True while the transcript was written to within SUBAGENT_ACTIVE_MS. */
  subagentActive: boolean;
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
  const info: SubagentInfo = {
    subagentActive: now - new Date(lastActivity).getTime() < SUBAGENT_ACTIVE_MS,
  };
  try {
    const raw = await readFile(filePath.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const parsed = sidecar.safeParse(JSON.parse(raw));
    if (parsed.success) {
      info.subagentType = parsed.data.agentType;
      info.subagentDescription = parsed.data.description;
      info.subagentName = parsed.data.name;
    }
  } catch {
    // no sidecar for this provider, or unreadable
  }
  return info;
}
