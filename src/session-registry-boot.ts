import { existsSync } from "fs";
import {
  type ManagedSessionRow,
  type ManagedSessionsRepository,
  PROBE_SET_MAX,
} from "./db/repositories/managed-sessions.repository";
import type { FeatureFlagValues } from "./feature-flags";
import { isPidAlive } from "./lifecycle/process-liveness";
import type { LiveSessionManager } from "./live-session-manager";
import type { Logger } from "./logger";
import { getProcessArgs } from "./process-discovery";
import { CODEX_CLI_PROVIDER } from "./providers";
import type { ResumeOutcome } from "./server";
import {
  AUTO_RESUME_CONCURRENCY,
  AUTO_RESUME_STAGGER_MS,
  type AutoResumeSkipReason,
  autoResumeSkipReason,
  planAutoResume,
} from "./services/sessions/autoResumeOnBoot";
import {
  PRE_BOOT_REASON,
  type ReconcileVerdict,
  reconcileSessions,
} from "./services/sessions/reconcileSessions";
import {
  REHYDRATE_MAX,
  REHYDRATE_WINDOW_MS,
  rehydrateSkipReason,
  rowToStubSession,
} from "./services/sessions/rehydrateSessions";
import type { SessionStore } from "./session-store";
import type { ManagedSession } from "./types";
import { currentBootToken } from "./utils/bootToken";

/**
 * Everything the boot-time registry lifecycle reads from the server. Thunks
 * rather than values for anything bound after construction or replaceable at
 * runtime (`managedSessionsRepo` opens during listen(); tests swap `log` and
 * `resumeSession` on the server instance) — the same reason ScannerManagerDeps
 * passes `cache: () => ConversationCache | null`.
 */
export type SessionRegistryBootDeps = {
  log: () => Logger;
  ptyManager: () => LiveSessionManager;
  sessionStore: () => SessionStore;
  featureFlags: () => FeatureFlagValues;
  autoResumeOnBoot: () => boolean;
  managedSessionsRepo: () => ManagedSessionsRepository | null;
  streamerInstanceId: string;
  sessionVerdicts: Map<string, ReconcileVerdict>;
  selfPtyEndedAt: Map<string, number>;
  resumeSession: (opts: {
    sessionId: string;
    projectName?: string;
    branch?: string;
  }) => Promise<ResumeOutcome>;
  watchConversationFile: (sessionId: string, historyId?: string) => Promise<void>;
  broadcastSessionList: () => void;
  // Boot auto-resume preflights each candidate for a provider history before
  // spending one of the AUTO_RESUME_MAX slots on it (#483). Typed loosely on the
  // success side for the same reason SessionHandlersDeps is: the full shape is
  // declared on StreamerServer and only `ok` / `reason` are read here.
  resolveConversationTarget: (
    sessionId: string,
  ) => Promise<{ ok: false; reason: string } | { ok: true; [key: string]: unknown }>;
};

/**
 * The durable session registry's boot-and-shutdown lifecycle: classifying what
 * previous runs left behind, seeding the session list from it, optionally
 * resuming, pruning retired rows, and mirroring spawns and shutdown back into
 * the registry.
 *
 * Extracted from StreamerServer so registry work stops editing the server file
 * (see docs/plans/2026-07-12-server-ts-split.md, PR 6). State stays on the
 * server: this class only reads it through `deps`.
 */
export class SessionRegistryBoot {
  constructor(private deps: SessionRegistryBootDeps) {}

  private get log(): Logger {
    return this.deps.log();
  }

  private get ptyManager(): LiveSessionManager {
    return this.deps.ptyManager();
  }

  private get sessionStore(): SessionStore {
    return this.deps.sessionStore();
  }

  private get featureFlags(): FeatureFlagValues {
    return this.deps.featureFlags();
  }

  private get autoResumeOnBoot(): boolean {
    return this.deps.autoResumeOnBoot();
  }

  private get managedSessionsRepo(): ManagedSessionsRepository | null {
    return this.deps.managedSessionsRepo();
  }

  private get streamerInstanceId(): string {
    return this.deps.streamerInstanceId;
  }

  private get sessionVerdicts(): Map<string, ReconcileVerdict> {
    return this.deps.sessionVerdicts;
  }

  private get selfPtyEndedAt(): Map<string, number> {
    return this.deps.selfPtyEndedAt;
  }

