import * as launchd from "./launchd";
import * as taskScheduler from "./task-scheduler";

export interface Supervisor {
  /** True if the platform service supervisor knows about our service. */
  isAgentLoaded(): boolean;
  /** Stop & unload the supervised service. Idempotent. */
  bootoutAgent(): void;
  /**
   * Re-load the supervised service from its on-disk definition.
   * macOS: `launchctl bootstrap gui/<uid> <plist>` — `specPath` is the plist path.
   * Windows: `Enable-ScheduledTask` — `specPath` is ignored (the task is already registered).
   *
   * @param opts.afterBootout - If true, tolerate exit 5 + empty stderr when
   *   isAgentLoaded() is true. Set this when calling bootstrap immediately
   *   after bootoutAgent() where the "already loaded" race is benign.
   */
  bootstrapAgent(specPath: string, opts?: { afterBootout?: boolean }): void;
  /** Restart the service (stop+start). */
  kickstartAgent(): void;
  /** PID of the running supervised service, or null. */
  getAgentPid(): number | null;
  /**
   * Absolute paths to the stdout/stderr log files for the supervised service.
   * Throws on platforms where log redirection is not yet wired (Windows today).
   */
  getLogPaths(): { stdout: string; stderr: string };
}

export function getSupervisor(): Supervisor {
  if (process.platform === "darwin") {
    return launchd;
  }
  if (process.platform === "win32") {
    return taskScheduler;
  }
  throw new Error(`lifecycle: unsupported platform ${process.platform}. Supported: darwin, win32.`);
}
