-- Folders pinned on mobile's browse screen, shared by every device paired with
-- this streamer.
--
-- runtime.db rather than cache.db: a pin is user intent, not something a rescan
-- can rebuild, so it must survive `tb-streamer cache clear` (same reasoning as
-- saved_items).
--
-- path is absolute and canonical (canonicalizeProjectPath), the same form as
-- recent_dirs.path, so the two lists can be compared directly.
CREATE TABLE IF NOT EXISTS pinned_dirs (
  path       TEXT PRIMARY KEY,
  pinned_at  INTEGER NOT NULL
);
