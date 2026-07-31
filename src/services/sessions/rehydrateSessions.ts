import type { ManagedSessionRow } from "../../db/repositories/managed-sessions.repository";
import type { ManagedSession, StatusSource } from "../../types";

/**
 * Boot rehydration (persistence plan Phase 1, gaps G1/G2/G8).
 * See docs/plans/live-sessions-persistence-plan.md §4.
 *
 * `recordShutdownState()` stamps `completed_at` on every live session as the
 * streamer stops, which takes the row out of the reconciler's probe set. So a
 * *cleanly* restarted session is not classified as anything — it simply
 * disappears from `GET /api/sessions`, because `SessionStore` starts empty and
 * nothing ever seeds it from the registry.
 *
 * This module is the decision half of the fix: which rows come back, and what
 * they look like when they do. Pure functions with no database import, mirroring
 * how `classifySession` is split out of `reconcileSessions` — the decision table
 * is the part worth testing, and it should not need a SQLite file to do it.
 *
 * The stub these produce holds no PTY and never reaches `LiveSessionManager`;
 * it lives in `SessionStore` alone, so the idle reaper and the grace timer
 * (both of which iterate `ptyManager.listSessions()`) cannot see it.
 */

/** Most recovered sessions to seed in one boot. */
export const REHYDRATE_MAX = 25;

/** How far back a registry row may reach and still be offered as recoverable. */
export const REHYDRATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Registry `status_source` values meaning "the agent's own process ended it",
 * as opposed to `shutdown`, which means we did. Both vocabularies appear here:
 * the registry writes `exit`, the wire's StatusSource says `process-exit`.
 */
const AGENT_EXIT_SOURCES = new Set(["exit", "process-exit"]);

export interface ShouldRehydrateOptions {
  now: number;
  /** Whether the row's project directory still exists on disk. */
  projectExists: (projectPath: string) => boolean;
}

/**
 * Should this registry row come back as a recovered session?
 *
 * Three ways to answer no, all of them "resuming this would waste the user's
 * tap":
 *
 *  - the project directory is gone — `handleResume` would fail to spawn, and
 *    `classifyResumability` already encodes the same rule for conversations;
 *  - the row is older than the window — a week-old session belongs in the
 *    conversations list, not the live-session list;
 *  - the agent exited on its own without recording a failure — it finished, so
 *    there is nothing to recover. A row that recorded a `failureReason` is
 *    deliberately still offered: that one was cut short.
 */
export function shouldRehydrate(row: ManagedSessionRow, opts: ShouldRehydrateOptions): boolean {
  if (!opts.projectExists(row.project_path)) return false;
  if (opts.now - row.status_updated_at > REHYDRATE_WINDOW_MS) return false;
  if (AGENT_EXIT_SOURCES.has(row.status_source) && row.failure_reason == null) return false;
  return true;
}

/**
 * Registry row → an idle, non-attached `ManagedSession` stub.
 *
 * `status` is `idle` rather than anything new: a fresh `SessionStatus` value
 * would be rejected by `VALID_STATUSES` on `?status=` and dropped by
 * `SessionStore.paginate`'s filter, making recovered sessions *vanish* from
 * already-shipped mobile clients. The recovered-ness travels on `rehydrated`
 * instead, which `managedToResponse` turns into the existing
 * `ownership: "historical"` / `lifecycle: "resumable"` pair.
 */
export function rowToStubSession(row: ManagedSessionRow): ManagedSession {
  return {
    id: row.session_id,
    provider: row.provider as ManagedSession["provider"],
    projectPath: row.project_path,
    projectName: row.project_name,
    branch: row.branch,
    // No PTY exists for a stub, so this is the only truthful status.
    status: "idle",
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at != null ? new Date(row.completed_at) : null,
    promptCount: row.prompt_count,
    lastOutput: "",
    rehydrated: true,
    ...(row.session_name != null && { sessionName: row.session_name }),
    ...(row.project_id != null && { projectId: row.project_id }),
    ...(row.bound_conversation_id != null && { boundConversationId: row.bound_conversation_id }),
    ...(row.resumed_from_conversation_id != null && {
      resumedFromConversationId: row.resumed_from_conversation_id,
    }),
    ...(row.failure_reason != null && { failureReason: row.failure_reason }),
    ...(row.last_activity_at != null && { lastActivityAt: new Date(row.last_activity_at) }),
    // Only `shutdown` crosses over. It is the one registry source that is also a
    // wire StatusSource *and* that genuinely describes the `idle` above — the
    // streamer stopped this session. A crashed row still says `transition` over
    // a `running` status, and copying that here would attach observed-confidence
    // provenance to a status we derived at boot, so leave it unset instead.
    ...(row.status_source === "shutdown" && {
      statusSource: "shutdown" satisfies StatusSource,
      statusUpdatedAt: new Date(row.status_updated_at),
    }),
  };
}