  /**
   * Classify sessions left behind by previous streamer runs (C1 Phase 3a).
   *
   * Agents already outlive the streamer today on the crash and dev-takeover
   * paths, which exit without reaching ptyManager.dispose() — they are just
   * invisible when they do, because nothing recorded that they existed. This
   * turns those rows into an explicit verdict per session.
   *
   * Read-only with respect to processes: it probes and classifies, and never
   * signals anything. `orphaned` is a report, not a cleanup trigger.
   */
  async reconcilePreviousSessions(): Promise<ReconcileVerdict[]> {
    if (!this.managedSessionsRepo) return [];
    let verdicts: ReconcileVerdict[] = [];
    try {
      const rows = this.managedSessionsRepo
        .listNonTerminal()
        .filter((row) => !this.ptyManager.hasSession(row.session_id));
      if (rows.length === PROBE_SET_MAX) {
        // Said out loud rather than absorbed: past the cap this boot classifies
        // a subset, and the rows it skipped are indistinguishable in the log
        // from rows that did not exist.
        this.log.warn(
          `[reconcile] probe set hit its cap of ${PROBE_SET_MAX} — older rows skipped`,
          {
            event: "registry.probe_truncated",
            limit: PROBE_SET_MAX,
          },
        );
      }
      if (rows.length === 0) return [];

      verdicts = await reconcileSessions(
        rows,
        { isPidAlive, getProcessArgs },
        this.streamerInstanceId,
        currentBootToken(),
      );

      for (const v of verdicts) {
        this.sessionVerdicts.set(v.sessionId, v);
        // A skipped probe is the one verdict that looks like a decision but is
        // an abstention — surfaced so "why is this resumable?" has an answer.
        if (v.reason === PRE_BOOT_REASON) {
          this.log.info(`[reconcile] ${v.sessionId} predates this machine boot — pid not probed`, {
            event: "sessions.boot_token_mismatch",
            sessionId: v.sessionId,
          });
        }
        // Terminal verdicts leave the probe set so the next boot does no work
        // for them. Non-terminal ones stay: a `detached` process may still be
        // running, and we want to re-probe it next time.
        if (v.lifecycle === "completed" || v.lifecycle === "failed") {
          this.managedSessionsRepo.recordStatus(v.sessionId, "idle", "reconcile", {
            completedAt: new Date(),
          });
        }
      }

      this.log.info(`[reconcile] classified ${verdicts.length} session(s) from previous runs`, {
        event: "sessions.reconciled",
        counts: verdicts.reduce<Record<string, number>>((acc, v) => {
          acc[v.lifecycle] = (acc[v.lifecycle] ?? 0) + 1;
          return acc;
        }, {}),
      });
    } catch (err) {
      // Reconciliation is diagnostic. A failure costs post-restart visibility,
      // and must never stop the server from starting.
      this.log.warn("[reconcile] failed to reconcile previous sessions", {
        event: "sessions.reconcile_failed",
        err,
      });
    }
    return verdicts;
  }

  /**
   * Drop finished sessions the registry has held long enough (plan Phase 4).
   *
   * The registry is authoritative and never rebuilt from the cache, so nothing
   * else would ever remove a row: without this it grows for the life of the
   * install, and every boot pays for rows about sessions from months ago.
   */
  pruneTerminalSessions(): void {
    if (!this.managedSessionsRepo) return;
    try {
      const pruned = this.managedSessionsRepo.pruneTerminal();
      if (pruned > 0) {
        this.log.info(`[registry] pruned ${pruned} terminal session row(s)`, {
          event: "registry.pruned",
          pruned,
        });
      }
    } catch (err) {
      // Retention is housekeeping. Failing it costs disk, never correctness.
      this.log.warn("[registry] failed to prune terminal sessions", {
        event: "registry.prune_failed",
        err,
      });
    }
  }

