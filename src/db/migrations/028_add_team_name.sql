-- A Claude teammate transcript (an agent a lead session spawned into a team)
-- carries teamName on its records; the lead's own transcript never does. The
-- scanner lifts it onto ConversationMeta; this keeps it on the list row so a
-- client can tell a teammate from the human session next to it. NULL for
-- every other conversation.
ALTER TABLE conversation_meta ADD COLUMN team_name TEXT;
