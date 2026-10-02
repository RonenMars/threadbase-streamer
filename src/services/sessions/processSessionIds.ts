import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { runLsof } from "./codexRolloutOwner";

/**
 * Exact PID → session-id lookups for agent processes started outside the
 * streamer.
 *
 * Discovery used to learn a conversation id only from argv (`claude --resume
 * <id>`, `codex resume <uuid>`), so a plain `claude` or `codex` typed in a
 * terminal — the common case — had no id and was never listed. Matching by
 * working directory cannot replace it: three sessions in one folder share it,
 * and a wrong pairing would let terminate/adopt act on the wrong conversation.
 * Every lookup here is exact or returns null.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Claude: ~/.claude/sessions/<pid>.json ──────────────────────────────────
//
// Claude Code keeps a live registry keyed by its own pid (seen on 2.1.287):
//   { "pid": 120, "sessionId": "<uuid>", "cwd": "...", "kind": "interactive",
//     "entrypoint": "claude", "name": "...", "startedAt": <epoch ms>,
//     "procStart": "447", "status": "busy", "statusUpdatedAt": <epoch ms>, ... }
// `procStart` is field 22 of /proc/<pid>/stat on Linux (start time in clock
// ticks since boot), which pins the entry to one process exactly.
// It is an internal implementation detail, not a documented API, so it is read
// defensively and any shape it does not recognise is "no evidence", never an
// error: discovery falls back to argv exactly as before.

export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  kind?: string;
  startedAt?: number;
}

/**
 * How far before the live process's start a registry entry may claim to have
 * started. A dead process's file can outlive it, and its pid can be reused by a
 * new `claude` that has not written its own entry yet; that stale entry names
 * an older start. Generous, because `ps lstart` has one-second resolution and
 * Claude records its start a little after exec.
 */
export const CLAUDE_REGISTRY_START_SLACK_MS = 60_000;

/** `CLAUDE_CONFIG_DIR` relocates everything Claude keeps under `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Validate one registry file's contents for the process it is named after.
 * `processStartedAt` is the OS's start time for that pid, when known.
 */
export function parseClaudeRegistryEntry(
  raw: string,
  pid: number,
  processStartedAt?: Date,
  procStartTicks?: string,
): ClaudeRegistryEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;

  // The file is named by pid, but the content is what Claude asserts; a
  // mismatch means the file is not what we think it is.
  if (d.pid !== pid) return null;
  if (typeof d.sessionId !== "string" || !UUID.test(d.sessionId)) return null;

  // Exact where available: a different start tick is a different process.
  if (procStartTicks != null && typeof d.procStart === "string" && d.procStart !== procStartTicks) {
    return null;
  }

  const startedAt = typeof d.startedAt === "number" ? d.startedAt : undefined;
  if (
    startedAt != null &&
    processStartedAt != null &&
    startedAt < processStartedAt.getTime() - CLAUDE_REGISTRY_START_SLACK_MS
  ) {
    return null;
  }

  return {
    pid,
    sessionId: d.sessionId,
    ...(typeof d.cwd === "string" && d.cwd && { cwd: d.cwd }),
    ...(typeof d.name === "string" && d.name && { name: d.name }),
    ...(typeof d.kind === "string" && { kind: d.kind }),
    ...(startedAt != null && { startedAt }),
  };
}

export interface ReadClaudeRegistryOptions {
  configDir?: string;
  processStartedAt?: Date;
  /** Injection point for tests. */
  read?: (path: string) => Promise<string>;
}

/** Field 22 of /proc/<pid>/stat, or undefined off Linux / when unreadable. */
export function procStartFromStat(stat: string): string | undefined {
  // comm (field 2) is parenthesised and may contain spaces; count from after it.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // rest[0] is field 3, so field 22 is rest[19].
  const ticks = rest[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : undefined;
}

/** The registry entry for a live Claude pid, or null when there is none to trust. */
export async function readClaudeSessionRegistry(
  pid: number,
  options: ReadClaudeRegistryOptions = {},
): Promise<ClaudeRegistryEntry | null> {
  const path = join(options.configDir ?? claudeConfigDir(), "sessions", `${pid}.json`);
  const read = options.read ?? ((p: string) => readFile(p, "utf-8"));
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    // Absent (older Claude Code, or a process that has not written it yet).
    return null;
  }
  let ticks: string | undefined;
  try {
    ticks = procStartFromStat(await read(`/proc/${pid}/stat`));
  } catch {
    // Not Linux, or not readable: the start-time slack check still applies.
  }
  return parseClaudeRegistryEntry(raw, pid, options.processStartedAt, ticks);
}

// ─── Codex: the rollout a pid holds open ────────────────────────────────────
//
// Codex keeps its rollout JSONL open for the life of the session, and the
// rollout's filename ends in the session uuid — the same open-handle evidence
// `findRolloutOwner` uses in the other direction (rollout → pid).

/** Per-pid lsof is cheap, but discovery runs on list requests: bound it. */
export const CODEX_ROLLOUT_FOR_PID_TIMEOUT_MS = 800;

const ROLLOUT_NAME =
  /(?:^|[\\/])rollout-[^\\/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Rollout uuids named by `lsof -F n` output, distinct, in file order. */
export function parseLsofRolloutIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const id = line.slice(1).trim().match(ROLLOUT_NAME)?.[1]?.toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface CodexRolloutForPidOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Injection point for tests; defaults to a bounded `lsof -p <pid>`. */
  run?: (args: string[], timeoutMs: number) => Promise<string>;
}

/**
 * The session uuid of the one rollout `pid` holds open, or null: no evidence
 * (Windows, lsof missing/denied/slow, nothing open) or ambiguity (more than one
 * rollout open, which a standalone TUI does not do).
 */
export async function codexRolloutIdForPid(
  pid: number,
  options: CodexRolloutForPidOptions = {},
): Promise<string | null> {
  if ((options.platform ?? process.platform) === "win32") return null;
  const run = options.run ?? runLsof;
  let stdout: string;
  try {
    // -a ANDs the selectors: only this pid's regular files.
    stdout = await run(
      ["-a", "-p", String(pid), "-F", "n", "-w"],
      options.timeoutMs ?? CODEX_ROLLOUT_FOR_PID_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  const ids = parseLsofRolloutIds(stdout);
  return ids.length === 1 ? ids[0] : null;
}
