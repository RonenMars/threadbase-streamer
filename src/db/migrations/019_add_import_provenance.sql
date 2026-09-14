ALTER TABLE conversation_meta ADD COLUMN is_imported_from_claude INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_meta ADD COLUMN is_imported_from_codex INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_meta ADD COLUMN is_imported_from_cursor INTEGER NOT NULL DEFAULT 0;
