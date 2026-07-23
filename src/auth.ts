import { randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  type ClaudeFlagValues,
  isPermissionMode,
  type PermissionMode,
  validateFlagValues,
} from "./claude-flags";
import { getLogger } from "./logger";

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

export function loadBrowserCors(): string | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/browser_cors:\s*(.+)/);
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

// Auto-kill grace period in ms. 0 disables the automatic hold-on-disconnect
// timer entirely (explicit hold_session still works); a positive value sets the
// delay; unset falls through to DEFAULT_PTY_GRACE_PERIOD_MS.
export function loadPtyGracePeriodMs(): number | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/pty_grace_period_ms:\s*(\d+)/);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

export function loadDefaultPermissionMode(): PermissionMode | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/default_permission_mode:\s*(\S+)/);
    const value = match?.[1]?.trim();
    if (isPermissionMode(value)) return value;
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

/**
 * Write (or delete) a single `key: value` line in server.yaml.
 *
 * server.yaml is a flat, regex-parsed file — no YAML library — so every value
 * must stay on ONE line. Passing `undefined` removes the key rather than
 * writing a bare `key:` that the readers would then match with an empty value.
 *
 * The write is atomic (tmp + rename) and 0600 because this file holds the API
 * key. Every setter in this module goes through here.
 */
function setConfigValue(key: string, value: string | undefined): void {
  const file = configFile();
  mkdirSync(configDir(), { recursive: true });

  let content = "";
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // file does not exist; we'll create it
  }

  const lineRe = new RegExp(`^${key}:\\s*.*$\\n?`, "m");
  let updated: string;
  if (value === undefined) {
    updated = content.replace(lineRe, "");
  } else {
    const line = `${key}: ${value}`;
    if (lineRe.test(content)) {
      updated = content.replace(lineRe, `${line}\n`);
    } else if (content.length === 0 || content.endsWith("\n")) {
      updated = `${content}${line}\n`;
    } else {
      updated = `${content}\n${line}\n`;
    }
  }

  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, updated, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmpFile, 0o600);
  renameSync(tmpFile, file);
}

// Persists the first-run prompt's answer so subsequent `serve` invocations
// don't ask again (loadDefaultPermissionMode() returning a value is the
// "already configured" signal cli/index.ts checks before prompting).
export function setDefaultPermissionMode(mode: PermissionMode): void {
  setConfigValue("default_permission_mode", mode);
}

/**
 * Allowlisted Claude CLI flags, stored as ONE line of JSON:
 *
 *     claude_flags: {"permissionMode":"bypassPermissions","addDir":["/srv/a b"]}
 *
 * JSON rather than a bespoke encoding because JSON.stringify already escapes
 * colons, quotes and spaces (killing the whole quoting-bug class) and emits no
 * raw newlines, so the one-line invariant holds by construction. It is also a
 * valid YAML flow mapping, so the file still parses if a real YAML reader is
 * ever pointed at it.
 *
 * A malformed line yields {} plus a warning rather than throwing: server.yaml is
 * hand-editable and a typo must never stop the server from booting.
 */
export function loadClaudeFlags(): ClaudeFlagValues {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/^claude_flags:\s*(.+)$/m);
    if (!match?.[1]) return {};
    return validateFlagValues(JSON.parse(match[1].trim()));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      getLogger("auth").warn(`Ignoring unreadable claude_flags in server.yaml: ${String(err)}`, {
        event: "config.claude_flags_parse_failed",
      });
    }
    return {};
  }
}

export function setClaudeFlags(values: ClaudeFlagValues): void {
  const safe = validateFlagValues(values);
  setConfigValue("claude_flags", Object.keys(safe).length === 0 ? undefined : JSON.stringify(safe));
}

/** Free-text argv appended after the allowlisted flags. Unvalidated by design. */
export function loadClaudeExtraArgs(): string | undefined {
  try {
    const content = readFileSync(configFile(), "utf-8");
    const match = content.match(/^claude_extra_args:\s*(.+)$/m);
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value : undefined;
  } catch {
    // File doesn't exist or not readable
  }
  return undefined;
}

/**
 * Throws on an embedded newline rather than silently sanitizing: a newline would
 * corrupt the flat one-line-per-key file, and the caller (the HTTP layer) should
 * surface that to the user as a validation error instead of quietly rewriting
 * what they typed.
 */
export function setClaudeExtraArgs(text: string | undefined): void {
  const trimmed = text?.trim();
  if (trimmed && /[\r\n]/.test(trimmed)) {
    throw new Error("claude_extra_args must not contain newlines");
  }
  setConfigValue("claude_extra_args", trimmed && trimmed.length > 0 ? trimmed : undefined);
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
