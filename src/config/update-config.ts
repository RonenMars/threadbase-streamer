import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type UpdateConfig, UpdateConfigSchema } from "../schemas/updateConfig.schema";

const DEFAULT_CONFIG_PATH = join(homedir(), ".threadbase", "update.yaml");

export interface LoadUpdateConfigOptions {
  path?: string;
}

/**
 * Loads ~/.threadbase/update.yaml. Returns null when the file does not exist
 * (auto-update disabled). Throws on malformed YAML or schema-invalid content
 * so misconfiguration is loud rather than silently disabling updates.
 */
export function loadUpdateConfig(opts: LoadUpdateConfigOptions = {}): UpdateConfig | null {
  const path = opts.path ?? DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) {
    throw new Error(`update.yaml at ${path} is empty — github_repo is required`);
  }

  return UpdateConfigSchema.parse(parsed);
}

export { DEFAULT_CONFIG_PATH as UPDATE_CONFIG_PATH };
