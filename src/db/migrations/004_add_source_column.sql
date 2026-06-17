-- Identifies the origin of a conversation.
-- 'streamer' = spawned via tb-streamer PTY session.
-- NULL = discovered by scanner (user ran claude in a terminal, VS Code, etc.)
ALTER TABLE conversation_meta ADD COLUMN source TEXT;
