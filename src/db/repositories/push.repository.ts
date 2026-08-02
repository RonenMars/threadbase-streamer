import type Database from "better-sqlite3";

/**
 * Push registration and delivery state (C7).
 *
 * `POST /api/push/register` was a no-op returning `{ ok: true }`. Mobile
 * registered, received success, and nothing was stored — so no notification
 * could ever be delivered, no failure could be observed, and the client had no
 * way to discover that its successful registration meant nothing.
 *
 * This records tokens and what happened to them, which is the prerequisite for
 * every other C7 requirement: token health, last success/failure, retries,
 * revocation confirmation, and a test-notification endpoint all need somewhere
 * to read state from.
 */

/**
 * Consecutive failures after which a token is treated as dead.
 *
 * A provider rejecting a token repeatedly means the app was uninstalled or the
 * token rotated. Retrying forever wastes work and, worse, makes the health
 * report read "failing" indefinitely instead of "this device is gone".
 */
export const FAILURE_STREAK_LIMIT = 5;

/**
 * Token kinds. A device supplies three non-interchangeable types, and
 * conflating them fails only at send time with no signal at registration:
 *
 * - `expo` — Expo relay token, for ordinary push notifications.
 * - `liveactivity_start` — ActivityKit push-to-start token. App-wide, one per
 *   device, long-lived. Starts an activity when none exists.
 * - `liveactivity_update` — ActivityKit per-activity update token, issued by
 *   iOS after an activity starts, scoped to that one activity, short-lived.
 */
export const PUSH_TOKEN_KINDS = ["expo", "liveactivity_start", "liveactivity_update"] as const;

export type PushTokenKind = (typeof PUSH_TOKEN_KINDS)[number];

/**
 * The kind assumed when a client does not send one.
 *
 * tb-mobile is released and cannot be force-updated, so an older client posting
 * `{ token, platform }` must keep working. Every such client is registering an
 * Expo relay token, because that is the only kind that existed then.
 */
export const DEFAULT_PUSH_TOKEN_KIND: PushTokenKind = "expo";

export function isPushTokenKind(value: unknown): value is PushTokenKind {
  return typeof value === "string" && (PUSH_TOKEN_KINDS as readonly string[]).includes(value);
}

export interface PushTokenRow {
  token: string;
  platform: string;
  device_id: string | null;
  registered_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_code: string | null;
  failure_streak: number;
  revoked_at: number | null;
  kind: PushTokenKind;
  activity_id: string | null;
  session_id: string | null;
  expires_at: number | null;
  stale_date: number | null;
  started_at: number | null;
  renewed_at: number | null;
}

/**
 * Health as reported to a client. Deliberately omits the token itself — a push
 * token is a delivery credential, and a health endpoint has no reason to echo
 * one back.
 */
export interface PushTokenHealth {
  platform: string;
  deviceId: string | null;
  registeredAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  failureStreak: number;
  revokedAt: number | null;
  /**
   * Never delivered vs delivering vs failing vs revoked vs expired. The
   * distinction the user actually needs: "not yet" and "broken" look identical
   * without it.
   */
  state: "never-delivered" | "healthy" | "failing" | "dead" | "revoked" | "expired";
  kind: PushTokenKind;
  /** Present only for per-activity Live Activity tokens. */
  activityId: string | null;
  sessionId: string | null;
  expiresAt: number | null;
}

export function tokenState(row: PushTokenRow, now: number = Date.now()): PushTokenHealth["state"] {
  if (row.revoked_at != null) return "revoked";
  // Expiry before failure state: a per-activity token that lapsed is not
  // "broken", and reporting it as failing would send the user chasing a
  // delivery problem that does not exist.
  if (row.expires_at != null && row.expires_at <= now) return "expired";
  if (row.failure_streak >= FAILURE_STREAK_LIMIT) return "dead";
  if (row.failure_streak > 0) return "failing";
  if (row.last_success_at == null) return "never-delivered";
  return "healthy";
}

