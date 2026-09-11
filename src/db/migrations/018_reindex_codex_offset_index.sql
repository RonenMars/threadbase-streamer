-- Codex offset-index rows written before the leading-injected-context filter
-- reached the index writer counted Codex's AGENTS.md / sandbox preamble as a
-- message. The detail handler never served it, so those rows number the same
-- file one higher than the API does from the first real turn onward.
--
-- Reading a stale row set now would serve the preamble as a real message and
-- shift every genuine message_index by one -- the bug #824 gated around. Drop
-- the Codex rows so the existing backfill-on-miss path rebuilds them post-filter.
-- Claude rows are untouched: Claude has no such filter, so its index space never
-- differed from its served space.
--
-- Deleting file_state too is what forces the rebuild: readMessageWindow declines
-- without it, which routes the caller to backfillIndex.
DELETE FROM conversation_message_index
WHERE conversation_id IN (
  SELECT id FROM conversation_meta WHERE provider = 'codex-cli'
);

DELETE FROM conversation_file_state
WHERE path IN (
  SELECT file_path FROM conversation_meta WHERE provider = 'codex-cli' AND file_path IS NOT NULL
);
