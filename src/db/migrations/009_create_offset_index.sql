-- Offset index for windowed conversation-detail reads (design 1b).
-- Lets a detail/delta request do a SQL window lookup + pread of exact byte
-- ranges from the JSONL instead of re-parsing the whole file.

-- Per-file resume state: where indexing left off, and the identity used to
-- detect truncation/replacement (size < byte_offset, or a changed identity).
CREATE TABLE IF NOT EXISTS conversation_file_state (
  path               TEXT PRIMARY KEY,
  identity           TEXT NOT NULL,      -- inode (dev:ino), else fingerprint of first N bytes
  size               INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  byte_offset        INTEGER NOT NULL,   -- end of last fully-indexed line
  last_message_index INTEGER NOT NULL
);

-- One row per indexed message. Non-message lines (summary/sidecar) get no row.
-- The PK (conversation_id, message_index) covers the window select
-- WHERE conversation_id = ? AND message_index BETWEEN ? AND ?.
CREATE TABLE IF NOT EXISTS conversation_message_index (
  conversation_id TEXT    NOT NULL,
  message_index   INTEGER NOT NULL,
  byte_offset     INTEGER NOT NULL,
  byte_length     INTEGER NOT NULL,
  uuid            TEXT,
  role            TEXT,
  ts              INTEGER,
  PRIMARY KEY (conversation_id, message_index)
);
