-- Claude Code stamps a word-style slug on a session's transcript lines. The
-- scanner keeps it in ConversationMeta.nameSlots.slug, which until now lived
-- only inside scanner_meta_json, so a session could not be found by it without
-- parsing every row. NULL when the transcript carries none (not every build or
-- session writes one), and for every non-Claude provider.
ALTER TABLE conversation_meta ADD COLUMN slug TEXT;

UPDATE conversation_meta
   SET slug = json_extract(scanner_meta_json, '$.nameSlots.slug')
 WHERE scanner_meta_json IS NOT NULL
   AND json_valid(scanner_meta_json)
   AND json_extract(scanner_meta_json, '$.nameSlots.slug') IS NOT NULL;
