/**
 * Live Activity lifecycle counts since this server process started (#509).
 *
 * Reported on `GET /api/push/health` as `liveActivityMetrics`. In memory on
 * purpose: they answer "is anything happening right now?", and every event is
 * also a structured log line (`live_activity.started`, `.renewed`, `.ended`,
 * `.retired`) for anything older than the last restart.
 *
 * `started`, `renewed` and `ended` count session events that reached at least
 * one device token, not devices. `retired` counts tokens APNs rejected as
 * permanently dead.
 */

type Counts = { started: number; renewed: number; ended: number; retired: number };

export interface LiveActivityMetrics extends Counts {
  /** Epoch ms the counts began (process start, or the last reset). */
  since: number;
}

let since = Date.now();
const counts: Counts = { started: 0, renewed: 0, ended: 0, retired: 0 };

export function countLiveActivity(kind: keyof Counts, n = 1): void {
  counts[kind] += n;
}

export function liveActivityMetricsSnapshot(): LiveActivityMetrics {
  return { ...counts, since };
}

/** For tests: the counters are process-wide. */
export function resetLiveActivityMetrics(): void {
  counts.started = counts.renewed = counts.ended = counts.retired = 0;
  since = Date.now();
}