export function toHealth(row: PushTokenRow, now: number = Date.now()): PushTokenHealth {
  return {
    platform: row.platform,
    deviceId: row.device_id,
    registeredAt: row.registered_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureCode: row.last_failure_code,
    failureStreak: row.failure_streak,
    revokedAt: row.revoked_at,
    state: tokenState(row, now),
    kind: row.kind,
    activityId: row.activity_id,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
  };
}

export class PushRepository {
  private upsertStmt: Database.Statement;
  private getStmt: Database.Statement;
  private listActiveStmt: Database.Statement;
  private listAllStmt: Database.Statement;
  private successStmt: Database.Statement;
  private failureStmt: Database.Statement;
  private revokeStmt: Database.Statement;
  private claimEventStmt: Database.Statement;
  private markDeliveredStmt: Database.Statement;
  private listByKindSessionStmt: Database.Statement;
  private listByKindStmt: Database.Statement;
  private listRenewableStmt: Database.Statement;
  private claimRenewalStmt: Database.Statement;
  private expireStmt: Database.Statement;
  private expireSessionActivitiesStmt: Database.Statement;

  constructor(db: Database.Database) {
    // Re-registering the same token updates rather than duplicating. Without
    // this, one device accumulates rows and receives the same notification
    // several times.
    this.upsertStmt = db.prepare(`
      INSERT INTO push_tokens (
        token, platform, device_id, registered_at,
        kind, activity_id, session_id, expires_at, stale_date, started_at
      )
      VALUES (
        @token, @platform, @device_id, @registered_at,
        @kind, @activity_id, @session_id, @expires_at, @stale_date, @started_at
      )
      ON CONFLICT(token) DO UPDATE SET
        platform = excluded.platform,
        device_id = COALESCE(excluded.device_id, push_tokens.device_id),
        registered_at = excluded.registered_at,
        kind = excluded.kind,
        activity_id = COALESCE(excluded.activity_id, push_tokens.activity_id),
        session_id = COALESCE(excluded.session_id, push_tokens.session_id),
        expires_at = excluded.expires_at,
        stale_date = excluded.stale_date,
        -- Preserve the ORIGINAL start across a re-registration. iOS renders its
        -- own ticking timer from started_at, so overwriting it with a fresh
        -- value visibly resets the user's elapsed time to zero.
        started_at = COALESCE(push_tokens.started_at, excluded.started_at),
        -- A fresh registration clears prior failure state and any revocation:
        -- the client is telling us this token is live again. renewed_at clears
        -- too — this is a new activity generation, so it is renewable again.
        failure_streak = 0,
        last_failure_at = NULL,
        last_failure_code = NULL,
        revoked_at = NULL,
        renewed_at = NULL
    `);
    this.getStmt = db.prepare("SELECT * FROM push_tokens WHERE token = ?");
    // Expo relay tokens only. An ActivityKit token posted to Expo's relay is
    // rejected, so the ordinary-notification fan-out must never see one — this
    // is the query that keeps the three kinds from being conflated.
    this.listActiveStmt = db.prepare(`
      SELECT * FROM push_tokens
       WHERE revoked_at IS NULL AND failure_streak < ${FAILURE_STREAK_LIMIT}
         AND kind = 'expo'
       ORDER BY registered_at ASC
    `);
    this.listAllStmt = db.prepare("SELECT * FROM push_tokens ORDER BY registered_at ASC");
    this.successStmt = db.prepare(`
      UPDATE push_tokens
         SET last_success_at = @at, failure_streak = 0,
             last_failure_code = NULL
       WHERE token = @token
    `);
    this.failureStmt = db.prepare(`
      UPDATE push_tokens
         SET last_failure_at = @at, last_failure_code = @code,
             failure_streak = failure_streak + 1
       WHERE token = @token
    `);
    this.revokeStmt = db.prepare("UPDATE push_tokens SET revoked_at = ? WHERE token = ?");

    // Live Activity sends are driven by a session status change, so they select
    // by (kind, session) rather than scanning every token. Expired rows are
    // excluded here rather than filtered by the caller: a lapsed per-activity
    // token is not a delivery target, and APNs rejects it.
    this.listByKindSessionStmt = db.prepare(`
      SELECT * FROM push_tokens
       WHERE kind = @kind AND session_id = @session_id
         AND revoked_at IS NULL AND failure_streak < ${FAILURE_STREAK_LIMIT}
         AND (expires_at IS NULL OR expires_at > @now)
       ORDER BY registered_at ASC
    `);
    this.listByKindStmt = db.prepare(`
      SELECT * FROM push_tokens
       WHERE kind = @kind
         AND revoked_at IS NULL AND failure_streak < ${FAILURE_STREAK_LIMIT}
         AND (expires_at IS NULL OR expires_at > @now)
       ORDER BY registered_at ASC
    `);
    // Renewal candidates. Bounded by the partial index on (stale_date) — only
    // unrenewed rows with a deadline are ever candidates, so the boot-time
    // re-arm scan stays proportional to pending renewals.
    this.listRenewableStmt = db.prepare(`
      SELECT * FROM push_tokens
       WHERE kind = 'liveactivity_update'
         AND stale_date IS NOT NULL AND renewed_at IS NULL
         AND revoked_at IS NULL AND failure_streak < ${FAILURE_STREAK_LIMIT}
       ORDER BY stale_date ASC
    `);
    // The idempotency gate for renewal. Conditional on renewed_at IS NULL so
    // the first caller gets changes=1 and any concurrent or post-restart
    // re-armed timer gets 0 and must not send — the same INSERT-OR-IGNORE
    // reasoning as claimEvent, applied to an UPDATE.
    this.claimRenewalStmt = db.prepare(`
      UPDATE push_tokens SET renewed_at = @at
       WHERE token = @token AND renewed_at IS NULL
    `);
    this.expireStmt = db.prepare("UPDATE push_tokens SET expires_at = ? WHERE token = ?");
    this.expireSessionActivitiesStmt = db.prepare(`
      UPDATE push_tokens SET expires_at = @at
       WHERE session_id = @session_id AND kind = 'liveactivity_update'
         AND (expires_at IS NULL OR expires_at > @at)
    `);

    // INSERT OR IGNORE is the dedupe: the first caller for an event id inserts
    // and gets changes=1, any concurrent or retried caller gets 0 and must not
    // send. Doing this in SQL rather than a read-then-write avoids the race
    // where two triggers both observe "not yet sent".
    this.claimEventStmt = db.prepare(`
      INSERT OR IGNORE INTO push_events (event_id, session_id, created_at)
      VALUES (@event_id, @session_id, @created_at)
    `);
    this.markDeliveredStmt = db.prepare(
      "UPDATE push_events SET delivered_at = ? WHERE event_id = ?",
    );
  }

