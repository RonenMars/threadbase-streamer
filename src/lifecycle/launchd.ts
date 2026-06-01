import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { installDir, LAUNCHD_LABEL } from "./constants";

function uidScope(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function fullTarget(): string {
  return `${uidScope()}/${LAUNCHD_LABEL}`;
}

export function isAgentLoaded(): boolean {
  try {
    execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "ignore" });
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
export function bootstrapAgent(plistPath: string): void {
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
    // Exit 5 with empty stderr (newer launchctl versions) → most often the
    // same "already loaded" case. If isAgentLoaded() confirms the service
    // is up, accept it; otherwise rethrow with whatever diagnostic we have.
    if (e.status === 5 && stderr === "" && isAgentLoaded()) return;
    if (stderr) (e as Error).message = `launchctl bootstrap failed: ${stderr}`;
    throw e;
  }
}

export function kickstartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", fullTarget()], { stdio: "ignore" });
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
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[2] === LAUNCHD_LABEL) {
        const pid = Number.parseInt(parts[0] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