  /**
   * Seed the session list with what previous runs left behind (persistence plan
   * Phase 1, gaps G1/G2/G8).
   *
   * Reconciliation classifies rows and stops there; a verdict is overlaid onto a
   * SessionResponse that already exists, and after a clean restart none does —
   * `SessionStore` starts empty. So the user's session did not become
   * `resumable`, it became *absent*. This is the half that puts it back.
   *
   * The seeded stubs hold no PTY and are never handed to `LiveSessionManager`,
   * so `reapIdleSessions` and `startGraceTimer` — both of which iterate
   * `ptyManager.listSessions()` — cannot observe them. A later resume calls
   * `sessionStore.addManaged` with the real session, which overwrites the stub
   * by id rather than duplicating it.
   */
  rehydratePreviousSessions(verdicts: ReconcileVerdict[]): ManagedSessionRow[] {
    if (!this.managedSessionsRepo) return [];
    try {
      const now = Date.now();
      // One over the cap, so a clipped result set can be reported rather than
      // silently read as "that was all of them".
      const rows = this.managedSessionsRepo.listRecoverable({
        sinceMs: now - REHYDRATE_WINDOW_MS,
        limit: REHYDRATE_MAX + 1,
      });
      const truncated = rows.length > REHYDRATE_MAX;
      const candidates = truncated ? rows.slice(0, REHYDRATE_MAX) : rows;
      // The auto-resume preference is independent of the Phase 1 feature flag,
      // but both paths must make decisions from this exact, bounded row set.
      if (!this.featureFlags.sessionRehydration || candidates.length === 0) return candidates;

      const verdictById = new Map(verdicts.map((v) => [v.sessionId, v]));
      let rehydrated = 0;
      const skippedBy: Record<string, number> = {};
      for (const row of candidates) {
        // Anything already in the store is live and authoritative; a stub must
        // never overwrite it.
        if (this.sessionStore.getManaged(row.session_id)) continue;

        const skip = rehydrateSkipReason(row, { now, projectExists: existsSync });
        if (skip) {
          skippedBy[skip] = (skippedBy[skip] ?? 0) + 1;
          // Per row, not just counted: "my session did not come back" is the
          // report this has to answer, and it is about one specific session.
          this.log.info(`[rehydrate] skipped ${row.session_id}: ${skip}`, {
            event: "sessions.rehydrate_skipped",
            sessionId: row.session_id,
            reason: skip,
          });
          continue;
        }

        this.sessionStore.addManaged(rowToStubSession(row));
        // The reconciler knows strictly more when it produced a verdict for this
        // row (it probed the pid); `resumable` is the fallback for the clean
        // restart case, which leaves no row in the probe set at all.
        this.sessionVerdicts.set(
          row.session_id,
          verdictById.get(row.session_id) ?? {
            sessionId: row.session_id,
            lifecycle: "resumable",
            reason: "recovered from the registry at boot",
          },
        );
        // Re-seed the "our own PTY ended here" marker, so the very first resume
        // after a restart doesn't read the JSONL we flushed on the way out as a
        // FOREIGN owner and answer 409 CONVERSATION_BUSY (plan risk R3).
        if (row.completed_at != null) this.selfPtyEndedAt.set(row.session_id, row.completed_at);
        rehydrated++;
      }

      this.log.info(`[rehydrate] recovered ${rehydrated} session(s) from the registry`, {
        event: "sessions.rehydrated",
        rehydrated,
        skipped: candidates.length - rehydrated,
        skippedBy,
        truncated,
      });
      return candidates;
    } catch (err) {
      // Same contract as reconciliation: this costs post-restart visibility, and
      // must never stop the server from starting.
      this.log.warn("[rehydrate] failed to rehydrate previous sessions", {
        event: "sessions.rehydrate_failed",
        err,
      });
      return [];
    }
  }

