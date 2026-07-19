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
  /** Streamer port whose listener must be stopped on Windows. */
  port?: number;
}

// launchd label Homebrew registers for `brew services start tb-streamer`.
// Distinct from the deploy.sh label below, so a brew install must be detected
// at runtime rather than assumed.
const BREW_LAUNCHD_LABEL = "homebrew.mxcl.tb-streamer";
const DEPLOY_LAUNCHD_LABEL = "com.ronen.threadbase";

// Defaults match what scripts/deploy-linux.sh and scripts/deploy.ps1 actually
// create. Env-var overrides honor the same names the deploy scripts read, so a
// user with a customized label only configures it once. macOS is resolved
// separately (resolveDarwinLabel) because it probes for the brew service.
function resolveDefaultLabel(): string | undefined {
  if (process.platform === "linux") {
    return process.env.THREADBASE_SYSTEMD_UNIT ?? "threadbase.service";
  }
  if (process.platform === "win32") {
    return process.env.THREADBASE_TASK_NAME ?? "Threadbase";
  }
  return undefined;
}

// Reports whether a launchd label is loaded for the current GUI domain. Used to
// tell a Homebrew-managed service apart from a deploy.sh one — `launchctl print`
// exits non-zero when the target isn't loaded.
async function isLaunchdLabelLoaded(uid: number, label: string): Promise<boolean> {
  try {
    await execFileP("launchctl", ["print", `gui/${uid}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

// macOS label resolution: explicit option → LAUNCHD_LABEL env → detected brew
// label → deploy.sh default. The brew probe runs only when neither the option
// nor the env var pins a label, so a configured install never pays for it.
async function resolveDarwinLabel(uid: number, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.LAUNCHD_LABEL) return process.env.LAUNCHD_LABEL;
  if (await isLaunchdLabelLoaded(uid, BREW_LAUNCHD_LABEL)) return BREW_LAUNCHD_LABEL;
  return DEPLOY_LAUNCHD_LABEL;
}

/**
 * Restarts the platform service that hosts the streamer. On macOS the label is
 * resolved at runtime (brew service detected, else the deploy.sh default);
 * Linux/Windows use the platform-default label. Returns the method used and the
 * command output for logging.
 *
 * Caller (the CLI) is responsible for catching errors — a failed restart
 * after a successful swap leaves the streamer on the new version but stopped
 * until the next boot, which is recoverable.
 */
export async function restartService(opts: RestartOptions = {}): Promise<RestartResult> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const label = await resolveDarwinLabel(uid, opts.serviceLabel);
    const { stdout, stderr } = await execFileP("launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${label}`,
    ]);
    return { method: "launchctl", stdout, stderr };
  }

  const label = opts.serviceLabel ?? resolveDefaultLabel();
  if (!label) {
    return { method: "none", stdout: "", stderr: `Unsupported platform: ${process.platform}` };
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
  const listenerResult = await stopWindowsListener(opts.port ?? 8766);
  return {
    method: "schtasks-end",
    stdout: `${stdout}\n${listenerResult.stdout}`,
    stderr: `${stderr}\n${listenerResult.stderr}`,
  };
}

async function stopWindowsListener(port: number): Promise<{ stdout: string; stderr: string }> {
  let netstat: { stdout: string; stderr: string };
  try {
    netstat = await execFileP("netstat.exe", ["-ano", "-p", "tcp"]);
  } catch (err) {
    return { stdout: "", stderr: `Could not inspect port ${port}: ${String(err)}` };
  }

  const pids = new Set<string>();
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
    const [localAddress, state, pid] = [columns[1], columns[3], columns[4]];
    if (state?.toUpperCase() !== "LISTENING" || !pid || pid === "0") continue;
    if (localAddress?.endsWith(`:${port}`)) pids.add(pid);
  }

  const output: string[] = [];
  const errors: string[] = [];
  for (const pid of pids) {
    try {
      const result = await execFileP("taskkill.exe", ["/PID", pid, "/T", "/F"]);
      output.push(result.stdout);
      if (result.stderr) errors.push(result.stderr);
    } catch (err) {
      errors.push(`Could not stop PID ${pid} on port ${port}: ${String(err)}`);
    }
  }
  return { stdout: output.join("\n"), stderr: errors.join("\n") };
}