  /**
   * Register or refresh a token.
   *
   * `kind` defaults to Expo so a released client posting `{ token, platform }`
   * keeps working — tb-mobile cannot be force-updated, and every client
   * predating Live Activities is registering an Expo relay token.
   *
   * Several rows per device is normal and intended: a device runs one activity
   * per live session, each with its own update token. The token itself is the
   * primary key, so distinct activities never collide.
   */
  register(args: {
    token: string;
    platform: string;
    deviceId?: string | null;
    kind?: PushTokenKind;
    activityId?: string | null;
    sessionId?: string | null;
    expiresAt?: number | null;
    staleDate?: number | null;
    startedAt?: number | null;
    now?: number;
  }): void {
    this.upsertStmt.run({
      token: args.token,
      platform: args.platform,
      device_id: args.deviceId ?? null,
      registered_at: args.now ?? Date.now(),
      kind: args.kind ?? DEFAULT_PUSH_TOKEN_KIND,
      activity_id: args.activityId ?? null,
      session_id: args.sessionId ?? null,
      expires_at: args.expiresAt ?? null,
      stale_date: args.staleDate ?? null,
      started_at: args.startedAt ?? null,
    });
  }

  get(token: string): PushTokenRow | null {
    return (this.getStmt.get(token) as PushTokenRow | undefined) ?? null;
  }

