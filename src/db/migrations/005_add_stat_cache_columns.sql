-- Stat-based scan cache: skip full parseMeta on files whose size and mtime
-- haven't changed since the last scan. Both columns are NULL for rows written
-- before this migration; the next scan will backfill them on the first parse.
ALTER TABLE conversation_meta ADD COLUMN mtime_ms  INTEGER;
ALTER TABLE conversation_meta ADD COLUMN file_size INTEGER;
