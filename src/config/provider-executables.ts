import { readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import type { ProviderName } from "../providers";

const CONFIG_KEYS: Record<ProviderName, string> = {
  "claude-code": "claude_executable",
  "codex-cli": "codex_executable",
  cursor: "cursor_executable",
};

export class ProviderExecutableError extends Error {
  readonly statusCode = 503;
  readonly code = "PROVIDER_EXECUTABLE_INVALID";

  constructor(provider: ProviderName, reason: string) {
    super(`Invalid ${CONFIG_KEYS[provider]} in server.yaml: ${reason}`);
  }
}

/** A single executable path, never a shell command or an argument list. */
export function loadProviderExecutable(provider: ProviderName): string | undefined {
  const file = join(
    process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase"),
    "server.yaml",
  );
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProviderExecutableError(provider, "could not read the configuration file.");
  }

  // Horizontal whitespace only: an empty value must not consume the next key.
  const match = content.match(new RegExp(`^${CONFIG_KEYS[provider]}:[ \\t]*(.*)$`, "m"));
  if (!match) return undefined;
  let value = match[1].trim();
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      throw new ProviderExecutableError(provider, "expected a quoted executable path.");
    }
  } else if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new ProviderExecutableError(provider, "expected a quoted executable path.");
    }
    value = value.slice(1, -1).replace(/''/g, "'");
  }
  if (!isAbsolute(value)) {
    throw new ProviderExecutableError(provider, "expected an absolute executable path.");
  }
  return value;
}
