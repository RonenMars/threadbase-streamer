ALTER TABLE managed_sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE managed_sessions ADD COLUMN parent_conversation_id TEXT NULL;
