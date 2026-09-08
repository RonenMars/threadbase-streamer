ALTER TABLE conversation_meta ADD COLUMN has_messages INTEGER NULL CHECK (has_messages IN (0, 1));
ALTER TABLE conversation_meta ADD COLUMN is_subagent INTEGER NULL CHECK (is_subagent IN (0, 1));
ALTER TABLE conversation_meta ADD COLUMN parent_conversation_id TEXT NULL;
