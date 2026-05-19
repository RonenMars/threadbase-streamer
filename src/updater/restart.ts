import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface RestartResult {
  method: "launchctl" | "systemctl" | "schtasks" | "none";
  stdout: string;
  stderr: string;
}

export interface StopResult {
  method: "schtasks-end" | "noop" | "none";
  stdout: string;
  stderr: string;
}

export interface RestartOptions {
  /** Override for tests; defaults to platform-appropriate label. */
  serviceLabel?: string;
}

// Defaults match what scripts/deploy.sh, scripts/deploy-linux.sh, and
// scripts/deploy.ps1 actually create. Env-var overrides honor the same names
// the deploy scripts read, so a user with a customized label only configures
// it once.
function resolveDefaultLabel(): string | undefined {
  if (process.platform === "darwin") {
    return process.env.LAUNCHD_LABEL ?? "com.ronen.threadbase";
  }
  if (process.platform === "linux") {
    return process.env.THREADBASE_SYSTEMD_UNIT ?? "threadbase.service";
  }
  if (process.platform === "win32") {
    return process.env.THREADBASE_TASK_NAME ?? "Threadbase";
  }
  return undefined;
}

/**
 * Restarts the platform service that hosts the streamer. Assumes the service
 * was installed by the deploy scripts and is named with the platform-default
 * label. Returns the method used and the command output for logging.
 *
 * Caller (the CLI) is responsible for catching errors — a failed restart
 * after a successful swap leaves the streamer on the new version but stopped
 * until the next boot, which is recoverable.
 */
export async function restartService(opts: RestartOptions = {}): Promise<RestartResult> {
  const label = opts.serviceLabel ?? resolveDefaultLabel();
  if (!label) {
    return { method: "none", stdout: "", stderr: `Unsupported platform: ${process.platform}` };
  }

  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const { stdout, stderr } = await execFileP("launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${label}`,
    ]);
    return { method: "launchctl", stdout, stderr };
  }

  if (process.platform === "linux") {
    const { stdout, stderr } = await execFileP("systemctl", ["--user", "restart", label]);
    return { method: "systemctl", stdout, stderr };
  }

  if (process.platform === "win32") {
    const { stdout, stderr } = await execFileP("schtasks.exe", ["/End", "/TN", label]).catch(
      (err) => ({ stdout: "", stderr: String(err) }),
    );
    const startResult = await execFileP("schtasks.exe", ["/Run", "/TN", label]);
    return {
      method: "schtasks",
      stdout: `${stdout}\n${startResult.stdout}`,
      stderr: `${stderr}\n${startResult.stderr}`,
    };
  }

  return { method: "none", stdout: "", stderr: `Unsupported platform: ${process.platform}` };
}

/**
 * Stops the platform service without restarting it. Only meaningful on
 * Windows, where the streamer process holds open handles into
 * `~/.threadbase/current/dist/cli.cjs`; replacing that directory while the
 * process is live fails with EBUSY. macOS/Linux swap via atomic symlink
 * rename and do not need a pre-swap stop — `stopService` is a no-op there.
 */
export async function stopService(opts: RestartOptions = {}): Promise<StopResult> {
  if (process.platform !== "win32") {
    return { method: "noop", stdout: "", stderr: "" };
  }
  const label = opts.serviceLabel ?? resolveDefaultLabel();
  if (!label) {
    return { method: "none", stdout: "", stderr: "No service label resolved" };
  }
  const { stdout, stderr } = await execFileP("schtasks.exe", ["/End", "/TN", label]).catch(
    (err) => ({ stdout: "", stderr: String(err) }),
  );
  return { method: "schtasks-end", stdout, stderr };
}
