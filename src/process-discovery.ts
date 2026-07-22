import { execFile } from "child_process";
import { platform } from "os";
import { basename, dirname } from "path";
import { isWindows } from "./platform";
import type { DiscoveredProcess } from "./types";

export async function discoverClaudeProcesses(): Promise<DiscoveredProcess[]> {
  if (platform() === "win32") return discoverWindows();
  return discoverUnix();
}

// ─── Command-line identification ───────────────────────────────────

// The npm-installed CLI runs as `node <...>/claude-code/cli.js`, so matching on
// the process NAME alone (the old `pgrep -x claude` / `IMAGENAME eq claude.exe`)
// misses every shim install — the process is called `node`. Identify by what is
// actually being executed instead.
const CLAUDE_CLI_SCRIPT = /claude-code[\\/](?:cli|index)\.(?:js|mjs|cjs)$/i;
const JS_RUNTIMES = new Set(["node", "node.exe", "bun", "bun.exe", "deno", "deno.exe"]);

// Split a command line into tokens, honouring double-quoted paths (Windows
// installs live under "C:\Program Files\..." and would otherwise split apart).
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t")) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Whether a command line is a Claude Code CLI process.
 *
 * Accepts a native binary invoked by any path, and a JS runtime hosting the
 * published CLI entry point. Deliberately conservative: it inspects only the
 * executable and the script it runs, never the whole string, so an unrelated
 * process that merely mentions "claude" in a flag (an editor session, this
 * streamer itself) is not mistaken for an agent.
 */
export function looksLikeClaudeProcess(commandLine: string): boolean {
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length === 0) return false;

  const exe = basename(tokens[0]).toLowerCase();
  if (exe === "claude" || exe === "claude.exe") return true;

  if (JS_RUNTIMES.has(exe)) {
    // The script is the first non-flag argument (`node --flag script.js ...`).
    for (const raw of tokens.slice(1)) {
      if (raw.startsWith("-")) continue;
      return CLAUDE_CLI_SCRIPT.test(raw);
    }
  }
  return false;
}

async function discoverUnix(): Promise<DiscoveredProcess[]> {
  const pids = await getPidsUnix();

  const results = await Promise.all(
    pids.map(async (pid) => {
      try {
        const [cwd, args, startedAt] = await Promise.all([
          getProcessCwdUnix(pid),
          getProcessArgsUnix(pid),
          getProcessStartTimeUnix(pid),
        ]);
        const conversationId = extractResumeId(args);

        return {
          pid,
          projectPath: cwd,
          projectName: basename(cwd),
          branch: await readGitBranch(cwd),
          conversationId,
          startedAt,
        } satisfies DiscoveredProcess;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is DiscoveredProcess => r !== null);
}

async function discoverWindows(): Promise<DiscoveredProcess[]> {
  // Preferred: one CIM query for every candidate process. This finds npm-shim
  // installs (which run as node.exe) and drops the wmic dependency — wmic is
  // removed on current Windows 11 builds, where the legacy path below silently
  // yields nothing. Falls back to tasklist+wmic if PowerShell/CIM is unavailable.
  const viaCim = await discoverWindowsViaCim();
  if (viaCim) return viaCim;

  const pids = await getPidsWindows();

  const results = await Promise.all(
    pids.map(async (pid) => {
      try {
        const info = await getProcessInfoWindows(pid);
        if (!info) return null;

        return {
          pid,
          projectPath: info.cwd,
          projectName: basename(info.cwd),
          branch: await readGitBranch(info.cwd),
          conversationId: extractResumeId(info.args),
          startedAt: info.startedAt,
        } satisfies DiscoveredProcess;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is DiscoveredProcess => r !== null);
}

// ─── Unix Helpers ──────────────────────────────────────────────────

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: isWindows, encoding: "utf-8", timeout: opts.timeout ?? 5000, cwd: opts.cwd },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as string);
      },
    );
  });
}

// Parse `ps -eo pid=,args=` output into pids whose command line is a Claude CLI.
// Exported for tests — this is where shim installs (running as `node`) are
// recovered, which a name-only `pgrep -x claude` can never see.
export function parsePsOutput(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!(pid > 0)) continue;
    if (looksLikeClaudeProcess(match[2])) pids.push(pid);
  }
  return pids;
}

async function getPidsUnix(): Promise<number[]> {
  // One `ps` sweep matched on the command line. Falls back to the historical
  // name-only pgrep if ps is unavailable; that path finds native-binary installs
  // only, which is still better than returning nothing.
  try {
    return parsePsOutput(await run("ps", ["-eo", "pid=,args="]));
  } catch {
    // fall through
  }
  try {
    const output = await run("pgrep", ["-x", "claude"]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10));
  } catch {
    return [];
  }
}

