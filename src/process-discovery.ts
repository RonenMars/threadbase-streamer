import { execFileSync } from "child_process";
import { platform } from "os";
import { basename, dirname } from "path";
import type { DiscoveredProcess } from "./types";

export function discoverClaudeProcesses(): DiscoveredProcess[] {
  const os = platform();
  if (os === "win32") return discoverWindows();
  return discoverUnix();
}

function discoverUnix(): DiscoveredProcess[] {
  const pids = getPidsUnix();
  const results: DiscoveredProcess[] = [];

  for (const pid of pids) {
    try {
      const cwd = getProcessCwdUnix(pid);
      const args = getProcessArgsUnix(pid);
      const startedAt = getProcessStartTimeUnix(pid);
      const conversationId = extractResumeId(args);

      results.push({
        pid,
        projectPath: cwd,
        projectName: basename(cwd),
        branch: readGitBranch(cwd),
        conversationId,
        startedAt,
      });
    } catch {
      // Process may have exited between pgrep and enrichment
    }
  }

  return results;
}

function discoverWindows(): DiscoveredProcess[] {
  const pids = getPidsWindows();
  const results: DiscoveredProcess[] = [];

  for (const pid of pids) {
    try {
      const info = getProcessInfoWindows(pid);
      if (!info) continue;

      results.push({
        pid,
        projectPath: info.cwd,
        projectName: basename(info.cwd),
        branch: readGitBranch(info.cwd),
        conversationId: extractResumeId(info.args),
        startedAt: info.startedAt,
      });
    } catch {
      // Process may have exited
    }
  }

  return results;
}

// ─── Unix Helpers ──────────────────────────────────────────────────

function getPidsUnix(): number[] {
  try {
    const output = execFileSync("pgrep", ["-x", "claude"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10));
  } catch {
    return [];
  }
}

function getProcessCwdUnix(pid: number): string {
  const output = execFileSync("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  });
  const match = output.match(/n(.+)/);
  return match?.[1] ?? "";
}

function getProcessArgsUnix(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  }).trim();
}

function getProcessStartTimeUnix(pid: number): Date {
  const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  }).trim();
  return new Date(raw);
}

// ─── Windows Helpers ───────────────────────────────────────────────

function getPidsWindows(): number[] {
  try {
    const output = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    );
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

function getProcessInfoWindows(pid: number): { cwd: string; args: string; startedAt: Date } | null {
  try {
    const output = execFileSync(
      "wmic",
      [
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "CommandLine,CreationDate,ExecutablePath",
        "/FORMAT:CSV",
      ],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    );
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

function readGitBranch(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}
