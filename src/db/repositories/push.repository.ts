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
   * Never delivered vs delivering vs failing vs revoked. The distinction the
   * user actually needs: "not yet" and "broken" look identical without it.
   */
  state: "never-delivered" | "healthy" | "failing" | "dead" | "revoked";
}

export function tokenState(row: PushTokenRow): PushTokenHealth["state"] {
  if (row.revoked_at != null) return "revoked";
  if (row.failure_streak >= FAILURE_STREAK_LIMIT) return "dead";
  if (row.failure_streak > 0) return "failing";
  if (row.last_success_at == null) return "never-delivered";
  return "healthy";
}

export function toHealth(row: PushTokenRow): PushTokenHealth {
  return {
    platform: row.platform,
    deviceId: row.device_id,
    registeredAt: row.registered_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureCode: row.last_failure_code,
    failureStreak: row.failure_streak,
    revokedAt: row.revoked_at,
    state: tokenState(row),
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

  constructor(db: Database.Database) {
    // Re-registering the same token updates rather than duplicating. Without
    // this, one device accumulates rows and receives the same notification
    // several times.
    this.upsertStmt = db.prepare(`
      INSERT INTO push_tokens (token, platform, device_id, registered_at)
      VALUES (@token, @platform, @device_id, @registered_at)
      ON CONFLICT(token) DO UPDATE SET
        platform = excluded.platform,
        device_id = COALESCE(excluded.device_id, push_tokens.device_id),
        registered_at = excluded.registered_at,
        -- A fresh registration clears prior failure state and any revocation:
        -- the client is telling us this token is live again.
        failure_streak = 0,
        last_failure_at = NULL,
        last_failure_code = NULL,
        revoked_at = NULL
    `);
    this.getStmt = db.prepare("SELECT * FROM push_tokens WHERE token = ?");
    this.listActiveStmt = db.prepare(`
      SELECT * FROM push_tokens
       WHERE revoked_at IS NULL AND failure_streak < ${FAILURE_STREAK_LIMIT}
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

  register(args: {
    token: string;
    platform: string;
    deviceId?: string | null;
    now?: number;
  }): void {
    this.upsertStmt.run({
      token: args.token,
      platform: args.platform,
      device_id: args.deviceId ?? null,
      registered_at: args.now ?? Date.now(),
    });
  }

  get(token: string): PushTokenRow | null {
    return (this.getStmt.get(token) as PushTokenRow | undefined) ?? null;
  }

  /** Tokens eligible for delivery — not revoked, not past the failure limit. */
  listDeliverable(): PushTokenRow[] {
    return this.listActiveStmt.all() as PushTokenRow[];
  }

  /** Every token, including dead and revoked ones, for the health report. */
  listHealth(): PushTokenHealth[] {
    return (this.listAllStmt.all() as PushTokenRow[]).map(toHealth);
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
