import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";

/**
 * `~/.threadbase/external-control.json`, written by
 * `tb-streamer external-control setup`. The local half of the opt-in: the
 * `externalControl` feature flag must be on too. Independent of handoff.json,
 * because connecting to a desktop agent is a different consent from moving an
 * app session into tmux.
 */
export interface ExternalControlConfig {
  enabled: boolean;
  /** Absolute path resolved by setup from the user's shell PATH; a service PATH differs. */
  tmuxPath: string;
  /** Extra sockets (`tmux -S`/`-L` servers) the user registered. The default socket is implied. */
  sockets: string[];
}

export const EXTERNAL_CONTROL_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

export function externalControlConfigPath(): string {
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "external-control.json");
}

/** Read per request, like handoff.json, so re-running setup needs no restart. */
export function readExternalControlConfig(
  platform: NodeJS.Platform = process.platform,
): ExternalControlConfig | null {
  if (!EXTERNAL_CONTROL_PLATFORMS.includes(platform)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(externalControlConfigPath(), "utf8"));
  } catch {
    return null;
  }
  const c = raw as Partial<ExternalControlConfig> | null;
  if (c?.enabled !== true || typeof c.tmuxPath !== "string" || !isAbsolute(c.tmuxPath)) {
    return null;
  }
  if (!existsSync(c.tmuxPath)) return null;
  const sockets = Array.isArray(c.sockets)
    ? c.sockets.filter((s): s is string => typeof s === "string" && isAbsolute(s)).slice(0, 16)
    : [];
  return { enabled: true, tmuxPath: c.tmuxPath, sockets };
}

export function writeExternalControlConfig(config: ExternalControlConfig): void {
  const path = externalControlConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
