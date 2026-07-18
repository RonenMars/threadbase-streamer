import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { installDir, LAUNCHD_LABEL } from "./constants";

// launchd label Homebrew registers for `brew services start tb-streamer`,
// distinct from the deploy.sh LAUNCHD_LABEL. A brew prod install must be
// detected at runtime so the prod/dev coordination targets the live service.
const BREW_LAUNCHD_LABEL = "homebrew.mxcl.tb-streamer";

function uidScope(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

// Resolves which launchd label the prod/dev machinery should operate on:
// LAUNCHD_LABEL env override → the brew label if its service is loaded →
// the deploy.sh default. The brew probe runs only when no env override pins a
// label, so a deploy.sh install never pays for it. Mirrors the async
// resolveDarwinLabel in src/updater/restart.ts (this side is sync because the
// lifecycle wrappers use execFileSync).
function resolveLoadedLabel(): string {
  if (process.env.LAUNCHD_LABEL) return process.env.LAUNCHD_LABEL;
  try {
    execFileSync("launchctl", ["print", `${uidScope()}/${BREW_LAUNCHD_LABEL}`], {
      stdio: "ignore",
    });
    return BREW_LAUNCHD_LABEL;
  } catch {
    return LAUNCHD_LABEL;
  }
}

function fullTarget(): string {
  return `${uidScope()}/${resolveLoadedLabel()}`;
}

export function isAgentLoaded(): boolean {
  try {
    execFileSync("launchctl", ["list", resolveLoadedLabel()], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Bootout is async on macOS: launchctl returns immediately but the launchd
// domain may still be tearing down the service when the command exits.
// Poll up to `timeoutMs` for isAgentLoaded() to flip false so callers can
// safely bootstrap a fresh copy without hitting the "service already exists"
// race that returns exit 5 from `launchctl bootstrap`.
export function bootoutAgent(timeoutMs = 2000): void {
  try {
    execFileSync("launchctl", ["bootout", fullTarget()], { stdio: "ignore" });
  } catch {
    // already unloaded — fine
  }
  const deadline = Date.now() + timeoutMs;
  while (isAgentLoaded() && Date.now() < deadline) {
    // Busy-wait in 50 ms ticks. Sleeping via spawnSync('sleep', …) is
    // expensive; Atomics.wait would need a SharedArrayBuffer. A tight
    // loop with a syscall per iteration matches what launchctl does
    // internally and is bounded by the deadline.
    const wake = Date.now() + 50;
    while (Date.now() < wake) {
      /* spin */
    }
  }
}

// Bootstrap is idempotent in intent — re-running it when the service is
// already loaded should be a no-op, but launchctl returns exit 5
// ("Input/output error") instead of 0. Catch that specific case so callers
// like `prod restart` can race-recover gracefully. Other failures (bad
// plist, permission denied, etc.) still throw with stderr attached.
//
// The `afterBootout` flag controls tolerance for exit 5 + empty stderr:
// callers that just ran bootoutAgent() pass `true` — the "already loaded"
// race is benign there. Callers bootstrapping cold (no prior bootout) should
// leave it false/absent so a stale agent isn't silently treated as success.
export function bootstrapAgent(plistPath: string, opts?: { afterBootout?: boolean }): void {
  try {
    execFileSync("launchctl", ["bootstrap", uidScope(), plistPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: Buffer | string;
    };
    const stderr = (e.stderr?.toString?.() ?? "").trim();
    // Exit 5 + "already" in stderr → service is already loaded with the
    // intended plist. Treat as success; the goal state matches the actual.
    if (e.status === 5 && /already|loaded|in progress/i.test(stderr)) return;
    // Exit 5 with empty stderr (newer launchctl versions) → only accept when
    // the caller just ran bootoutAgent and the loaded state is from a race.
    // Without the flag, exit 5 + empty stderr could hide a real failure when
    // a stale agent is still loaded.
    if (e.status === 5 && stderr === "" && opts?.afterBootout && isAgentLoaded()) return;
    if (stderr) (e as Error).message = `launchctl bootstrap failed: ${stderr}`;
    throw e;
  }
}

export function kickstartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", fullTarget()], { stdio: "ignore" });
}

/**
 * Absolute path to the LaunchAgents plist for the currently-loaded service
 * (brew or deploy.sh). `prod restart` re-bootstraps from this path, so it must
 * resolve the label BEFORE booting the agent out — once unloaded, the probe
 * would no longer detect a brew service.
 */
export function darwinPlistPath(): string {
  return `${process.env.HOME}/Library/LaunchAgents/${resolveLoadedLabel()}.plist`;
}

/**
 * Returns the absolute paths to the streamer's stdout/stderr log files. These
 * match the StandardOutPath / StandardErrorPath written by `scripts/deploy.sh`
 * into the launchd plist: `$INSTALL_DIR/logs/{stdout,stderr}.log`.
 */
export function getLogPaths(): { stdout: string; stderr: string } {
  const dir = join(installDir(), "logs");
  return { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
}

/** Returns the current PID of the supervised agent, or null. */
export function getAgentPid(): number | null {
  try {
    const out = execFileSync("launchctl", ["list"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const label = resolveLoadedLabel();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[2] === label) {
        const pid = Number.parseInt(parts[0] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
