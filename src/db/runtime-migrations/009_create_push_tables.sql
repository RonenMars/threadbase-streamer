-- Push delivery state, moved here from cache.db (cache migrations 012, 013,
-- 024-029 carry each column's rationale; this is their final shape).
--
-- cache.db is deleted by `tb-streamer cache clear` and rebuilt by the integrity
-- monitor. A push token comes back on the app's next launch, but an external
-- session subscription is re-sent only when that conversation is opened again,
-- so a cache clear silently ended every followed session's pushes. The four
-- tables move together because receipts and subscriptions cascade from
-- push_tokens, and a foreign key cannot cross database files.
--
-- RuntimeStore.importLegacyPush moves existing rows across once. The cache-side
-- tables are still created by the cache migrations, as that copy's source.

CREATE TABLE IF NOT EXISTS push_tokens (
  token                 TEXT PRIMARY KEY,
  platform              TEXT NOT NULL,
  device_id             TEXT,
  registered_at         INTEGER NOT NULL,
  last_success_at       INTEGER,
  last_failure_at       INTEGER,
  last_failure_code     TEXT,
  failure_streak        INTEGER NOT NULL DEFAULT 0,
  revoked_at            INTEGER,
  kind                  TEXT NOT NULL DEFAULT 'expo',
  activity_id           TEXT,
  session_id            TEXT,
  expires_at            INTEGER,
  stale_date            INTEGER,
  started_at            INTEGER,
  renewed_at            INTEGER,
  client_server_id      TEXT,
  locale                TEXT,
  notification_prefs    TEXT,
  notification_features TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_revoked ON push_tokens (revoked_at);
CREATE INDEX IF NOT EXISTS idx_push_tokens_kind_session ON push_tokens (kind, session_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_stale_date ON push_tokens (stale_date)
  WHERE stale_date IS NOT NULL AND renewed_at IS NULL;

CREATE TABLE IF NOT EXISTS push_events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_events_created ON push_events (created_at);

CREATE TABLE IF NOT EXISTS push_receipts (
  ticket_id      TEXT PRIMARY KEY,
  token          TEXT NOT NULL REFERENCES push_tokens(token) ON DELETE CASCADE,
  sent_at        INTEGER NOT NULL,
  last_polled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_receipts_sent_at ON push_receipts (sent_at);

CREATE TABLE IF NOT EXISTS external_session_subscriptions (
  token           TEXT NOT NULL REFERENCES push_tokens(token) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  touched_at      INTEGER NOT NULL,
  PRIMARY KEY (token, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_external_session_subscriptions_conversation
  ON external_session_subscriptions (conversation_id);
