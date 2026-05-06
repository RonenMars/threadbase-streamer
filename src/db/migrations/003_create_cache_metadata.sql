-- Generic key/value cache metadata used to decide whether to refresh
-- the projects/conversations cache. Known keys:
--   last_conversation_id
--   last_conversation_created_at
--   projects_last_indexed_at
--   conversations_last_indexed_at
--   conversations_dirty
CREATE TABLE IF NOT EXISTS cache_metadata (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
