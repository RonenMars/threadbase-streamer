import type { PushRepository, PushTokenRow } from "../../db/repositories/push.repository";
import { getLogger } from "../../logger";
import type { ApnsClient, ApnsSendResult } from "./apnsClient";
import type { LiveActivityContentState } from "./liveActivityContentState";

/**
 * Live Activity push sender.
 *
 * Turns a session lifecycle change into an ActivityKit push. Owns the `aps`
 * envelope and the per-token bookkeeping — which token to send to, and what to
 * do when APNs rejects one — so the session lifecycle callback stays a one-line
 * call.
 */

const log = getLogger("live-activity");

/** iOS ends a Live Activity ~8h after it starts. */
export const ACTIVITY_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;

export type LiveActivityEvent = "update" | "end";

export interface LiveActivitySendOutcome {
  attempted: number;
  succeeded: number;
  /** Tokens APNs rejected as permanently unusable, now expired locally. */
  retired: number;
}

/**
 * The APNs `aps` envelope for an ActivityKit push.
 *
 * Key names are Apple's and are not ours to choose: `content-state`,
 * `stale-date`, and `dismissal-date` are hyphenated, while `timestamp` and
 * `event` are not.
 */
interface ActivityKitPayload {
  aps: {
    /** Seconds since epoch. iOS discards a push whose timestamp regresses. */
    timestamp: number;
    event: LiveActivityEvent;
    "content-state": LiveActivityContentState;
    /** Seconds since epoch. When iOS should start showing the content as stale. */
    "stale-date"?: number;
    "dismissal-date"?: number;
  };
}

export function buildActivityKitPayload(args: {
  event: LiveActivityEvent;
  contentState: LiveActivityContentState;
  now: number;
  staleDate?: number | null;
  dismissalDate?: number | null;
}): ActivityKitPayload {
  return {
    aps: {
      timestamp: Math.floor(args.now / 1000),
      event: args.event,
      "content-state": args.contentState,
      ...(args.staleDate != null && { "stale-date": Math.floor(args.staleDate / 1000) }),
      ...(args.dismissalDate != null && {
        "dismissal-date": Math.floor(args.dismissalDate / 1000),
      }),
    },
  };
}

export class LiveActivitySender {
  constructor(
    private readonly apns: ApnsClient,
    private readonly repo: PushRepository,
  ) {}

  /**
   * Push to every live activity of a session.
   *
   * Sends are independent: one rejected token must not stop the others, because
   * a single dead device would otherwise silence every other device watching the
   * same session.
   */
  async send(args: {
    sessionId: string;
    event: LiveActivityEvent;
    contentState: LiveActivityContentState;
    now?: number;
    priority?: 5 | 10;
  }): Promise<LiveActivitySendOutcome> {
    const now = args.now ?? Date.now();
    return this.sendToTokens({
      tokens: this.repo.listForSession("liveactivity_update", args.sessionId, now),
      sessionId: args.sessionId,
      event: args.event,
      contentState: args.contentState,
      now,
      priority: args.priority,
    });
  }

  /**
   * Push to an explicit token list.
   *
   * Renewal needs this: a replacement activity does not exist yet, so it is
   * started via the app-wide push-to-start token rather than any per-session
   * lookup. Shares one fan-out body with `send()` so failure handling cannot
   * drift between the two paths.
   */
  async sendToTokens(args: {
    tokens: PushTokenRow[];
    sessionId: string;
    event: LiveActivityEvent;
    contentState: LiveActivityContentState;
    now?: number;
    priority?: 5 | 10;
    /** Overrides the row's own cap — renewal sets the replacement's window. */
    staleDate?: number | null;
  }): Promise<LiveActivitySendOutcome> {
    const now = args.now ?? Date.now();
    const tokens = args.tokens;
    const outcome: LiveActivitySendOutcome = {
      attempted: tokens.length,
      succeeded: 0,
      retired: 0,
    };
    if (tokens.length === 0) return outcome;

    const results = await Promise.all(
      tokens.map((row) =>
        this.sendToToken(row, args.event, args.contentState, now, args.priority, args.staleDate),
      ),
    );

    for (const { row, result, error } of results) {
      if (error) {
        // Never swallowed: without this the surface just stops updating and
        // there is nothing anywhere to explain why.
        log.error("live_activity.send_failed", {
          event: "live_activity.send_failed",
          sessionId: args.sessionId,
          activityId: row.activity_id,
          apnsEvent: args.event,
          err: String(error),
        });
        this.repo.recordFailure(row.token, "SendError", now);
        continue;
      }
      if (!result) continue;

      if (result.ok) {
        this.repo.recordSuccess(row.token, now);
        outcome.succeeded += 1;
        continue;
      }

      this.repo.recordFailure(row.token, result.reason ?? `HTTP_${result.status}`, now);
      if (result.tokenDead) {
        // Retire rather than retry. A dead token fails forever, and retrying it
        // makes the health report say "failing" when the truth is the device or
        // activity is gone.
        this.repo.expire(row.token, now);
        outcome.retired += 1;
      }
      log.warn("live_activity.send_rejected", {
        event: "live_activity.send_rejected",
        sessionId: args.sessionId,
        activityId: row.activity_id,
        apnsEvent: args.event,
        status: result.status,
        reason: result.reason,
        tokenDead: result.tokenDead,
      });
    }

    return outcome;
  }

  /**
   * End every live activity for a session and stop tracking them.
   *
   * Expiring locally is what stops the renewal sweep from later resurrecting an
   * activity for a session that has already finished.
   */
  async end(args: {
    sessionId: string;
    contentState: LiveActivityContentState;
    now?: number;
  }): Promise<LiveActivitySendOutcome> {
    const now = args.now ?? Date.now();
    const outcome = await this.send({
      sessionId: args.sessionId,
      event: "end",
      contentState: args.contentState,
      now,
    });
    this.repo.expireSessionActivities(args.sessionId, now);
    return outcome;
  }

  private async sendToToken(
    row: PushTokenRow,
    event: LiveActivityEvent,
    contentState: LiveActivityContentState,
    now: number,
    priority?: 5 | 10,
    staleDateOverride?: number | null,
  ): Promise<{ row: PushTokenRow; result?: ApnsSendResult; error?: unknown }> {
    // A stale-date is only meaningful for an update; an `end` is terminal.
    const staleDate =
      event === "update"
        ? (staleDateOverride ?? row.stale_date ?? contentState.startedAt + ACTIVITY_MAX_LIFETIME_MS)
        : null;
    try {
      const result = await this.apns.send({
        deviceToken: row.token,
        payload: buildActivityKitPayload({ event, contentState, now, staleDate }),
        priority,
      });
      return { row, result };
    } catch (error) {
      return { row, error };
    }
  }
}
