-- conversation_meta.file_path had no index, so getIdByFilePath /
-- getProviderByFilePath (called per JSONL line from each active session's
-- watcher) were full-table scans, blocking the single-threaded event loop
-- under concurrent active sessions.
CREATE INDEX IF NOT EXISTS idx_meta_file_path ON conversation_meta(file_path);
