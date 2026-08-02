import type { PushRepository, PushTokenRow } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";
import type { SessionStore } from "../../session-store";
import { toLiveActivityStatus, truncateLastOutput } from "./liveActivityContentState";
import { ACTIVITY_MAX_LIFETIME_MS, type LiveActivitySender } from "./liveActivitySender";

/**
 * Live Activity renewal scheduler.
 *
 * iOS ends a Live Activity roughly 8 hours after it starts, so a long-running
 * session loses its Lock Screen surface mid-session unless the activity is
 * replaced before the cap. Renewal ends the old activity and starts a
 * replacement.
 *
 * Deadlines live in the DB (`push_tokens.stale_date`) and timers are re-armed on
 * boot. An in-process `setTimeout` alone is not enough: it dies with the process,
 * and a restart inside an 8-hour window would drop every pending renewal
 * silently. Firing is gated by `claimRenewal()` so a re-armed timer cannot
 * double-send.
 *
 * Temporal is deliberately not used here even though `@temporalio/client` is a
 * dependency: it is reachable only under MULTI_AGENT_FLOW, where the PTY path
 * this feature observes does not run. Adding a Temporal dependency to the
 * default path would make Live Activities require a Temporal server.
 */

const log = getLogger("live-activity");

/**
 * How long before the cap to renew.
 *
 * Far enough out that a missed tick or a slow APNs round trip still lands inside
 * the window, close enough that the replacement activity gets a nearly full
 * 8-hour lifetime of its own.
 */
export const RENEWAL_LEAD_MS = 30 * 60 * 1000;

/**
 * Longest a single timer is allowed to sleep.
 *
 * `setTimeout` overflows past ~24.8 days (2^31 ms) and fires immediately, and a
 * long sleep also drifts across a laptop suspend. Long waits are therefore
 * chained in bounded hops, re-reading the deadline each time.
 */
const MAX_TIMER_MS = 60 * 60 * 1000;

export interface LiveActivityRenewalDeps {
  repo: PushRepository;
  sender: LiveActivitySender;
  sessionStore: SessionStore;
  serverId: string;
  serverLabel?: string;
  /** Injected in tests; production uses the real clock. */
  now?: () => number;
}

/** When a row should be renewed: its cap, minus the lead time. */
export function renewalDueAt(row: PushTokenRow): number | null {
  return row.stale_date == null ? null : row.stale_date - RENEWAL_LEAD_MS;
}

