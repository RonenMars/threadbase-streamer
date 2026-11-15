-- Which push token wants a turn-end push for which external conversation (#1265).
--
-- A "device" here is a push token, not a `devices` row: the shared API key has
-- no device id, so a token is the only identity every client has, and it is
-- the same identity `PATCH /api/push/preferences` already uses.
--
-- Lives in cache.db beside push_tokens and push_receipts, not in runtime.db: a
-- subscription is meaningless without the token it belongs to, and both go
-- together on a cache clear. Cascades so unregistering a device (which
-- DELETEs its push_tokens row) leaves no subscription behind.
--
-- `conversation_id` is deliberately not a foreign key: an external session is a
-- conversation the cache may not have indexed yet, and the row must survive a
-- cache rescan that briefly drops it.
CREATE TABLE IF NOT EXISTS external_session_subscriptions (
  token           TEXT NOT NULL REFERENCES push_tokens(token) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,

  -- Set on subscribe and on every push sent, so retention drops a subscription
  -- that nobody has used or been notified by, never one that is still working.
  touched_at      INTEGER NOT NULL,

  PRIMARY KEY (token, conversation_id)
);

-- The notifier looks subscribers up by conversation on every turn end.
CREATE INDEX IF NOT EXISTS idx_external_session_subscriptions_conversation
  ON external_session_subscriptions (conversation_id);
