export const INSTALL_DIR = process.env.THREADBASE_INSTALL_DIR ?? `${process.env.HOME}/.threadbase`;
export const MARKER_PATH = `${INSTALL_DIR}/prod-suspended.json`;
export const PREFS_PATH = `${INSTALL_DIR}/dev-prefs.json`;
export const ACTIVE_LINK = `${INSTALL_DIR}/cli.js`;
export const LAUNCHD_LABEL = "com.ronen.threadbase";
export const DEFAULT_PROD_PORT = 8766;
