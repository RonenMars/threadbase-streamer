-- The scanner's name slots for a session the streamer spawned, lifted from the
-- transcript the scanner reads after each turn (all providers, not only Claude):
--   title_user  - a name the user gave. Claude (/rename) and Copilot (user_named)
--                 only: a Codex rename just rewrites thread_name, the same field
--                 Codex fills with its own title, so it is NULL for Codex and Cursor
--   title_tool  - a name the agent generated (ai-title, Codex/Cursor/Copilot title)
--   last_prompt - the most recent prompt
-- NULL means none recorded yet, or the agent writes none. Unlike the cache copy
-- (cache.db, rebuildable) these survive a cache clear.
ALTER TABLE managed_sessions ADD COLUMN title_user TEXT;
ALTER TABLE managed_sessions ADD COLUMN title_tool TEXT;
ALTER TABLE managed_sessions ADD COLUMN last_prompt TEXT;
