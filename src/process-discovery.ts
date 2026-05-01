import { execFile } from "child_process";
import { platform } from "os";
import { basename, dirname } from "path";
import { isWindows } from "./platform";
import type { DiscoveredProcess } from "./types";

export async function discoverClaudeProcesses(): Promise<DiscoveredProcess[]> {
  if (platform() === "win32") return discoverWindows();
  return discoverUnix();
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

async function getPidsUnix(): Promise<number[]> {
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
  return new Date(raw);
}

// ─── Windows Helpers ───────────────────────────────────────────────

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

function extractResumeId(args: string): string | null {
  const match = args.match(/--resume\s+(\S+)/);
  return match?.[1] ?? null;
}

async function readGitBranch(dir: string): Promise<string> {
  try {
    return (
      await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeout: 3000 })
    ).trim();
  } catch {
    return "";
  }
}
