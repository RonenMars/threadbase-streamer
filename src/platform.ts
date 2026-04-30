import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

export const isWindows = platform() === "win32";

// ─── Claude executable resolution ─────────────────────────────────────────────
// On Windows, Task Scheduler strips PATH to bare system directories, so
// `claude` alone will not resolve. We try where.exe first, then fall back to
// well-known install locations before giving up and returning the bare name.

let _claudeExe: string | undefined;

export function resolveClaudeExe(): string {
  if (_claudeExe !== undefined) return _claudeExe;

  if (isWindows) {
    try {
      const found = execFileSync("where.exe", ["claude"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 3000,
      })
        .trim()
        .split("\n")[0]
        .trim();
      if (found) {
        _claudeExe = found;
        return _claudeExe;
      }
    } catch {}

    const candidates = [
      join(homedir(), ".local", "bin", "claude.exe"),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Microsoft",
        "WindowsApps",
        "claude.exe",
      ),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        _claudeExe = p;
        return _claudeExe;
      }
    }
  }

  _claudeExe = "claude";
  return _claudeExe;
}

// ─── execHidden ────────────────────────────────────────────────────────────────
// Thin wrapper around execFileSync that adds windowsHide: true on Windows so
// spawned child processes (where.exe, tasklist, wmic, pgrep, git …) don't
// flash a console window.

type SyncOptions = Parameters<typeof execFileSync>[2];

export function execHidden(
  file: string,
  args: string[],
  opts?: SyncOptions & { encoding: "utf-8" },
): string {
  return execFileSync(file, args, {
    windowsHide: isWindows,
    ...opts,
  }) as string;
}
