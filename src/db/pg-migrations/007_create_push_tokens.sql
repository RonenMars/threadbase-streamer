-- Push registration and delivery state, mirroring SQLite migrations 012 + 013.
--
-- SQLite is the primary persistence layer; Postgres is dormant (see CLAUDE.md).
-- The two schemas are kept in sync so enabling Postgres later does not require
-- reconstructing history. SQLite reached this shape in two steps (012 created
-- the table, 013 added the kind columns); Postgres never had 012, so this
-- single migration creates the end state directly.
CREATE TABLE IF NOT EXISTS push_tokens (
  -- The provider push token. Natural key: re-registering the same token must
  -- update the existing row rather than accumulate duplicates, which is how one
  -- device ends up receiving the same notification several times.
  token             TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,

  -- Optional device attribution. Nullable because push registration predates
  -- device identity (C5) and must keep working without it.
  device_id         TEXT,

  registered_at     BIGINT NOT NULL,

  -- Delivery health. Distinguishing "never tried" from "tried and failed" is
  -- the difference between "not yet delivered" and "your notifications are
  -- broken" — the report the user actually needs.
  last_success_at   BIGINT,
  last_failure_at   BIGINT,
  last_failure_code TEXT,

  -- Consecutive failures, reset on success. A token the provider has rejected
  -- repeatedly is dead (app uninstalled, token rotated) and should stop being
  -- retried rather than failing forever.
  failure_streak    INTEGER NOT NULL DEFAULT 0,

  -- Set when the provider reports the token permanently invalid, or the user
  -- unregisters. Retained rather than deleted so the health report can explain
  -- why delivery stopped.
  revoked_at        BIGINT,

  -- Token kind. A device supplies three non-interchangeable types: the Expo
  -- relay token, the ActivityKit push-to-start token (app-wide), and an
  -- ActivityKit per-activity update token (short-lived, issued after an
  -- activity starts). Stored explicitly rather than inferred from token shape,
  -- because a mismatch is rejected by the provider at send time with no signal
  -- at registration time.
  kind              TEXT NOT NULL DEFAULT 'expo',

  -- The ActivityKit activity this token updates (kind =
  -- 'liveactivity_update'). A device runs several activities at once, one per
  -- live session, so device_id alone cannot identify which row to update.
  activity_id       TEXT,

  -- The session this activity renders. Sending is driven by session lifecycle
  -- transitions, so the send path looks up by session rather than by device.
  session_id        TEXT,

  -- Per-activity tokens expire. Retained rather than deleted so health can
  -- report "expired" instead of the row vanishing.
  expires_at        BIGINT,

  -- iOS ends a Live Activity ~8h after it starts. Persisted per activity
  -- because a renewal must survive a restart: re-arming timers on boot needs a
  -- durable deadline to read.
  stale_date        BIGINT,

  -- The activity's ORIGINAL start, carried unchanged across every renewal. iOS
  -- renders its own ticking timer from this, so a renewal stamping a fresh
  -- start visibly resets the user's elapsed time to zero.
  started_at        BIGINT,

  -- Set once this row has been renewed, making renewal idempotent: a restart
  -- mid-window re-arms the timer, and this is what stops a second send.
  renewed_at        BIGINT
);

-- Delivery attempts keyed by event id so a retry, a reconnect reconciliation,
-- or a duplicate trigger cannot notify the user twice for one event.
CREATE TABLE IF NOT EXISTS push_events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT,
  created_at   BIGINT NOT NULL,
  delivered_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_revoked ON push_tokens (revoked_at);
CREATE INDEX IF NOT EXISTS idx_push_events_created ON push_events (created_at);

-- The send path selects by (kind, session), driven by a status change rather
-- than by scanning every token.
CREATE INDEX IF NOT EXISTS idx_push_tokens_kind_session ON push_tokens (kind, session_id);

-- Renewal candidates only. Partial index keeps the boot-time re-arm scan
-- proportional to pending renewals, not to every token ever registered.
CREATE INDEX IF NOT EXISTS idx_push_tokens_stale_date ON push_tokens (stale_date)
  WHERE stale_date IS NOT NULL AND renewed_at IS NULL;
