// src/agent/payload-guard.ts
//
// Per spec §5: enforce a 1.5 MB ceiling on UserInputSignal payloads (75% of
// Temporal's 2 MB hard limit) and emit trajectory WARN logs as a session
// approaches the wall.

import type { UserInputSignal } from "@threadbase-sh/agent-types";

export interface PayloadMeasurement {
  bytes: number;
  exceedsLimit: boolean;
}

/**
 * Serialize the signal and measure its byte size. Returns both the count and
 * whether it exceeds the supplied limit.
 *
 * Callers should refuse the input and return 413 SESSION_HISTORY_FULL when
 * `exceedsLimit` is true.
 */
export function measureSignalPayload(
  signal: UserInputSignal,
  limitBytes: number,
): PayloadMeasurement {
  const bytes = Buffer.byteLength(JSON.stringify(signal), "utf8");
  return { bytes, exceedsLimit: bytes > limitBytes };
}

export interface TrajectoryConfig {
  trajectoryLogBytes: number;
  trajectoryLogTurns: number;
}

/**
 * Trajectory log trigger. Fires when EITHER:
 * - The session has reached a turn count that's a multiple of 5, starting at
 *   `trajectoryLogTurns` (default 20), OR
 * - The composed signal is >= `trajectoryLogBytes` (default 500 KB) regardless
 *   of turn count.
 *
 * Returning true means the caller should emit a WARN log line with current
 * size + turn count + percentage-of-limit info.
 */
export function shouldLogTrajectory(
  turnCount: number,
  bytes: number,
  cfg: TrajectoryConfig,
): boolean {
  if (bytes >= cfg.trajectoryLogBytes) return true;
  if (turnCount < cfg.trajectoryLogTurns) return false;
  return (turnCount - cfg.trajectoryLogTurns) % 5 === 0;
}
