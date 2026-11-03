import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Background agents of one Claude conversation, read straight off its JSONL.
 *
 * The scanner drops both records that carry them: a launch is a `user` record
 * whose top-level `toolUseResult` is `{ status: "async_launched", agentId, … }`,
 * and a completion is a `queue-operation` `enqueue` record holding a
 * `<task-notification>`. The same notification is then delivered a second time
 * as a `user` record; only the `queue-operation` is read here, so each
 * completion counts once.
 */

/** Unknown provider states pass through as strings, so the union stays open. */
export type BackgroundAgentStatus =
  | "running"
  | "idle"
  | "completed"
  | "stopped"
  | "failed"
  | (string & {});

export interface BackgroundAgent {
  agentId: string;
  description: string;
  agentType?: string;
  status: BackgroundAgentStatus;
  launchedAt?: string;
  completedAt?: string;
  summary?: string;
  toolCallId?: string;
}

/** Claude's own words for how a task ended, mapped onto the shared vocabulary. */
const CLAUDE_STATUS: Record<string, BackgroundAgentStatus> = { killed: "stopped" };

/** Cheap substring gate: a line that holds none of these is never JSON-parsed. */
const NEEDLES = ['"async_launched"', "<task-notification>", '"subagent_type"'];
const mayMatter = (line: string): boolean => NEEDLES.some((n) => line.includes(n));

const tag = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

/**
 * Pairs launches with completions, in launch order. A completion whose launch
 * is not in `lines` is ignored (the launch may predate a truncated read, and a
 * guess at a description is worse than no entry).
 */
export function deriveClaudeBackgroundAgents(lines: Iterable<string>): BackgroundAgent[] {
  const agents = new Map<string, BackgroundAgent>();
  // tool_use id -> subagent_type, from the assistant record that made the call.
  const typeByToolCall = new Map<string, string>();
  const launchOrder: string[] = [];

  for (const line of lines) {
    if (!mayMatter(line)) continue;
    let rec: Record<string, unknown> | undefined;
    try {
      rec = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!rec) continue;
    const message = asRecord(rec.message);
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];

    if (rec.type === "assistant") {
      for (const raw of blocks) {
        const b = asRecord(raw);
        const input = asRecord(b?.input);
        if (
          b?.type === "tool_use" &&
          typeof b.id === "string" &&
          typeof input?.subagent_type === "string"
        ) {
          typeByToolCall.set(b.id, input.subagent_type);
        }
      }
      continue;
    }

    const launch = asRecord(rec.toolUseResult);
    if (launch?.status === "async_launched" && typeof launch.agentId === "string") {
      if (agents.has(launch.agentId)) continue;
      const toolCallId = blocks
        .map(asRecord)
        .find((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string")?.tool_use_id as
        | string
        | undefined;
      agents.set(launch.agentId, {
        agentId: launch.agentId,
        description: typeof launch.description === "string" ? launch.description : "",
        ...(toolCallId &&
          typeByToolCall.has(toolCallId) && { agentType: typeByToolCall.get(toolCallId) }),
        status: "running",
        ...(typeof rec.timestamp === "string" && { launchedAt: rec.timestamp }),
        ...(toolCallId && { toolCallId }),
      });
      launchOrder.push(launch.agentId);
      continue;
    }

    if (
      rec.type === "queue-operation" &&
      rec.operation === "enqueue" &&
      typeof rec.content === "string"
    ) {
      const agent = agents.get(tag(rec.content, "task-id") ?? "");
      const status = tag(rec.content, "status");
      if (!agent || !status) continue;
      agent.status = CLAUDE_STATUS[status] ?? status;
      if (typeof rec.timestamp === "string") agent.completedAt = rec.timestamp;
      const summary = tag(rec.content, "summary");
      if (summary) agent.summary = summary;
    }
  }

  return launchOrder.map((id) => agents.get(id) as BackgroundAgent);
}

// path -> result for the (mtime, size) it was computed at. Bounded so a long
// session list cannot grow it without limit; the oldest entry goes first.
const CACHE_MAX = 32;
const cache = new Map<string, { mtimeMs: number; size: number; agents: BackgroundAgent[] }>();

/** Reads one JSONL, line by line, and derives its background agents. Opt-in path only. */
export async function readClaudeBackgroundAgents(filePath: string): Promise<BackgroundAgent[]> {
  const { mtimeMs, size } = await stat(filePath);
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.agents;

  const wanted: string[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (mayMatter(line)) wanted.push(line);

  const agents = deriveClaudeBackgroundAgents(wanted);
  cache.delete(filePath);
  cache.set(filePath, { mtimeMs, size, agents });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return agents;
}
