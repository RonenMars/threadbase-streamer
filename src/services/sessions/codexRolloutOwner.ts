import { execFile } from "child_process";

/**
 * Who is holding a Codex rollout JSONL open right now.
 *
 * Codex enforces a single-writer rule per rollout and only reports it *after*
 * `codex resume` has started ("already has an active writer (code -32600)"),
 * by which point the streamer has already spawned a PTY and answered 201. The
 * heuristic pre-flight in conversationBusy.ts cannot see that owner: a Codex
 * process need not carry the rollout UUID in its argv, and a quiet-but-owned
 * rollout has an mtime well outside the busy window (the 2026-08-09 incident:
 * pid 9935 held the file open with an mtime older than 120 s).
 *
 * An open file handle on the exact rollout is direct evidence of the condition
 * Codex itself rejects, so it is the one pre-spawn signal worth paying for.
 *
 * It is an OPTIMISATION, never a proof of the negative: `lsof` is POSIX-only,
 * may be absent, may be denied, and cannot see another user's process. A null
 * result means "no evidence", and the caller must still rely on the
 * authoritative post-spawn handshake.
 */

/** Hard cap on the probe. Resume is latency-sensitive — a slow lsof is a miss. */
export const ROLLOUT_OWNER_TIMEOUT_MS = 800;

/**
 * How the owning process is best described to a client.
 *
 * Only a process whose command is exactly `codex` is classified, and even then
 * only as "terminal". A VS Code / desktop `codex app-server` can host several
 * unrelated threads, so mis-labelling one as a standalone TUI is what would
 * make a destructive recovery action look safe. Everything else stays
 * "unknown", and no takeover is ever offered from this signal.
 */
export type CodexOwnerSource = "terminal" | "unknown";

export interface CodexRolloutOwner {
  pid: number;
  command: string;
  source: CodexOwnerSource;
}

export interface FindRolloutOwnerOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Our own pid — the streamer's handles on the file are not a collision. */
  selfPid?: number;
  /** Injection point for tests; defaults to a bounded `lsof` call. */
  run?: (rolloutPath: string, timeoutMs: number) => Promise<string>;
}

function runLsof(rolloutPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -F pc → machine-readable field output, one `p<pid>` / `c<command>` per
    // line. -w silences warnings that would otherwise land on stdout.
    // `--` guards a path that starts with a dash.
    const child = execFile(
      "lsof",
      ["-F", "pc", "-w", "--", rolloutPath],
      { windowsHide: true },
      (err, stdout) => {
        clearTimeout(timer);
        // lsof exits 1 when nothing matches — that is a normal empty result,
        // and stdout is what we parse either way.
        if (err && !stdout) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );

    // The deadline is enforced here rather than via execFile's `timeout`
    // option, which only SIGTERMs. lsof walks every process on the box, and on
    // a busy machine it both outlives a polite signal and keeps its stdio
    // handles alive — enough to hold the whole streamer's event loop past
    // shutdown. Kill it outright, drop the pipes, and stop counting it.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error("lsof timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.unref();
  });
}

/** Parse `lsof -F pc` output into (pid, command) pairs, in file order. */
export function parseLsofFieldOutput(stdout: string): Array<{ pid: number; command: string }> {
  const owners: Array<{ pid: number; command: string }> = [];
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(n) ? n : null;
    } else if (line.startsWith("c") && pid != null) {
      owners.push({ pid, command: line.slice(1).trim() });
      pid = null;
    }
  }
  return owners;
}

/**
 * First foreign process holding `rolloutPath` open, or null when there is no
 * evidence of one (no match, unsupported platform, missing/denied/slow lsof).
 */
export async function findRolloutOwner(
  rolloutPath: string,
  options: FindRolloutOwnerOptions = {},
): Promise<CodexRolloutOwner | null> {
  const platform = options.platform ?? process.platform;
  // No portable open-handle enumeration on Windows; `handle.exe` is a separate
  // Sysinternals download and not something to shell out to on a resume path.
  if (platform === "win32") return null;

  const selfPid = options.selfPid ?? process.pid;
  const run = options.run ?? runLsof;

  let stdout: string;
  try {
    stdout = await run(rolloutPath, options.timeoutMs ?? ROLLOUT_OWNER_TIMEOUT_MS);
  } catch {
    // Timed out, not installed, or refused — no evidence either way.
    return null;
  }

  for (const { pid, command } of parseLsofFieldOutput(stdout)) {
    if (pid === selfPid) continue;
    return { pid, command, source: command === "codex" ? "terminal" : "unknown" };
  }
  return null;
}
