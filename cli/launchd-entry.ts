import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { activeLink, installDir } from "../src/lifecycle/constants";
import { clearMarker, readMarker } from "../src/lifecycle/marker";
import { isPidAlive } from "../src/lifecycle/process-liveness";
import { getLogger } from "../src/logger";

// In the tsup CJS bundle, `require` is the CommonJS runtime function. TS is
// configured with `module: ESNext`, so we declare it here for the type-checker.
declare const require: NodeJS.Require;

const log = getLogger("launchd-entry");

export type ShimAction =
  | { kind: "exec"; reason?: "crash-recovery" }
  | { kind: "exit"; reason: "user-held" | "dev-alive" | "platform-mismatch" };

/**
 * Pure decision (plus marker-clear side effect on crash recovery so the
 * caller doesn't have to). Exported for tests.
 */
export function decideShimAction(): ShimAction {
  if (process.platform !== "darwin") {
    return { kind: "exit", reason: "platform-mismatch" };
  }

  const marker = readMarker();
  if (!marker) return { kind: "exec" };

  // Check liveness first — a dead dev PID means the marker is stale regardless
  // of userHeld (e.g. dev streamer killed without --forget, or deploy after crash).
  if (!isPidAlive(marker.devPid)) {
    clearMarker();
    return { kind: "exec", reason: "crash-recovery" };
  }

  if (marker.userHeld) {
    return { kind: "exit", reason: "user-held" };
  }

  return { kind: "exit", reason: "dev-alive" };
}

/**
 * Load `<installDir>/.env` into the environment for the spawned server.
 *
 * `cli/index.ts` already imports `dotenv/config`, but that reads `.env` from the
 * process cwd — which is the repo root for a hand-run `serve`, and `/` under
 * launchd. So a supervised instance would never see it. Reading from the install
 * dir instead gives prod a config file it can actually find, and one that
 * survives a deploy (unlike the plist, which is regenerated every time).
 *
 * Deliberately minimal rather than a dotenv call: this runs before the bundle's
 * dependencies are relevant, and the format needed here is `KEY=value` lines.
 * Existing environment entries always win, so an explicit export still overrides
 * the file.
 */
