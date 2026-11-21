-- Message-body search text per conversation, so a restarted streamer can seed the
-- scanner's in-memory index. Without it a stat-cache hit skips the parse and the
-- conversation is indexed with an empty body, leaving only metadata searchable.
-- Rebuildable from the transcripts, so it lives with the cache, not runtime.db.
CREATE TABLE IF NOT EXISTS conversation_search_text (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
