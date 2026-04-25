ALTER TABLE managed_sessions
  ADD COLUMN IF NOT EXISTS instance_id TEXT;

CREATE INDEX IF NOT EXISTS idx_managed_sessions_instance_id
  ON managed_sessions(instance_id);
