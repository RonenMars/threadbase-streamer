import { execFileSync } from "node:child_process";
import { TASK_NAME } from "./constants";

/**
 * Windows backend for the Supervisor interface. Wraps Windows Task Scheduler
 * cmdlets via powershell.exe. Counterpart of launchd.ts for macOS.
 *
 * Task Scheduler has no equivalent of launchd's KeepAlive: SuccessfulExit=false,
 * so the marker-suppression mechanism (used by the shim on macOS) is not needed
 * here. When dev exits cleanly, the prod task simply remains stopped until
 * `tb-streamer prod start` (or system reboot, if the task is at-logon-triggered).
 */
function ps(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function psSafe(command: string): void {
  try {
    ps(command);
  } catch {
    // Intentionally swallowed — caller is one of the stop/disable variants where
    // "already gone" is the desired state.
  }
}

export function isAgentLoaded(): boolean {
  try {
    ps(`Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop | Out-Null`);
    return true;
  } catch {
    return false;
  }
}

export function bootoutAgent(): void {
  // Stop running instance + disable trigger. Mirrors macOS bootout semantics:
  // the task stays registered but will not run again until bootstrap.
  psSafe(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
  psSafe(`Disable-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | Out-Null`);
}

export function bootstrapAgent(_specPath: string): void {
  // _specPath is the plist path on macOS; ignored on Windows because the task
  // is already registered by scripts\deploy.ps1 setup. The caller is asking
  // us to re-enable + start it.
  ps(`Enable-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop | Out-Null`);
  ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
}

export function kickstartAgent(): void {
  psSafe(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
  ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
}

export function getAgentPid(): number | null {
  // Task Scheduler does not expose the running PID directly. WMI is the
  // best-available probe: find node.exe processes whose command line
  // mentions "cli.js serve". Returns the first match, or null.
  try {
    const out = ps(
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" ` +
        `| Where-Object { $_.CommandLine -like '*cli.js*serve*' } ` +
        `| Select-Object -First 1 -ExpandProperty ProcessId)`,
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
