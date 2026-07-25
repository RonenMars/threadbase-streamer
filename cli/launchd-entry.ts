import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
 * Default APNs auth-key filename, matching Apple's own download name.
 *
 * The key id is embedded in the filename by Apple, so this is the shape the file
 * already has when it comes out of the Developer portal or 1Password.
 */
const APNS_KEY_FILENAME = "AuthKey_BX4B6855WV.p8";

/**
 * Load the APNs signing key into the environment for the spawned server.
 *
 * launchd cannot read a file into an env var, and the plist is the wrong place
 * for the key itself: it is world-readable (0644) and `scripts/deploy.sh`
 * regenerates it on every deploy, so an embedded secret would be both exposed
 * and silently wiped. Reading it here keeps the key in a 0600 file under the
 * install dir, out of version control, and surviving deploys.
 *
 * An already-set APNS_KEY wins, so an operator can still override per-invocation.
 * A missing file is not an error — Live Activity push is optional, and the
 * server logs its own "disabled" line.
 */
export function loadApnsKeyIntoEnv(
  env: NodeJS.ProcessEnv,
  keyPath: string = join(installDir(), APNS_KEY_FILENAME),
): void {
  if (env.APNS_KEY) return;
  if (!existsSync(keyPath)) return;

  try {
    const pem = readFileSync(keyPath, "utf-8").trim();
    if (pem.length === 0) {
      // An empty file is a misconfiguration worth naming: it looks installed but
      // signing would fail with an opaque APNs error instead.
      log.warn(`APNs key file is empty, Live Activity push stays disabled: ${keyPath}`);
      return;
    }
    env.APNS_KEY = pem;
    // Path only, never the contents.
    log.info(`loaded APNs key for Live Activity push from ${keyPath}`);
  } catch (err) {
    // Never fatal: a push credential must not stop the server from starting.
    log.warn(
      `could not read APNs key at ${keyPath}, Live Activity push stays disabled: ${
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
  // launchd cannot read a file into an env var, so the key is loaded here rather
  // than declared in the plist (which is world-readable and regenerated on every
  // deploy).
  const env = { ...process.env };
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
