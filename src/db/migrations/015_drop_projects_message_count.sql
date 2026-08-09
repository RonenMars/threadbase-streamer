-- projects.message_count was written as 0 on insert and never updated by
-- anything, and no code or endpoint ever read it back. A column that always
-- reads 0 is worse than an absent one: it invites a caller to trust it.
--
-- Conversation counts per project come from conversation_meta (the same rows
-- /api/conversations pages), which is where a count can be consistent with
-- what a client renders.
ALTER TABLE projects DROP COLUMN message_count;