export class LiveActivityRenewalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: LiveActivityRenewalDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Arm the scheduler from persisted state.
   *
   * Called on boot, which is what makes a renewal survive a restart: the
   * deadlines were never in memory to begin with.
   */
  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Renew everything due, then sleep until the next deadline.
   *
   * Re-reads from the DB every tick rather than caching a schedule in memory, so
   * an activity registered after boot is picked up without re-arming anything.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;

    const now = this.now();
    try {
      for (const row of this.deps.repo.listRenewable()) {
        const dueAt = renewalDueAt(row);
        if (dueAt == null || dueAt > now) continue;
        await this.renew(row, now);
      }
    } catch (err) {
      // A failed sweep must not kill the scheduler — the next tick retries.
      // Silence here would strand every future renewal.
      log.error("live_activity.renewal_sweep_failed", {
        event: "live_activity.renewal_sweep_failed",
        err: String(err),
      });
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const now = this.now();
    const pending = this.deps.repo
      .listRenewable()
      .map(renewalDueAt)
      .filter((d): d is number => d != null);

    // Nothing pending: still wake up on the hour cap, since an activity may be
    // registered while we sleep and nothing else re-arms this timer.
    const nextDue = pending.length > 0 ? Math.min(...pending) : now + MAX_TIMER_MS;
    const delay = Math.min(Math.max(nextDue - now, 0), MAX_TIMER_MS);

    this.timer = setTimeout(() => void this.tick(), delay);
    // Never hold the process open for a renewal: shutdown must not wait on it.
    this.timer.unref?.();
  }

  /**
   * Renew one activity.
   *
   * Claims first: `claimRenewal()` succeeds exactly once per row, so a timer
   * re-armed after a restart mid-window cannot send a second time.
   */
  private async renew(row: PushTokenRow, now: number): Promise<void> {
    if (!row.session_id) return;

    // Only renew a session that is genuinely still live. A session that ended
    // inside the renewal window must not be resurrected — the reason this is
    // checked here rather than trusted from the row.
    const session = this.deps.sessionStore.getManaged(row.session_id);
    const status = session ? toLiveActivityStatus(session.status) : null;
    if (!session || !status) {
      // Claim it anyway so the sweep stops reconsidering a row it will never
      // renew, and expire the token so it is no longer a delivery target.
      this.deps.repo.claimRenewal(row.token, now);
      this.deps.repo.expire(row.token, now);
      log.info("live_activity.renewal_skipped", {
        event: "live_activity.renewal_skipped",
        sessionId: row.session_id,
        activityId: row.activity_id,
        reason: session ? `status_${session.status}` : "session_gone",
      });
      return;
    }

    if (!this.deps.repo.claimRenewal(row.token, now)) {
      // Another tick, or a pre-restart run, already handled this row.
      return;
    }

    // THE failure mode this whole path exists to avoid: iOS renders its own
    // ticking elapsed timer from startedAt, so the replacement must carry the
    // ORIGINAL start. A fresh value makes the user's visible timer reset to zero.
    const startedAt = row.started_at ?? session.startedAt.getTime();

    const contentState = {
      sessionId: session.id,
      serverId: this.deps.serverId,
      projectName: session.projectName,
      status,
      startedAt,
      lastOutput: session.lastOutput ?? "",
      ...(this.deps.serverLabel != null && { serverLabel: this.deps.serverLabel }),
      ...(session.sessionName != null && { sessionName: session.sessionName }),
    };

    try {
      // End the old activity, then hand mobile the state to start its
      // replacement with. The replacement's own update token arrives via
      // /api/push/register once iOS issues it.
      await this.deps.sender.send({
        sessionId: session.id,
        event: "end",
        contentState: { ...contentState, lastOutput: truncateLastOutput(contentState.lastOutput) },
        now,
      });
      this.deps.repo.expire(row.token, now);

      const started = await this.startReplacement({
        sessionId: session.id,
        startedAt,
        now,
      });

      log.info("live_activity.renewed", {
        event: "live_activity.renewed",
        sessionId: session.id,
        activityId: row.activity_id,
        // Logged because a regression here is invisible on the server and only
        // shows up as a reset timer on someone's Lock Screen.
        startedAt,
        replacementRequested: started,
      });
    } catch (err) {
      log.error("live_activity.renewal_failed", {
        event: "live_activity.renewal_failed",
        sessionId: session.id,
        activityId: row.activity_id,
        err: String(err),
      });
    }
  }

  /**
   * Ask the device to start a replacement activity.
   *
   * Uses the app-wide push-to-start token, because the replacement does not
   * exist yet and therefore has no per-activity token. Returns false when the
   * device never registered one, which is not an error: the app simply cannot be
   * asked to start an activity remotely, and the next foreground WS update
   * recreates it.
   */
  private async startReplacement(args: {
    sessionId: string;
    startedAt: number;
    now: number;
  }): Promise<boolean> {
    const starters = this.deps.repo.listByKind("liveactivity_start", args.now);
    if (starters.length === 0) return false;

    const session = this.deps.sessionStore.getManaged(args.sessionId);
    const status = session ? toLiveActivityStatus(session.status) : null;
    if (!session || !status) return false;

    await this.deps.sender.sendToTokens({
      tokens: starters,
      event: "update",
      sessionId: args.sessionId,
      contentState: {
        sessionId: session.id,
        serverId: this.deps.serverId,
        projectName: session.projectName,
        status,
        // Carried through unchanged — the whole point of the renewal.
        startedAt: args.startedAt,
        lastOutput: truncateLastOutput(session.lastOutput ?? ""),
        ...(this.deps.serverLabel != null && { serverLabel: this.deps.serverLabel }),
        ...(session.sessionName != null && { sessionName: session.sessionName }),
      },
      now: args.now,
      staleDate: args.startedAt + ACTIVITY_MAX_LIFETIME_MS,
    });
    return true;
  }
}