async function getProcessCwdUnix(pid: number): Promise<string> {
  const output = await run("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"]);
  const match = output.match(/n(.+)/);
  return match?.[1] ?? "";
}

async function getProcessArgsUnix(pid: number): Promise<string> {
  return (await run("ps", ["-p", String(pid), "-o", "args="])).trim();
}

async function getProcessStartTimeUnix(pid: number): Promise<Date> {
  const raw = (await run("ps", ["-p", String(pid), "-o", "lstart="])).trim();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ─── Windows Helpers ───────────────────────────────────────────────

interface CimProcess {
  ProcessId: number;
  CommandLine: string | null;
  CreationDate: string | null;
}

// Parse the CIM/PowerShell JSON payload. Exported for tests: the shape differs
// for a single result (bare object) vs several (array), and CreationDate can
// arrive as an ISO string or as the /Date(ms)/ serialization.
export function parseCimProcesses(stdout: string): CimProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function parseCimDate(value: string | null): Date {
  if (value) {
    const epoch = value.match(/\/Date\((\d+)\)\//);
    if (epoch) return new Date(Number(epoch[1]));
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function discoverWindowsViaCim(): Promise<DiscoveredProcess[] | null> {
  let stdout: string;
  try {
    stdout = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress",
    ]);
  } catch {
    return null; // PowerShell unavailable — let the caller fall back.
  }

  let rows: CimProcess[];
  try {
    rows = parseCimProcesses(stdout);
  } catch {
    return null;
  }

  const results: DiscoveredProcess[] = [];
  for (const row of rows) {
    const commandLine = row.CommandLine ?? "";
    if (!commandLine || !looksLikeClaudeProcess(commandLine)) continue;
    // Windows exposes no process CWD (neither CIM nor wmic carries it), so the
    // project path is genuinely unknown here rather than guessed. The previous
    // code substituted the executable's own directory, which reported an
    // unrelated install path as the user's project.
    results.push({
      pid: row.ProcessId,
      projectPath: "",
      projectName: "",
      branch: "",
      conversationId: extractResumeId(commandLine),
      startedAt: parseCimDate(row.CreationDate),
    });
  }
  return results;
}

async function getPidsWindows(): Promise<number[]> {
  try {
    const output = await run("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",");
        return Number.parseInt(parts[1]?.replace(/"/g, "") ?? "0", 10);
      })
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

async function getProcessInfoWindows(
  pid: number,
): Promise<{ cwd: string; args: string; startedAt: Date } | null> {
  try {
    const output = await run("wmic", [
      "process",
      "where",
      `ProcessId=${pid}`,
      "get",
      "CommandLine,CreationDate,ExecutablePath",
      "/FORMAT:CSV",
    ]);
    // wmic uses CRLF; split on \r?\n so the blank separator line becomes "" and is filtered out.
    const lines = output
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    if (lines.length < 2) return null;

    const parts = lines[1].split(",");
    const args = parts[1] ?? "";
    const creationDate = parts[2] ?? "";

    // WMIC CreationDate format: 20260418153000.000000+000
    const year = creationDate.slice(0, 4);
    const month = creationDate.slice(4, 6);
    const day = creationDate.slice(6, 8);
    const hour = creationDate.slice(8, 10);
    const min = creationDate.slice(10, 12);
    const sec = creationDate.slice(12, 14);
    const startedAt = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
    if (Number.isNaN(startedAt.getTime())) return null;

    // CWD is not directly available via wmic; use the executable path's parent directory as fallback
    const exePath = parts[3] ?? "";
    const cwd = exePath ? dirname(exePath) : "";

    return { cwd, args, startedAt };
  } catch {
    return null;
  }
}

// ─── Shared Helpers ────────────────────────────────────────────────

// Pull the conversation id out of a command line. Handles the forms Claude Code
// accepts — `--resume <id>`, `--resume=<id>`, and the `-r` short flag — and
// refuses a value that is itself a flag: `claude --resume --model opus` has no
// id, and capturing "--model" would surface a session under a garbage id.
export function extractResumeId(args: string): string | null {
  const eq = args.match(/(?:--resume|-r)=(\S+)/);
  if (eq?.[1] && !eq[1].startsWith("-")) return eq[1];
  const spaced = args.match(/(?:--resume|-r)\s+(\S+)/);
  const candidate = spaced?.[1];
  if (!candidate || candidate.startsWith("-")) return null;
  return candidate;
}

async function readGitBranch(dir: string): Promise<string> {
  // An empty cwd would make execFile inherit OUR working directory, so an
  // unreadable process reported the streamer's own branch as if it were its own
  // (observed live). No directory, no answer.
  if (!dir) return "";
  try {
    return (
      await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeout: 3000 })
    ).trim();
  } catch {
    return "";
  }
}
