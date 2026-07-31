import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Machine boot identity — stable within one boot, different across boots.
 * See docs/plans/live-sessions-persistence-plan.md Phase 2.
 *
 * Stored alongside a session's pid so the boot reconciler can tell a pid it can
 * still probe from one that belongs to a previous boot, where the number has
 * since been handed to someone else's process.
 *
 * The token is only ever compared for **equality**, and a mismatch always means
 * "skip the probe, treat as resumable" — the harmless direction. So the uptime
 * fallback being imprecise (os.uptime() excludes suspend time on some
 * platforms) can only cost a spurious mismatch within one boot; it cannot
 * manufacture a spurious *match* across a reboot.
 */

let cached: string | undefined;

/** Computed once per process — this is machine state, not a live reading. */
export function currentBootToken(): string {
  if (cached === undefined) cached = computeBootToken();
  return cached;
}

function computeBootToken(): string {
  if (process.platform === "linux") {
    try {
      // Exact, and involves no clock at all.
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (bootId) return bootId;
    } catch {
      // Unreadable (container, hardened sysctl) — fall through to the estimate.
    }
  }
  // Approximate boot instant, bucketed to 10s to absorb clock drift.
  return String(Math.round((Date.now() - os.uptime() * 1000) / 10_000));
}
