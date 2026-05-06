CREATE TABLE IF NOT EXISTS managed_sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  project_name    TEXT NOT NULL,
  branch          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  prompt_count    INTEGER NOT NULL DEFAULT 0,
  last_output     TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_managed_sessions_conversation_id
  ON managed_sessions(conversation_id);
