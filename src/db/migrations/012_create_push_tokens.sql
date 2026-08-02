-- Push registration and delivery state (C7 notification reliability).
--
-- POST /api/push/register was a no-op returning { ok: true }: mobile registered,
-- received success, and nothing was stored. No token existed, so no notification
-- could ever be delivered, no failure could be observed, and the client had no
-- way to discover that its "successful" registration meant nothing.
CREATE TABLE IF NOT EXISTS push_tokens (
  -- The provider push token (Expo). Natural key: re-registering the same token
  -- must update the existing row rather than accumulate duplicates, which is
  -- how the same device ends up receiving one notification several times.
  token             TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,

  -- Optional device attribution. Nullable because push registration predates
  -- device identity (C5) and must keep working without it.
  device_id         TEXT,

  registered_at     INTEGER NOT NULL,

  -- Delivery health. Distinguishing "we have never tried" from "we tried and it
  -- failed" is the difference between a client showing "not yet delivered" and
  -- "your notifications are broken" — the report the user actually needs.
  last_success_at   INTEGER,
  last_failure_at   INTEGER,
  last_failure_code TEXT,

  -- Consecutive failures. Reset on success. A token the provider has rejected
  -- repeatedly is dead (app uninstalled, token rotated) and should stop being
  -- retried rather than failing forever.
  failure_streak    INTEGER NOT NULL DEFAULT 0,

  -- Set when the provider tells us the token is permanently invalid, or the
  -- user unregisters. Retained rather than deleted so the health report can
  -- explain why delivery stopped.
  revoked_at        INTEGER
);

-- Delivery attempts are keyed by event id so a retry, a reconnect
-- reconciliation, or a duplicate trigger cannot notify the user twice for the
-- same underlying event.
CREATE TABLE IF NOT EXISTS push_events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_revoked ON push_tokens (revoked_at);
CREATE INDEX IF NOT EXISTS idx_push_events_created ON push_events (created_at);
