-- Heal the legacy 'threadbase' provider default left in the streamer cache by an
-- older scanner-era schema. 'threadbase' is not a real runner (only 'claude-code'
-- and 'codex-cli' exist), so any conversation carrying it 501s on resume
-- ("Live threadbase sessions are not implemented yet"). Every such row is a
-- Claude Code conversation mislabeled by the old default. Mirrors the scanner's
-- own v2->v3 fix-up, which only ran against the scanner DB and never touched this cache.
UPDATE conversation_meta SET provider = 'claude-code' WHERE provider = 'threadbase';
