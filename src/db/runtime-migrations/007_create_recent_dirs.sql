-- Directories sessions were started in, newest first, for mobile's
-- "Recent directories" list.
--
-- Mobile used to derive that list from GET /api/sessions, which after a restart
-- holds only the sessions the registry rehydrates — so every directory whose
-- sessions had ended dropped off the list. This table is written at every spawn
-- (start, resume, fork, adopt) and survives restarts and `cache clear`.
--
-- path is canonical (canonicalizeProjectPath: trimmed, no trailing separator).
CREATE TABLE IF NOT EXISTS recent_dirs (
  path          TEXT PRIMARY KEY,
  last_used_at  INTEGER NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 1,
  provider      TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_dirs_last_used ON recent_dirs (last_used_at DESC);

-- Seed from the session registry, so the list is not empty on the first boot
-- after upgrading. SQLite returns the bare `provider` column from the row that
-- holds MAX(started_at).
INSERT OR IGNORE INTO recent_dirs (path, last_used_at, use_count, provider)
SELECT rtrim(trim(project_path), '/\'), MAX(started_at), COUNT(*), provider
FROM managed_sessions
WHERE rtrim(trim(project_path), '/\') <> ''
GROUP BY rtrim(trim(project_path), '/\');
