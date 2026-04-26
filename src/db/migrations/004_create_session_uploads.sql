CREATE TABLE IF NOT EXISTS session_uploads (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  instance_id   TEXT,
  file_path     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_uploads_session_id
  ON session_uploads(session_id);
