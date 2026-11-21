-- Claude Code's peer name per conversation: the `name` it keeps in
-- ~/.claude/sessions/<pid>.json (set by /rename, or derived), read on each
-- process-discovery sweep.
--
-- runtime.db rather than cache.db: the registry file is deleted when the
-- process exits, so a rescan cannot rebuild the last name seen.
--
-- Keyed by conversation_id because names are not unique: two live sessions can
-- carry the same one.
CREATE TABLE IF NOT EXISTS session_peer_names (
  conversation_id  TEXT PRIMARY KEY,
  peer_name        TEXT NOT NULL,
  peer_name_source TEXT,
  name_since       INTEGER,
  pid              INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
