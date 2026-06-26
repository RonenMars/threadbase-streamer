import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { activeLink } from "../src/lifecycle/constants";
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
  const result = spawnSync(process.execPath, [target, ...args], {
    stdio: "inherit",
    env: process.env,
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