  /** Resume only the recent sessions the user explicitly allowed us to start at boot. */
  async autoResumePreviousSessions(rows: ManagedSessionRow[]): Promise<void> {
    if (!this.autoResumeOnBoot) return;

    // Preflight each otherwise-eligible row for a provider history before
    // planning. A session whose JSONL/rollout is gone can never resume, and
    // spending one of the AUTO_RESUME_MAX slots on it starves a session that
    // could (#483). Rows already skippable for a cheaper reason are marked
    // ineligible without a probe, so this costs nothing for them.
    const now = Date.now();
    const baseOptions = { now, projectExists: existsSync, historyExists: () => true };
    const historyExists = new Map<string, boolean>();
    const preflights = new Set<Promise<void>>();
    for (const row of rows) {
      if (autoResumeSkipReason(row, baseOptions) != null) {
        historyExists.set(row.session_id, false);
        continue;
      }
      while (preflights.size >= AUTO_RESUME_CONCURRENCY) {
        await Promise.race(preflights);
      }
      const preflight = (async () => {
        try {
          const target = await this.deps.resolveConversationTarget(row.session_id);
          historyExists.set(row.session_id, target.ok || target.reason !== "history_file_missing");
        } catch {
          // Preserve the normal per-attempt failure handling when preflight is unavailable.
          historyExists.set(row.session_id, true);
        }
      })();
      preflights.add(preflight);
      void preflight.then(() => preflights.delete(preflight));
    }
    await Promise.all(preflights);

    const plan = planAutoResume(rows, {
      ...baseOptions,
      historyExists: (row) => historyExists.get(row.session_id) ?? false,
    });
    const skippedBy: Partial<Record<AutoResumeSkipReason, number>> = {};
    for (const { row, reason } of plan.skipped) {
      skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
      this.log.debug(`[auto-resume] skipped ${row.session_id}: ${reason}`, {
        event: "sessions.auto_resume_skipped",
        sessionId: row.session_id,
        reason,
      });
    }
    if (plan.skipped.length > 0) {
      this.log.info(
        `[auto-resume] left ${plan.skipped.length} ineligible session(s) for manual resume`,
        {
          event: "sessions.auto_resume_skipped",
          skipped: plan.skipped.length,
          skippedBy,
        },
      );
    }
    for (const row of plan.overflow) {
      this.log.info(`[auto-resume] left ${row.session_id} for manual resume: ceiling reached`, {
        event: "sessions.auto_resume_skipped",
        sessionId: row.session_id,
        reason: "ceiling_reached",
      });
    }

    let resumed = 0;
    let failed = 0;
    const inFlight = new Set<Promise<void>>();
    let started = 0;

    const resume = async (row: ManagedSessionRow): Promise<void> => {
      try {
        const outcome = await this.deps.resumeSession({
          sessionId: row.session_id,
          projectName: row.project_name,
          branch: row.branch,
        });
        if (!outcome.ok) {
          failed++;
          this.log.info(`[auto-resume] skipped ${row.session_id}: ${outcome.reason}`, {
            event: "sessions.auto_resume_skipped",
            sessionId: row.session_id,
            reason: outcome.reason,
            ...(outcome.reason === "conversation_busy" && {
              detectedBy: outcome.detectedBy,
              lastActivityMs: outcome.lastActivityMs,
              likelyOwner: outcome.likelyOwner,
            }),
          });
          return;
        }

        resumed++;
        this.log.info(`[auto-resume] resumed ${row.session_id}`, {
          event: "sessions.auto_resume_succeeded",
          sessionId: row.session_id,
          alreadyRunning: outcome.alreadyRunning,
        });
      } catch (err) {
        failed++;
        this.log.warn(`[auto-resume] failed to resume ${row.session_id}`, {
          event: "sessions.auto_resume_failed",
          sessionId: row.session_id,
          err,
        });
      }
    };

    for (const row of plan.attempts) {
      while (inFlight.size >= AUTO_RESUME_CONCURRENCY) {
        await Promise.race(inFlight);
      }
      if (started > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, AUTO_RESUME_STAGGER_MS));
      }

