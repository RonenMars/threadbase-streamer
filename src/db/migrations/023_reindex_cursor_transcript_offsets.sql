-- #929 fixed a race where a newly discovered Cursor transcript was first
-- tailed while conversation_meta still carried the default claude-code
-- provider: the offset index ran that first append through Claude's parser,
-- which rejects Cursor lines, and advanced byte_offset past them with no row.
-- The file then indexes one message short, every later message_index is off
-- by one against a full parse, and since the state sits at EOF it never heals.
-- Seen on 2 of the 4 Cursor files indexed on a real install.
--
-- #929 stops new damage; this drops the index for every agent-transcripts
-- file so the next detail read backfills it correctly. Keyed on the path, the
-- same rule #929 and the classifier use, not on the recorded provider: an
-- affected file may still be recorded as claude-code. Claude and Codex files
-- keep their warm index.
--
-- conversation_message_index is keyed by the file's basename without
-- `.jsonl` (ConversationCache.conversationIdForFile); the rtrim/replace pair
-- is SQLite's basename idiom. Paths are canonical forward-slash form.
DELETE FROM conversation_message_index
WHERE conversation_id IN (
  SELECT replace(replace(path, rtrim(path, replace(path, '/', '')), ''), '.jsonl', '')
  FROM conversation_file_state
  WHERE path LIKE '%/agent-transcripts/%'
);

DELETE FROM conversation_file_state
WHERE path LIKE '%/agent-transcripts/%';