export function loadInstallDirEnv(env: NodeJS.ProcessEnv, dir: string = installDir()): void {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return;

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch (err) {
    log.warn(`could not read ${envPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const loaded: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so a value containing '#' or spaces
    // can be quoted the way a shell would expect.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    // An already-set variable wins: an explicit export must override the file.
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }

  if (loaded.length > 0) {
    // Names only. A .env may hold secrets, so values are never logged.
    log.info(`loaded ${loaded.length} env var(s) from ${envPath}: ${loaded.join(", ")}`);
  }
}

/**
 * Apple's own download filename for an APNs auth key: `AuthKey_<keyId>.p8`.
 *
 * The key id is embedded in the name, which is what lets a rotation be a
 * drop-in: discovering the file yields both the key and its id, so the two can
 * never disagree.
 */
const APNS_KEY_FILE_PATTERN = /^AuthKey_([A-Z0-9]{10})\.p8$/;

/**
 * Find the APNs auth key in the install dir.
 *
 * Globbed rather than hardcoded to a single filename: rotating the key means
 * dropping in `AuthKey_<newId>.p8`, and a hardcoded name would leave prod
 * silently unable to find it. Returns null when no key is installed, which is
 * the ordinary state.
 *
 * With several keys present the newest by mtime wins, on the assumption that a
 * freshly rotated key is the intended one — and the ambiguity is logged, because
 * silently picking one of two credentials is exactly the sort of thing that
 * wastes an afternoon.
 */
export function findApnsKeyFile(
  dir: string = installDir(),
): { path: string; keyId: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No install dir yet (fresh machine) is not an error worth logging.
    return null;
  }

  const matches = entries
    .map((name) => ({ name, m: APNS_KEY_FILE_PATTERN.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .map((e) => {
      const path = join(dir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // Unreadable stat leaves it last rather than dropping it — the read
        // below reports the real problem with a clearer message.
      }
      return { path, keyId: e.m[1], mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    log.warn(
      `found ${matches.length} APNs key files in ${dir}, using the newest ` +
        `(${matches[0].keyId}); remove the stale ones to make this unambiguous`,
    );
  }
  return { path: matches[0].path, keyId: matches[0].keyId };
}

/**
 * Load the APNs signing key into the environment for the spawned server.
 *
 * launchd cannot read a file into an env var, and the plist is the wrong place
 * for the key itself: it is world-readable (0644) and `scripts/deploy.sh`
 * regenerates it on every deploy, so an embedded secret would be both exposed
 * and silently wiped. Reading it here keeps the key in a 0600 file under the
 * install dir, out of version control, and surviving deploys.
 *
 * The key id is derived from the filename and exported alongside the key, so a
 * rotation cannot leave the JWT claiming an id that does not match the key it
 * signed with — APNs rejects that with a bare `InvalidProviderToken` that says
 * nothing about the cause.
 *
 * An already-set APNS_KEY wins, so an operator can still override per-invocation.
 * A missing file is not an error — Live Activity push is optional, and the
 * server logs its own "disabled" line.
 */
export function loadApnsKeyIntoEnv(env: NodeJS.ProcessEnv, keyFileDir?: string): void {
  if (env.APNS_KEY) return;

  const found = findApnsKeyFile(keyFileDir);
  if (!found) return;

  try {
    const pem = readFileSync(found.path, "utf-8").trim();
    if (pem.length === 0) {
      // An empty file is a misconfiguration worth naming: it looks installed but
      // signing would fail with an opaque APNs error instead.
      log.warn(`APNs key file is empty, Live Activity push stays disabled: ${found.path}`);
      return;
    }
    env.APNS_KEY = pem;
    // An explicit APNS_KEY_ID still wins; otherwise the filename is the source
    // of truth, which keeps key and id in lockstep across a rotation.
    if (!env.APNS_KEY_ID) env.APNS_KEY_ID = found.keyId;
    // Path and key id only — both non-secret. Never the contents.
    log.info(`loaded APNs key ${found.keyId} for Live Activity push from ${found.path}`);
  } catch (err) {
    // Never fatal: a push credential must not stop the server from starting.
    log.warn(
      `could not read APNs key at ${found.path}, Live Activity push stays disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function main(): void {
  const action = decideShimAction();
  if (action.kind === "exit") {
    if (action.reason === "platform-mismatch") {
      log.warn(
        `shim should only run on macOS (current platform: ${process.platform}). ` +
          `On Windows, Task Scheduler runs cli.js directly. Exiting.`,
      );
    } else {
      log.info(`shim exiting (${action.reason}); launchd will not respawn (SuccessfulExit=false)`);
    }
    process.exit(0);
  }

  if (action.reason === "crash-recovery") {
    log.info("dev crash detected — auto-restoring prod streamer");
  }

  const target = activeLink();
  if (!existsSync(target)) {
    log.error(`active link missing: ${target}`);
    process.exit(1);
  }

  // Forward all argv (launchd passes "serve --port 8766 --verbose" or whatever
  // the plist declares) straight to the real binary.
  const args = process.argv.slice(2);
  // launchd cannot read a file into an env var, so config is loaded here rather
  // than declared in the plist (which is world-readable and regenerated on every
  // deploy). `.env` first, so a key or identifier declared there is in place
  // before the key-file lookup decides what is still missing.
  const env = { ...process.env };
  loadInstallDirEnv(env);
  loadApnsKeyIntoEnv(env);
  const result = spawnSync(process.execPath, [target, ...args], {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    log.error(`failed to spawn ${target}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Run main() only when invoked as a script, not when imported by tests.
if (typeof require !== "undefined" && require.main === module) {
  main();
}
