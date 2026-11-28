import { execFile } from "child_process";
import { readFileSync } from "fs";

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Foreground process group of the process's controlling terminal; -1/0 when none. */
  tpgid: number;
  /** `pts/3`, `ttys003`; `?` / `??` when the process has no controlling terminal. */
  tty: string;
}

/** `ps -A -o pid=,ppid=,pgid=,tpgid=,tty=` is the same on Linux procps and macOS. */
export function parsePsTable(stdout: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>();
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [pid, ppid, pgid, tpgid] = f.slice(0, 4).map(Number);
    if (![pid, ppid, pgid, tpgid].every(Number.isInteger)) continue;
    rows.set(pid, { pid, ppid, pgid, tpgid, tty: f[4] });
  }
  return rows;
}

export function readProcessTable(): Promise<Map<number, ProcRow>> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,tty="],
      { timeout: 2_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, out) => (err ? reject(err) : resolve(parsePsTable(out))),
    );
  });
}

/**
 * The process's start, as the OS records it, so a reused pid reads as a
 * different process. Linux: field 22 of /proc/<pid>/stat (clock ticks since
 * boot; the boot id is folded in by the caller's server generation). Elsewhere:
 * `ps -o lstart=`, second resolution. Null when unreadable — never a guess.
 */
export function processStartToken(pid: number): Promise<string | null> {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is parenthesised and may hold spaces or `)`; split after the last `)`.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = rest[22 - 3];
    if (start && /^\d+$/.test(start)) return Promise.resolve(`linux:${start}`);
  } catch {}
  if (process.platform === "linux") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 1_000 }, (err, out) => {
      const s = err ? "" : String(out).trim();
      resolve(s ? `ps:${s}` : null);
    });
  });
}

export type ForegroundVerdict =
  | { ok: true }
  | { ok: false; reason: "process_gone" | "tty_mismatch" | "not_descendant" | "background" };

/**
 * Whether `agentPid` is the program a keystroke into this pane reaches: it runs
 * on the pane's tty, descends from the pane's process, and its process group is
 * the terminal's foreground group. A background job, a process on another tty
 * (a nested tmux's inner pane), or one that merely shares the cwd all fail.
 */
export function verifyForeground(
  table: Map<number, ProcRow>,
  agentPid: number,
  pane: { panePid: number; paneTty: string },
): ForegroundVerdict {
  const agent = table.get(agentPid);
  if (!agent) return { ok: false, reason: "process_gone" };
  if (agent.tty !== pane.paneTty) return { ok: false, reason: "tty_mismatch" };
  let cur: ProcRow | undefined = agent;
  let descends = false;
  for (let hops = 0; cur && hops < 64; hops++) {
    if (cur.pid === pane.panePid) {
      descends = true;
      break;
    }
    if (cur.ppid === cur.pid || cur.ppid <= 0) break;
    cur = table.get(cur.ppid);
  }
  if (!descends) return { ok: false, reason: "not_descendant" };
  if (agent.tpgid <= 0 || agent.pgid !== agent.tpgid) return { ok: false, reason: "background" };
  return { ok: true };
}
