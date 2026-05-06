-- Add project_id to conversation_meta. SQLite cannot ADD COLUMN with
-- a foreign key constraint after the fact, so we keep it as a plain TEXT
-- and enforce the relationship in code (see projects repository).
ALTER TABLE conversation_meta ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_project_id
  ON conversation_meta(project_id);

-- Sessions are stored in-memory by SessionStore, not in SQLite. We do not
-- add a sessions table here; ManagedSession.projectId is added to the
-- in-memory shape in src/types.ts and propagated through SessionStore.
