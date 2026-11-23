-- Read acks for the unread dot, shared by every device paired with this
-- streamer. runtime.db, not cache.db: an ack is user intent that no rescan can
-- rebuild (same reasoning as saved_items).
CREATE TABLE IF NOT EXISTS message_reads (
  conversation_id TEXT    NOT NULL,
  message_key     TEXT    NOT NULL,   -- uuid, else "ts:<epoch ms>"
  message_ts      INTEGER NOT NULL,   -- transcript timestamp, epoch ms
  read_at         INTEGER NOT NULL,   -- when the first ack arrived
  read_by_device  TEXT    NULL,       -- diagnostics only, as in saved_items
  PRIMARY KEY (conversation_id, message_key)
);

-- The read point per conversation, derived from the acks in the same
-- transaction that writes them.
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id TEXT PRIMARY KEY,
  frontier        INTEGER NOT NULL,   -- epoch ms
  updated_at      INTEGER NOT NULL
);

-- One row: conversations with no row count as read through this instant.
CREATE TABLE IF NOT EXISTS conversation_reads_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  baseline  INTEGER NOT NULL
);
INSERT OR IGNORE INTO conversation_reads_meta (id, baseline)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
