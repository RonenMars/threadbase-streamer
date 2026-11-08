-- The model and reasoning effort a Claude session was spawned with, as Claude
-- resolves them: the last --model / --effort on the final argv, which can be
-- one inside claude_extra_args rather than the one the streamer passed first.
-- NULL means unknown (other providers, and rows written before this existed).
--
-- Persisted so a held, restarted or rehydrated session still reports them.
ALTER TABLE managed_sessions ADD COLUMN model TEXT;
ALTER TABLE managed_sessions ADD COLUMN effort TEXT;
