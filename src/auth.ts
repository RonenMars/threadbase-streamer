import { randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Resolved per call (not frozen at module load) so tests can redirect writes
// away from the real config via THREADBASE_CONFIG_DIR. Without this, importing
// this module freezes the path to the real home before any test can sandbox it,
// and a rotate/set-key test would clobber the live ~/.threadbase/server.yaml.
function configDir(): string {
  return process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
}
function configFile(): string {
  return join(configDir(), "server.yaml");
}

export function generateApiKey(): string {
  return `tb_${randomBytes(16).toString("hex")}`;
}

export function validateApiKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function loadOrCreateApiKey(): string {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/api_key:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist, create one
  }

  const key = generateApiKey();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), `api_key: ${key}\n`, "utf-8");
  return key;
}

export function loadBrowseRoot(): string | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/browse_root:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export function loadPublicUrl(): string | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/public_url:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export function loadCacheDir(): string | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/cache_dir:\s*(.+)/);
    if (match?.[1]) return match[1].trim();
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export function loadTailSize(): number | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/tail_size:\s*(\d+)/);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export type PublicUrlValidation = { ok: true; normalized: string } | { ok: false; error: string };

export function validatePublicUrl(raw: string): PublicUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (parsed.protocol === "https:") {
    return { ok: true, normalized: stripTrailingSlash(parsed.toString()) };
  }
  if (parsed.protocol === "http:" && localHosts.has(parsed.hostname)) {
    return { ok: true, normalized: stripTrailingSlash(parsed.toString()) };
  }
  return {
    ok: false,
    error: `publicUrl must be https:// (got ${parsed.protocol}//). Plain http is only allowed for localhost.`,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function setApiKey(key: string): void {
  const file = configFile();
  mkdirSync(configDir(), { recursive: true });

  let content = "";
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // file does not exist; we'll create it
  }

  const apiKeyLine = `api_key: ${key}`;
  let updated: string;
  if (/^api_key:\s*.+$/m.test(content)) {
    updated = content.replace(/^api_key:\s*.+$/m, apiKeyLine);
  } else if (content.length === 0 || content.endsWith("\n")) {
    updated = `${content}${apiKeyLine}\n`;
  } else {
    updated = `${content}\n${apiKeyLine}\n`;
  }

  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmpFile, 0o600);
  renameSync(tmpFile, file);
}
