-- The scanner resolves a session's name from several slots and keeps them in
-- ConversationMeta.nameSlots, which until now lived only inside
-- scanner_meta_json. Lift the three that identify a session to columns so it
-- can be found by them without parsing every row. All providers fill them;
-- NULL where the agent records none.
--   title_user  - a name the user gave (Claude /rename, Copilot user_named)
--   title_tool  - a name the agent generated (ai-title, Codex/Cursor/Copilot title)
--   last_prompt - the most recent prompt
ALTER TABLE conversation_meta ADD COLUMN title_user TEXT;
ALTER TABLE conversation_meta ADD COLUMN title_tool TEXT;
ALTER TABLE conversation_meta ADD COLUMN last_prompt TEXT;

UPDATE conversation_meta
   SET title_user  = json_extract(scanner_meta_json, '$.nameSlots.userTitle'),
       title_tool  = json_extract(scanner_meta_json, '$.nameSlots.toolTitle'),
       last_prompt = json_extract(scanner_meta_json, '$.nameSlots.lastPrompt')
 WHERE scanner_meta_json IS NOT NULL
   AND json_valid(scanner_meta_json);
