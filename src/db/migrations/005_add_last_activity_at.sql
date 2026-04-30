ALTER TABLE managed_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
