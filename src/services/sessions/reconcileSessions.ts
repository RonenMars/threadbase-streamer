import type {
  ManagedSessionRow,
  SessionLifecycle,
} from "../../db/repositories/managed-sessions.repository";

/**
 * Boot reconciliation (C1 Phase 3a).
 * See docs/architecture/2026-07-24-durable-session-runtime.md.
 *
 * On startup the registry holds rows from previous runs. Some of those
 * processes are gone; some are still alive (the crash and dev-takeover paths
 * exit without reaching ptyManager.dispose(), so agents genuinely outlive the
 * streamer today — they are simply invisible when they do). This module decides
 * which is which.
 *
 * Two rules make it safe:
 *
 *  1. **A stored status is never trusted over a live probe.** A SIGKILLed
 *     streamer never ran its exit writes, so a row can claim `running`
 *     indefinitely. Only the pid probe decides liveness.
 *
 *  2. **Liveness is never treated as identity.** Pids are recycled. A live pid
 *     whose command line does not carry the recorded token is reported
 *     `orphaned` and never signalled — that is the difference between a
 *     durability feature and one that kills an unrelated user process.
 */

/** Result for a single registry row. Pure data — nothing here acts. */
export interface ReconcileVerdict {
  sessionId: string;
  lifecycle: SessionLifecycle;
  /** Why this verdict was reached, for logs and the diagnostics surface. */
  reason: string;
}

export interface ReconcileProbe {
  /** Whether a process currently exists at this pid. */
  isPidAlive: (pid: number) => boolean;
  /** Full command line for a live pid, or "" when it cannot be read. */
  getProcessArgs: (pid: number) => Promise<string>;
  /**
   * Whether the provider's own history shows this session ended cleanly.
   * Distinguishes `completed` from `failed` for a process that is gone.
   */
  endedCleanly?: (row: ManagedSessionRow) => boolean;
}

/**
 * Classify one registry row against live process state.
 *
 * Exported separately from reconcileSessions so the decision table can be
 * tested without a database.
 */
export async function classifySession(
  row: ManagedSessionRow,
  probe: ReconcileProbe,
  currentInstanceId: string,
): Promise<ReconcileVerdict> {
  const { session_id: sessionId } = row;

  // A row this run created and completed needs no probe.
  if (row.completed_at != null) {
    const clean = probe.endedCleanly?.(row) ?? row.failure_reason == null;
    return {
      sessionId,
      lifecycle: clean ? "completed" : "failed",
      reason: `terminal (${row.status_source})`,
    };
  }

  // No pid recorded — the spawn write raced the process, or the row predates
  // pid capture. Nothing to probe, so fall back to whether the provider can
  // resume it.
  if (row.pid == null) {
    return { sessionId, lifecycle: "resumable", reason: "no pid recorded" };
  }

  if (!probe.isPidAlive(row.pid)) {
    // The process is gone and nothing recorded why. This is the SIGKILL case:
    // the row can still say `running` because no exit write ever ran.
    const clean = probe.endedCleanly?.(row) ?? false;
    if (clean) {
      return { sessionId, lifecycle: "completed", reason: "process gone, history ended cleanly" };
    }
    return {
      sessionId,
      lifecycle: "resumable",
      reason: "process gone, resumable from provider history",
    };
  }

  // Something is alive at that pid. Identity must be confirmed before we claim
  // it: an unreadable or non-matching command line means "cannot confirm",
  // never "confirmed".
  const args = await probe.getProcessArgs(row.pid);
  const token = row.cmdline;
  if (!token || !args?.includes(token)) {
    return {
      sessionId,
      lifecycle: "orphaned",
      reason: args ? "pid alive but command line does not match" : "pid alive but argv unreadable",
    };
  }

  // Alive and ours. `detached` rather than `attached`: the process survived,
  // but its PTY master fd died with the streamer that spawned it, so this run
  // cannot stream its bytes — only observe it through provider history and
  // offer an explicit resume.
  const sameRun = row.streamer_instance_id === currentInstanceId;
  return {
    sessionId,
    lifecycle: sameRun ? "attached" : "detached",
    reason: sameRun ? "owned by this run" : "survived a previous streamer run",
  };
}

/**
 * Classify every non-terminal row. Returns verdicts only — the caller decides
 * what to persist or broadcast. This function never signals a process.
 */
export async function reconcileSessions(
  rows: ManagedSessionRow[],
  probe: ReconcileProbe,
  currentInstanceId: string,
): Promise<ReconcileVerdict[]> {
  return Promise.all(rows.map((row) => classifySession(row, probe, currentInstanceId)));
}
