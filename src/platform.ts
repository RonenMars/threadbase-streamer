import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

export const isWindows = platform() === "win32";

// where.exe matches any file literally named after the query, including
// extension-less POSIX shim scripts that npm installs alongside <name>.cmd /
// <name>.ps1 for git-bash/WSL. Windows CreateProcess can't execute those
// (they have no PE header), so picking where.exe's first line unconditionally
// risks handing node-pty a script instead of a binary — surfacing as
// "Cannot create process, error code: 193". Restrict matches to extensions
// CreateProcess can actually launch.
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat"]);

function isWindowsExecutablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ─── Claude executable resolution ─────────────────────────────────────────────
// On Windows, Task Scheduler strips PATH to bare system directories, so
// `claude` alone will not resolve. We try where.exe first, then fall back to
// well-known install locations before giving up and returning the bare name.
//
// On macOS, launchd inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin by default,
// which excludes both Homebrew prefixes. Without an explicit fallback,
// node-pty's execvp("claude", …) fails with ENOENT and every session
// dies in milliseconds — see docs/troubleshooting.md. The plist's
// EnvironmentVariables block is the primary fix; this is defense in depth.

let _claudeExe: string | undefined;

// Resolution is memoized for the process lifetime (see below), so a bad
// resolution otherwise stays bad until restart. Call this after a spawn
// using the cached path fails, so the next attempt re-resolves instead of
// repeating the same broken path on every retry/resume.
export function clearClaudeExeCache(): void {
  _claudeExe = undefined;
}

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
        .split("\n")
        .map((line) => line.trim())
        .find(isWindowsExecutablePath);
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
  } else {
    try {
      const found = execFileSync("/usr/bin/which", ["claude"], {
        encoding: "utf-8",
        timeout: 3000,
      })
        .trim()
        .split("\n")[0]
        .trim();
      if (found && existsSync(found)) {
        _claudeExe = found;
        return _claudeExe;
      }
    } catch {}

    const candidates = [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(homedir(), ".local", "bin", "claude"),
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

// ─── Codex executable resolution ──────────────────────────────────────────────
// Mirrors resolveClaudeExe() exactly, swapped for the `codex` binary. Same
// rationale: launchd/Task Scheduler strip PATH down to system directories, so
// an explicit which/where.exe + well-known-path fallback is needed.

let _codexExe: string | undefined;

// Mirrors clearClaudeExeCache() above — same memoize-then-invalidate-on-
// spawn-failure rationale, swapped for the `codex` binary.
export function clearCodexExeCache(): void {
  _codexExe = undefined;
}

export function resolveCodexExe(): string {
  if (_codexExe !== undefined) return _codexExe;

  if (isWindows) {
    try {
      const found = execFileSync("where.exe", ["codex"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 3000,
      })
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .find(isWindowsExecutablePath);
      if (found) {
        _codexExe = found;
        return _codexExe;
      }
    } catch {}

    const candidates = [
      join(homedir(), ".local", "bin", "codex.exe"),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Microsoft",
        "WindowsApps",
        "codex.exe",
      ),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        _codexExe = p;
        return _codexExe;
      }
    }
  } else {
    try {
      const found = execFileSync("/usr/bin/which", ["codex"], {
        encoding: "utf-8",
        timeout: 3000,
      })
        .trim()
        .split("\n")[0]
        .trim();
      if (found && existsSync(found)) {
        _codexExe = found;
        return _codexExe;
      }
    } catch {}

    const candidates = [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(homedir(), ".local", "bin", "codex"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        _codexExe = p;
        return _codexExe;
      }
    }
  }

  _codexExe = "codex";
  return _codexExe;
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
