export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const DEFAULT_PROD_PORT = 8766;

export function installDir(): string {
  return process.env.THREADBASE_INSTALL_DIR ?? `${process.env.HOME}/.threadbase`;
}

export function markerPath(): string {
  return `${installDir()}/prod-suspended.json`;
}

export function prefsPath(): string {
  return `${installDir()}/dev-prefs.json`;
}

export function activeLink(): string {
  return `${installDir()}/cli.js`;
}