  /**
   * Expo tokens eligible for delivery — not revoked, not past the failure limit.
   *
   * Deliberately Expo-only. ActivityKit tokens go over direct APNs with a
   * different topic and are rejected by Expo's relay, so the ordinary
   * notification fan-out must not see them.
   */
  listDeliverable(): PushTokenRow[] {
    return this.listActiveStmt.all() as PushTokenRow[];
  }

  /** Live-activity tokens for one session, eligible for delivery. */
  listForSession(kind: PushTokenKind, sessionId: string, now: number = Date.now()): PushTokenRow[] {
    return this.listByKindSessionStmt.all({
      kind,
      session_id: sessionId,
      now,
    }) as PushTokenRow[];
  }

  /**
   * Every deliverable token of one kind.
   *
   * Used for push-to-start, which is app-wide rather than session-scoped: the
   * activity does not exist yet, so there is no per-activity token to look up.
   */
  listByKind(kind: PushTokenKind, now: number = Date.now()): PushTokenRow[] {
    return this.listByKindStmt.all({ kind, now }) as PushTokenRow[];
  }

  /** Unrenewed activities with a renewal deadline, soonest first. */
  listRenewable(): PushTokenRow[] {
    return this.listRenewableStmt.all() as PushTokenRow[];
  }

  /**
   * Claim a row for renewal.
   *
   * Returns true exactly once per row. A restart re-arms timers from the
   * persisted deadline, so the same renewal can be attempted twice; the loser
   * gets false and must not send. Doing this as a conditional UPDATE rather
   * than read-then-write avoids the race where both attempts observe
   * "not yet renewed".
   */
  claimRenewal(token: string, now: number = Date.now()): boolean {
    return this.claimRenewalStmt.run({ token, at: now }).changes > 0;
  }

  /** Mark one token expired, so it stops being a delivery target. */
  expire(token: string, now: number = Date.now()): void {
    this.expireStmt.run(now, token);
  }

  /**
   * Expire every live activity for a session.
   *
   * Called when the session ends. Without this, a per-activity token outlives
   * its session and a later renewal sweep would resurrect an activity for a
   * session that is already gone.
   */
  expireSessionActivities(sessionId: string, now: number = Date.now()): void {
    this.expireSessionActivitiesStmt.run({ session_id: sessionId, at: now });
  }

  /** Every token, including dead and revoked ones, for the health report. */
  listHealth(now: number = Date.now()): PushTokenHealth[] {
    return (this.listAllStmt.all() as PushTokenRow[]).map((r) => toHealth(r, now));
  }

  recordSuccess(token: string, now: number = Date.now()): void {
    this.successStmt.run({ token, at: now });
  }

  recordFailure(token: string, code: string, now: number = Date.now()): void {
    this.failureStmt.run({ token, at: now, code });
  }

  revoke(token: string, now: number = Date.now()): boolean {
    return this.revokeStmt.run(now, token).changes > 0;
  }

  /**
   * Claim an event id for delivery.
   *
   * Returns true exactly once per event id. A retry, a reconnect
   * reconciliation, or two triggers firing for the same underlying event all
   * get false and must not notify — the user should never be told twice about
   * one thing.
   */
  claimEvent(eventId: string, sessionId: string | null, now: number = Date.now()): boolean {
    return (
      this.claimEventStmt.run({ event_id: eventId, session_id: sessionId, created_at: now })
        .changes > 0
    );
  }

  markDelivered(eventId: string, now: number = Date.now()): void {
    this.markDeliveredStmt.run(now, eventId);
  }
}
