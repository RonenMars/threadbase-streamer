-- Persist enough scanner output to reuse unchanged files on the next startup
-- scan. The scanner stat cache needs both file stats and the corresponding
-- ConversationMeta; mtime_ms/file_size alone are not sufficient.
ALTER TABLE conversation_meta ADD COLUMN scanner_meta_json TEXT;

-- File-level metadata is separate from conversation_meta so agent files that
-- are intentionally filtered out can still keep their classification cached.
CREATE TABLE IF NOT EXISTS conversation_file_metadata (
  file_path             TEXT PRIMARY KEY,
  mtime_ms              REAL NOT NULL,
  file_size             INTEGER NOT NULL,
  is_agent              INTEGER NOT NULL,
  agent_entrypoints_key TEXT NOT NULL,
  updated_at            INTEGER NOT NULL
);
