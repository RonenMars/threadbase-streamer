-- Saved (favorite) sessions and conversations, shared by every device paired
-- with this streamer.
--
-- runtime.db rather than cache.db: a saved list is user intent, not something a
-- rescan of ~/.claude or ~/.codex can rebuild, so it must survive
-- `tb-streamer cache clear` and the integrity monitor's reset-and-rescan.
--
-- item_key is derived from the item's kind and ids (`session::<id>`,
-- `conversation::<id>`, `project-chat::<chatType>::<chatId>`), never from the
-- client's local server id: that id is a hash of the URL the phone paired with,
-- so the same streamer reached over LAN and over a tunnel has two of them.
CREATE TABLE IF NOT EXISTS saved_items (
  item_key           TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('session', 'conversation', 'project-chat')),
  label              TEXT NOT NULL,
  session_id         TEXT NULL,
  conversation_id    TEXT NULL,
  chat_type          TEXT NULL CHECK (chat_type IS NULL OR chat_type IN ('session', 'conversation')),
  chat_id            TEXT NULL,
  project_id         TEXT NULL,
  position           INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  -- The authenticated device that last wrote the row; NULL for the shared API
  -- key. Diagnostics only — nothing authorizes on it.
  updated_by_device  TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_items_position ON saved_items (position);

-- One row: bumped by every write so a client can tell whether its copy is
-- current without diffing the list.
CREATE TABLE IF NOT EXISTS saved_items_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  revision  INTEGER NOT NULL
);

INSERT OR IGNORE INTO saved_items_meta (id, revision) VALUES (1, 0);
