import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import type { HandoffTerminal } from "./config";
import { HANDOFF_TMUX_SESSION } from "./tmux";

/** Terminal apps setup offers and a handoff opens, keyed by the config value. */
export const TERMINAL_APPS = {
  ghostty: { name: "Ghostty", appPath: "/Applications/Ghostty.app" },
  terminal: { name: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app" },
} as const;

/** osascript can block on the macOS Automation permission prompt. */
export const TERMINAL_LAUNCH_TIMEOUT_MS = 3_000;

/** The configured terminal app, or null for "none" or an app no longer on disk. */
export function installedTerminal(
  terminal: HandoffTerminal,
): (typeof TERMINAL_APPS)[keyof typeof TERMINAL_APPS] | null {
  if (terminal === "none") return null;
  const app = TERMINAL_APPS[terminal];
  return existsSync(app.appPath) ? app : null;
}

/** True when a terminal is already attached to the `threadbase` session. */
export async function tmuxHasClient(tmuxPath: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)(tmuxPath, [
    "list-clients",
    "-t",
    `=${HANDOFF_TMUX_SESSION}`,
  ]);
  return stdout.trim() !== "";
}

/** Open `terminal` attached to the `threadbase` session; rejects on failure or timeout. */
export async function launchTerminal(
  terminal: Exclude<HandoffTerminal, "none">,
  tmuxPath: string,
): Promise<void> {
  const attach = ["attach", "-t", HANDOFF_TMUX_SESSION];
  const [file, args] =
    terminal === "ghostty"
      ? ["/usr/bin/open", ["-na", "Ghostty", "--args", "-e", tmuxPath, ...attach]]
      : [
          "/usr/bin/osascript",
          [
            "-e",
            'tell application "Terminal"',
            // do script runs a shell line: quote the path for the shell, then the
            // line for AppleScript, whose string escapes match JSON's for paths.
            "-e",
            `do script ${JSON.stringify(`'${tmuxPath.replaceAll("'", "'\\''")}' ${attach.join(" ")}`)}`,
            "-e",
            "activate",
            "-e",
            "end tell",
          ],
        ];
  await promisify(execFile)(file, args, { timeout: TERMINAL_LAUNCH_TIMEOUT_MS });
}
