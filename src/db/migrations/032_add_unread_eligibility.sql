-- Which indexed messages can be unread, and the newest such timestamp per
-- conversation. Existing rows stay 0 / NULL: the read-state baseline (runtime
-- migration 012) makes all earlier history read, so nothing needs a backfill.
ALTER TABLE conversation_message_index ADD COLUMN counts_for_unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_meta ADD COLUMN last_countable_ts INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_message_index_countable
  ON conversation_message_index (conversation_id, ts) WHERE counts_for_unread = 1;
