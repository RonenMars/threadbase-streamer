-- Projects table: canonical normalized project identity.
-- Project discovery is conversation-driven; rows are upserted as
-- conversations are scanned from disk.
CREATE TABLE IF NOT EXISTS projects (
  id                            TEXT PRIMARY KEY,
  path                          TEXT NOT NULL UNIQUE,
  name                          TEXT,

  -- Conversation-based indexing metadata.
  last_conversation_id          TEXT,
  last_conversation_created_at  TEXT,
  last_indexed_at               TEXT,

  -- Project-level activity metadata.
  latest_message_at             TEXT,
  latest_message_id             TEXT,
  message_count                 INTEGER DEFAULT 0,

  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
