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
