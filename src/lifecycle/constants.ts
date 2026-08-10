import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const TASK_NAME = process.env.THREADBASE_TASK_NAME ?? "Threadbase";
export const DEFAULT_PROD_PORT = 8766;

export function installDir(): string {
  return process.env.THREADBASE_INSTALL_DIR ?? join(homedir(), ".threadbase");
}

export function markerPath(): string {
  return join(installDir(), "prod-suspended.json");
}

export function prefsPath(): string {
  return join(installDir(), "dev-prefs.json");
}

export function activeLink(): string {
  return join(installDir(), "cli.js");
}

/**
 * Absolute paths to the supervised streamer's stdout/stderr logs — the single
 * source of truth every supervisor backend and deploy script must agree on.
 *
 * macOS points the plist's StandardOutPath/StandardErrorPath here; Windows has
 * no native redirection, so `scripts/deploy.ps1` writes the same two paths into
 * launch.cmd as cmd `>>` targets. That agreement is what `tb-streamer prod logs`
 * depends on, and it is locked by `__tests__/deploy-windows-script.test.ts`.
 */
export function logPaths(): { stdout: string; stderr: string } {
  const dir = join(installDir(), "logs");
  return { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
}
