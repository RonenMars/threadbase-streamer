-- Directories a session was spawned with beyond project_path (`--add-dir`),
-- as a JSON array of absolute paths. NULL means none.
--
-- Persisted because nothing else records them: Claude's JSONL and Codex's
-- rollout keep the working directory but not the extra directories, so resume
-- and auto-resume would otherwise respawn the session without them.
ALTER TABLE managed_sessions ADD COLUMN additional_paths TEXT;
