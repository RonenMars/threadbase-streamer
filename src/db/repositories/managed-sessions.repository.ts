import type Database from "better-sqlite3";
import type { ManagedSession, SessionStatus } from "../../types";
import { currentBootToken } from "../../utils/bootToken";

/**
 * Durable registry of managed sessions (C1 Phase 2).
 * See docs/architecture/2026-07-24-durable-session-runtime.md.
 *
 * Distinct from SessionsRepository, which wraps the in-memory SessionStore for
 * the live request path. This one exists so session identity and provenance
 * outlive the streamer process: without it, a restart loses startedAt,
 * promptCount, sessionName, the Codex rollout binding, and failureReason, and
 * the boot reconciler has nothing to reconcile against.
 *
 * Deliberately not stored here: the PTY output ring buffer and xterm screen.
 * Their authoritative copy is the provider's JSONL, and writing 64KiB of ANSI
 * on every chunk to duplicate it would be a write storm for no gain.
 */

/** How a persisted status was obtained — never inferred, always recorded. */
export type StatusSource = "spawn" | "transition" | "exit" | "shutdown" | "probe" | "reconcile";

// Canonical definition lives in types.ts — it is a wire type on
// SessionResponse, not a persistence detail. Re-exported here so reconciler and
// repository consumers can keep importing it from one place.
export type { SessionLifecycle } from "../../types";

export interface ManagedSessionRow {
  session_id: string;
  provider: string;
  pid: number | null;
  cmdline: string | null;
  project_path: string;
  project_name: string;
  branch: string;
  status: string;
  status_source: string;
  status_updated_at: number;
  started_at: number;
  completed_at: number | null;
  last_activity_at: number | null;
  prompt_count: number;
  session_name: string | null;
  project_id: string | null;
  bound_conversation_id: string | null;
  resumed_from_conversation_id: string | null;
  failure_reason: string | null;
  streamer_instance_id: string;
  /**
   * Which machine boot `pid` was recorded during (migration 002). Optional
   * because rows written before it exists read back as null/absent, which the
   * reconciler treats exactly like a mismatch — never like a match.
   */
  boot_token?: string | null;
}

/** Most rows the boot reconciler will probe in one pass. */
export const PROBE_SET_MAX = 200;

/** How long a finished session stays in the registry as history. */
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RecordSpawnInput {
  session: ManagedSession;
  pid: number | null;
  cmdline: string | null;
  streamerInstanceId: string;
}

