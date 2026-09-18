-- Scanner 0.19.0 renders Codex tool calls, tool outputs and reasoning summaries,
-- and Cursor tool-only lines, as messages. The offset index numbers messages
-- with that parser, so every Codex/Cursor file indexed before the bump is
-- numbered under the old rule: message_index values that disagree with what the
-- detail endpoint now serves. Drop those rows; the next detail read backfills
-- them (backfillIndex treats a missing file_state row as cold). Claude files
-- parse exactly as before and keep their warm index.
--
-- conversation_message_index is keyed by conversation id, which is the file's
-- basename without `.jsonl` (ConversationCache.conversationIdForFile). The
-- rtrim/replace pair is SQLite's basename idiom; paths are canonical
-- forward-slash form, the invariant both writers of file_path keep.
DELETE FROM conversation_message_index
WHERE conversation_id IN (
  SELECT replace(replace(path, rtrim(path, replace(path, '/', '')), ''), '.jsonl', '')
  FROM conversation_file_state
  WHERE path IN (
    SELECT file_path FROM conversation_meta WHERE provider IN ('codex-cli', 'cursor', 'cursor-cli')
  )
);

DELETE FROM conversation_file_state
WHERE path IN (
  SELECT file_path FROM conversation_meta WHERE provider IN ('codex-cli', 'cursor', 'cursor-cli')
);
