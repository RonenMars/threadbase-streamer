-- Session state is no longer persisted to the database.
-- The JSONL file on disk is the single source of truth for session identity.
-- PTY state is ephemeral (in-process memory only).
DROP TABLE IF EXISTS managed_sessions CASCADE;
