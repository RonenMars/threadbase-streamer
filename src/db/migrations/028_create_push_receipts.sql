-- Expo push tickets awaiting a delivery receipt (#543).
--
-- A ticket of status "ok" only says Expo's relay accepted the message. The
-- delivery outcome is behind POST /--/api/v2/push/getReceipts, available about
-- 15 minutes later and retained by Expo for about 24 hours. The ticket id is
-- kept here until the receipt resolves or the retention passes.
--
-- Lives in cache.db beside push_tokens, not in runtime.db: it is meaningless
-- without the token it belongs to, and both go together on a cache clear.
CREATE TABLE IF NOT EXISTS push_receipts (
  ticket_id      TEXT PRIMARY KEY,

  -- The token the ticket was issued for. Cascades so that unregistering a
  -- device (which DELETEs its push_tokens row) leaves no copy of the credential
  -- behind in this table.
  token          TEXT NOT NULL REFERENCES push_tokens(token) ON DELETE CASCADE,

  sent_at        INTEGER NOT NULL,

  -- Set when a poll asked Expo about this id and got no receipt. Orders the
  -- next batch so ids Expo does not know cannot starve newer ones.
  last_polled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_push_receipts_sent_at ON push_receipts (sent_at);
