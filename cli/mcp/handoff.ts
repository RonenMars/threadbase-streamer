/**
 * `handoff_to_threadbase`: a terminal Claude Code session asks the streamer to
 * take it over. The tool only schedules; the streamer kills this terminal and
 * resumes the conversation as a managed session after the current turn ends
 * (`POST /api/sessions/:id/adopt-after-turn`), so the agent must finish its
 * reply rather than wait.
 *
 * The session identifies itself: this MCP server is a descendant of the
 * `claude` process, which writes `~/.claude/sessions/<pid>.json`. The agent
 * never supplies the id, so it cannot hand off a session other than its own.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ClaudeRegistryEntry,
  readClaudeSessionRegistry,
} from "../../src/services/sessions/processSessionIds";
import { StreamerHttpError, type StreamerTool, textResult } from "./client";

const execFileAsync = promisify(execFile);

/** Claude may sit behind a shell or npx wrapper; a handful of hops covers it. */
const MAX_HOPS = 8;

export const NOT_CLAUDE =
  "Handoff works only from inside a Claude Code session, and none was found above this MCP server. Nothing was changed.";
export const TOO_OLD =
  "This Threadbase streamer is too old for handoff; update it with `tb-streamer update` and retry. The terminal session keeps running.";
export const SCHEDULED =
  "Handoff scheduled. Tell the user in one line that this terminal session will close once this reply ends and the conversation continues in Threadbase, then end your turn without calling another tool.";

const REFUSALS: Record<string, string> = {
  HANDOFF_ALREADY_MANAGED:
    "This session is already managed by Threadbase; there is nothing to hand off.",
  HANDOFF_NO_TURN_STATE:
    "This Claude Code version does not report its turn state, so the streamer cannot tell when the turn ends; update Claude Code and retry. Nothing was changed.",
  HANDOFF_NOT_DISCOVERED:
    "The Threadbase streamer cannot see this session yet; send one more message in this terminal and retry. Nothing was changed.",
  HANDOFF_NO_PID:
    "The Threadbase streamer cannot see this session's process yet; send one more message in this terminal and retry. Nothing was changed.",
  HANDOFF_SESSION_MISMATCH:
    "The streamer could not confirm this session's identity, so it refused the handoff. Nothing was changed.",
  ADOPT_PROJECT_PATH_MISSING:
    "This session's project directory no longer exists, so Threadbase cannot resume it there. Nothing was changed.",
};

export interface FindOwnSessionOptions {
  startPid?: number;
  parentOf?: (pid: number) => Promise<number | null>;
  readEntry?: (pid: number) => Promise<ClaudeRegistryEntry | null>;
  platform?: NodeJS.Platform;
}

async function psParent(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], {
      timeout: 2_000,
    });
    const ppid = Number(stdout.trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** The nearest ancestor with a Claude registry entry, or null when there is none. */
export async function findOwnSession(
  opts: FindOwnSessionOptions = {},
): Promise<ClaudeRegistryEntry | null> {
  if ((opts.platform ?? process.platform) === "win32") return null;
  const parentOf = opts.parentOf ?? psParent;
  const readEntry = opts.readEntry ?? readClaudeSessionRegistry;
  let pid: number | null = opts.startPid ?? process.ppid;
  for (let hop = 0; hop < MAX_HOPS && pid != null && pid > 1; hop++) {
    const entry = await readEntry(pid);
    if (entry) return entry;
    pid = await parentOf(pid);
  }
  return null;
}

export function makeHandoffTools(
  find: () => Promise<ClaudeRegistryEntry | null> = findOwnSession,
): StreamerTool[] {
  return [
    {
      name: "handoff_to_threadbase",
      description:
        "Hand this Claude Code session over to Threadbase so it continues on the phone. " +
        "Takes no arguments: the session identifies itself. " +
        "Once the current turn ends, the Threadbase streamer closes this terminal and resumes the same conversation as a session it manages. " +
        "Call it only when the user asks to move this session to Threadbase; after it succeeds, tell the user in one line and end the turn.",
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async (_args, client) => {
        const own = await find();
        if (!own) throw new Error(NOT_CLAUDE);
        try {
          await client.post(`/api/sessions/${encodeURIComponent(own.sessionId)}/adopt-after-turn`, {
            pid: own.pid,
          });
        } catch (err) {
          if (!(err instanceof StreamerHttpError)) throw err;
          // A route that does not exist answers 404 with no code; every refusal of ours carries one.
          if (err.status === 404 && !err.code) throw new Error(TOO_OLD);
          const known = err.code ? REFUSALS[err.code] : undefined;
          throw new Error(
            known ?? `${err.message} Nothing was changed; the terminal session keeps running.`,
          );
        }
        return textResult({ scheduled: true, sessionId: own.sessionId, instruction: SCHEDULED });
      },
    },
  ];
}

export const handoffTools = makeHandoffTools();
