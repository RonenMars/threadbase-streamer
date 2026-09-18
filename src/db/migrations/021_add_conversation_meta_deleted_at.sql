-- Soft-delete tombstone for conversation_meta: NULL means visible, an epoch-ms
-- timestamp means deleted from the streamer's cache (never the on-disk JSONL).
-- Every list/get read path must exclude deleted_at IS NOT NULL rows; every
-- upsert must leave the column alone so a rescan doesn't resurrect a deleted
-- conversation whose file is still on disk.
ALTER TABLE conversation_meta ADD COLUMN deleted_at INTEGER;
