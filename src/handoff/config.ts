import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** `~/.threadbase/handoff.json`, written by `tb-streamer handoff setup`. */
export interface HandoffConfig {
  enabled: boolean;
  /** Absolute path resolved by setup from the user's shell PATH; launchd's PATH differs. */
  tmuxPath: string;
}

// Resolved per call like server-identity.ts, so tests redirect it with THREADBASE_CONFIG_DIR.
export function handoffConfigPath(): string {
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "handoff.json");
}

/**
 * The usable handoff config, or null when handoff is off. Read per request so
 * re-running setup applies without a restart. /api/info, setup and the
 * endpoint all ask this one function, so they cannot disagree.
 *
 * macOS only for now: under systemd a tmux server the streamer starts lives in
 * the service's cgroup and dies with the next service restart.
 */
export function readHandoffConfig(
  platform: NodeJS.Platform = process.platform,
): HandoffConfig | null {
  if (platform !== "darwin") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(handoffConfigPath(), "utf8"));
  } catch {
    return null;
  }
  const c = raw as Partial<HandoffConfig> | null;
  if (c?.enabled !== true || typeof c.tmuxPath !== "string" || !existsSync(c.tmuxPath)) {
    return null;
  }
  return { enabled: true, tmuxPath: c.tmuxPath };
}

export function writeHandoffConfig(config: HandoffConfig): void {
  const path = handoffConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