export class ManagedSessionsRepository {
  private upsertStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private bindStmt: Database.Statement;
  private getStmt: Database.Statement;
  private listNonTerminalStmt: Database.Statement;
  private pruneTerminalStmt: Database.Statement;
  private listRecoverableStmt: Database.Statement;
  private deleteStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO managed_sessions (
        session_id, provider, pid, cmdline, project_path, project_name, branch,
        status, status_source, status_updated_at, started_at, completed_at,
        last_activity_at, prompt_count, session_name, project_id,
        bound_conversation_id, resumed_from_conversation_id, failure_reason,
        streamer_instance_id, boot_token
      ) VALUES (
        @session_id, @provider, @pid, @cmdline, @project_path, @project_name, @branch,
        @status, @status_source, @status_updated_at, @started_at, @completed_at,
        @last_activity_at, @prompt_count, @session_name, @project_id,
        @bound_conversation_id, @resumed_from_conversation_id, @failure_reason,
        @streamer_instance_id, @boot_token
      )
      ON CONFLICT(session_id) DO UPDATE SET
        pid = excluded.pid,
        cmdline = excluded.cmdline,
        project_path = excluded.project_path,
        project_name = excluded.project_name,
        branch = excluded.branch,
        status = excluded.status,
        status_source = excluded.status_source,
        status_updated_at = excluded.status_updated_at,
        completed_at = excluded.completed_at,
        last_activity_at = excluded.last_activity_at,
        prompt_count = excluded.prompt_count,
        session_name = excluded.session_name,
        project_id = excluded.project_id,
        bound_conversation_id = excluded.bound_conversation_id,
        resumed_from_conversation_id = excluded.resumed_from_conversation_id,
        failure_reason = excluded.failure_reason,
        streamer_instance_id = excluded.streamer_instance_id,
        boot_token = excluded.boot_token
    `);

    // Narrow status-only write for the hot transition path, so a
    // running↔waiting_input flip doesn't rewrite every column.
    //
    // session_name rides along under COALESCE, like failure_reason: it is
    // derived from the session's FIRST user message, which is strictly after
    // recordSpawn — the only other writer of the column — so without a second
    // write path the registry could never hold a name at all, and every
    // recovered session came back unnamed.
    this.updateStatusStmt = db.prepare(`
      UPDATE managed_sessions
         SET status = @status,
             status_source = @status_source,
             status_updated_at = @status_updated_at,
             completed_at = @completed_at,
             last_activity_at = @last_activity_at,
             prompt_count = @prompt_count,
             failure_reason = COALESCE(@failure_reason, failure_reason),
             session_name = COALESCE(@session_name, session_name)
       WHERE session_id = @session_id
    `);

    this.bindStmt = db.prepare(`
      UPDATE managed_sessions
         SET bound_conversation_id = @bound_conversation_id
       WHERE session_id = @session_id
    `);

    this.getStmt = db.prepare("SELECT * FROM managed_sessions WHERE session_id = ?");

    // The reconciler's boot read. Terminal rows are kept as history but never
    // re-probed — there is nothing left to discover about them.
    //
    // Bounded because every row costs a pid probe, and on Windows a probe is a
    // CIM query measured in seconds: an unbounded set turns a registry that
    // accumulated badly into a multi-minute boot. Oldest first, so the rows
    // most likely to be genuinely stale are the ones examined.
    this.listNonTerminalStmt = db.prepare(`
      SELECT * FROM managed_sessions
       WHERE completed_at IS NULL
       ORDER BY started_at ASC
       LIMIT @limit
    `);

    this.pruneTerminalStmt = db.prepare(`
      DELETE FROM managed_sessions
       WHERE completed_at IS NOT NULL
         AND completed_at < @before
    `);

    // The rehydrator's boot read. Deliberately WIDER than listNonTerminal:
    // `recordShutdownState` stamps completed_at on every live session as the
    // streamer stops, so the sessions most worth recovering are exactly the ones
    // the probe set excludes. `status_source = 'shutdown'` is what distinguishes
    // "we stopped it" from "the agent finished" — written since C1 Phase 2, read
    // by nothing until now.
    this.listRecoverableStmt = db.prepare(`
      SELECT * FROM managed_sessions
       WHERE (completed_at IS NULL OR status_source = 'shutdown')
         AND status_updated_at >= @since
       ORDER BY status_updated_at DESC
       LIMIT @limit
    `);

    this.deleteStmt = db.prepare("DELETE FROM managed_sessions WHERE session_id = ?");
  }

  /** Record a session at spawn, or refresh every field of an existing row. */
  recordSpawn({ session, pid, cmdline, streamerInstanceId }: RecordSpawnInput): void {
    this.upsertStmt.run({
      session_id: session.id,
      provider: session.provider ?? "claude-code",
      pid,
      cmdline,
      project_path: session.projectPath,
      project_name: session.projectName,
      branch: session.branch ?? "",
      status: session.status,
      status_source: "spawn" satisfies StatusSource,
      status_updated_at: Date.now(),
      started_at: session.startedAt.getTime(),
      completed_at: session.completedAt?.getTime() ?? null,
      last_activity_at: session.lastActivityAt?.getTime() ?? null,
      prompt_count: session.promptCount,
      session_name: session.sessionName ?? null,
      project_id: session.projectId ?? null,
      bound_conversation_id: session.boundConversationId ?? null,
      resumed_from_conversation_id: session.resumedFromConversationId ?? null,
      failure_reason: session.failureReason ?? null,
      streamer_instance_id: streamerInstanceId,
      // Recorded, never backfilled: the pid above is only probeable while this
      // token still matches the running machine.
      boot_token: currentBootToken(),
    });
  }

  /**
   * Persist a status transition. `source` is required rather than defaulted:
   * a status whose provenance is unknown is the thing this table exists to
   * prevent, and the reconciler reads it to decide how much to trust the value.
   */
  recordStatus(
    sessionId: string,
    status: SessionStatus,
    source: StatusSource,
    fields: {
      completedAt?: Date | null;
      lastActivityAt?: Date | null;
      promptCount?: number;
      failureReason?: string | null;
      /** Null/omitted keeps whatever is stored — it never clears a known name. */
      sessionName?: string | null;
    } = {},
  ): void {
    this.updateStatusStmt.run({
      session_id: sessionId,
      status,
      status_source: source,
      status_updated_at: Date.now(),
      completed_at: fields.completedAt?.getTime() ?? null,
      last_activity_at: fields.lastActivityAt?.getTime() ?? null,
      prompt_count: fields.promptCount ?? 0,
      failure_reason: fields.failureReason ?? null,
      session_name: fields.sessionName ?? null,
    });
  }

  /**
   * Persist the Codex rollout id discovered after spawn.
   *
   * Its own statement rather than a `recordSpawn` re-run: the binding arrives
   * while the session is live, and re-upserting would also rewrite `cmdline`
   * with an id that is *not* in a fresh Codex process's argv, turning the
   * reconciler's identity check into a false `orphaned`. Without this write the
   * binding lives only in memory and dies with the streamer — which is the
   * whole reason a restarted Codex session could not be resumed (G6).
   */
  recordBinding(sessionId: string, boundConversationId: string): void {
    this.bindStmt.run({
      session_id: sessionId,
      bound_conversation_id: boundConversationId,
    });
  }

  get(sessionId: string): ManagedSessionRow | null {
    return (this.getStmt.get(sessionId) as ManagedSessionRow | undefined) ?? null;
  }

  /**
   * Rows with no recorded completion — the reconciler's probe set.
   *
   * Capped. Callers must compare the result length against the limit and say so
   * when it clips: a silently truncated probe set reads as "we checked
   * everything" when it did not.
   */
  listNonTerminal(limit: number = PROBE_SET_MAX): ManagedSessionRow[] {
    return this.listNonTerminalStmt.all({ limit }) as ManagedSessionRow[];
  }

  /**
   * Delete terminal rows older than `olderThanMs`, returning how many went.
   *
   * Only rows carrying a `completed_at` are eligible, so nothing the reconciler
   * or rehydrator might still want is reachable from here — a row without one
   * is by definition unfinished business, however old it looks.
   */
  pruneTerminal(olderThanMs: number = TERMINAL_RETENTION_MS): number {
    return this.pruneTerminalStmt.run({ before: Date.now() - olderThanMs }).changes;
  }

  /**
   * Rows a restart could bring back: still open, or closed by our own shutdown,
   * and touched no longer ago than `sinceMs`. Newest first, capped — the caller
   * decides which of these actually deserve rehydrating (`shouldRehydrate`).
   */
  listRecoverable({ sinceMs, limit }: { sinceMs: number; limit: number }): ManagedSessionRow[] {
    return this.listRecoverableStmt.all({ since: sinceMs, limit }) as ManagedSessionRow[];
  }

  delete(sessionId: string): void {
    this.deleteStmt.run(sessionId);
  }
}