      const task = resume(row);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
      started++;
    }
    await Promise.all(inFlight);

    if (resumed > 0) this.deps.broadcastSessionList();

    this.log.info(`[auto-resume] completed boot recovery: ${resumed} resumed`, {
      event: "sessions.auto_resume_completed",
      attempted: plan.attempts.length,
      resumed,
      failed,
      ineligible: plan.skipped.length,
      overflow: plan.overflow.length,
    });
  }

  /**
   * Pick a token guaranteed to appear in the spawned process's argv, for the
   * reconciler's pid-reuse guard.
   *
   * Claude always passes the session id (`--resume <id>` or `--session-id
   * <id>`), so it is both present and unique. Codex only does on *resume*
   * (`codex resume <id>`); a fresh Codex spawn is `codex --cd <path>
   * --no-alt-screen` with no id at all, because the rollout id does not exist
   * until the CLI writes it. boundConversationId is what distinguishes the two:
   * it is set once that rollout has been discovered.
   */
  spawnArgvToken(session: ManagedSession): string {
    if (session.provider !== CODEX_CLI_PROVIDER) return session.id;
    return session.boundConversationId ?? session.projectPath;
  }

  /** Restore registry-only metadata after the host mirror has been adopted. */
  refreshHostedSessionsFromRegistry(): void {
    for (const session of this.ptyManager.listSessions()) {
      const row = this.managedSessionsRepo?.get(session.id);
      const merged: ManagedSession = {
        ...session,
        reconciled: true,
        ...(row?.project_id != null && { projectId: row.project_id }),
        ...(row?.session_name != null && { sessionName: row.session_name }),
        ...(row?.bound_conversation_id != null && {
          boundConversationId: row.bound_conversation_id,
        }),
        ...(row?.resumed_from_conversation_id != null && {
          resumedFromConversationId: row.resumed_from_conversation_id,
        }),
      };
      this.sessionStore.addManaged(merged);
      void this.deps.watchConversationFile(session.id, merged.boundConversationId ?? session.id);
    }
  }

  /**
   * Mirror a freshly-spawned session into the durable registry (C1 Phase 2).
   *
   * Called at each addManaged() site rather than inside SessionStore, because
   * the store is a pure in-memory structure with no DB dependency and adding
   * one would drag persistence into every unit test that touches it.
   *
   * Best-effort by design: a failed registry write must never break session
   * start. Losing a row costs post-restart *visibility* for that session, which
   * is strictly better than refusing to run the agent at all.
   */
  recordSessionSpawn(session: ManagedSession): void {
    if (!this.managedSessionsRepo) return;
    try {
      const pid = this.ptyManager.getPid(session.id);
      this.managedSessionsRepo.recordSpawn({
        session,
        pid,
        // Identity guard against pid reuse: the reconciler requires this token
        // to appear in the live process's argv before it will claim the pid is
        // still ours (docs/architecture/2026-07-24-durable-session-runtime.md).
        //
        // Reading the real argv here would cost an async `ps` per session start
        // on a path the user is waiting on, so we record a token we already
        // know is in it. Claude always carries the session id (`--resume <id>`
        // on resume, `--session-id <id>` on fresh). A *fresh* Codex spawn does
        // not — its argv is only `--cd <path> --no-alt-screen`, because the
        // rollout id doesn't exist yet — so fall back to the project path,
        // which is present in every spawn path for both providers.
        //
        // The fallback is weaker: two sessions in one project share a token, so
        // it proves "a process of ours in this project" rather than "this exact
        // session". It still rejects an unrelated recycled pid, which is the
        // failure being guarded against.
        //
        // Note the Codex id is always *set* (a local placeholder) — it is just
        // not in the process's argv — so the choice keys off the provider, not
        // off the id being null.
        cmdline: pid != null ? this.spawnArgvToken(session) : null,
        streamerInstanceId: this.streamerInstanceId,
      });
    } catch (err) {
      this.log.warn("[registry] failed to record session spawn", {
        event: "registry.spawn_write_failed",
        sessionId: session.id,
        err,
      });
    }
  }

  /**
   * Stamp every live session as ended-by-shutdown before dispose() kills it.
   *
   * PTYManager.dispose() signals each child directly and fires no
   * onStatusChange, so the registry would otherwise keep rows sitting at
   * `running` forever and the next boot could not tell a deliberate restart
   * from a crash. Recording `shutdown` as the status source makes that
   * distinction explicit rather than inferred.
   *
   * Not a `completed_at` write for the agent's own work — the agent did not
   * finish, we stopped it — but the session is genuinely terminal, so it must
   * leave the reconciler's probe set.
   */
  recordShutdownState(): void {
    if (!this.managedSessionsRepo) return;
    const now = new Date();
    for (const session of this.ptyManager.listSessions()) {
      try {
        // No failureReason: a shutdown is not a failure of the session, and
        // writing one would make a healthy agent look broken on the next boot.
        // status_source="shutdown" already carries the reason.
        //
        // The session's LIVE status, not a flattened `idle`. `completed_at` and
        // `status_source` are what make the row terminal; overwriting the status
        // as well erased the one thing a recovered session cannot re-derive —
        // whether the agent was mid-answer when we stopped it (Phase 5's
        // `interruptedStatus`). Nothing keys off this value: the reconciler
        // reads completed_at/pid/boot_token, the rehydrator reads status_source,
        // and the stub reports `idle` on the wire regardless.
        this.managedSessionsRepo.recordStatus(session.id, session.status, "shutdown", {
          completedAt: now,
          lastActivityAt: session.lastActivityAt ?? null,
          promptCount: session.promptCount,
        });
      } catch (err) {
        // Shutdown must complete regardless. A lost row costs visibility, not
        // correctness, and throwing here would strand the rest of teardown.
        this.log.warn("[registry] failed to record shutdown state", {
          event: "registry.shutdown_write_failed",
          sessionId: session.id,
          err,
        });
      }
    }
  }
}
