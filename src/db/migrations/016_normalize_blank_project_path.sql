-- A JSONL scanned with no `cwd` line yields an empty-string project_path,
-- not a null one. hasOrphanProjectId (project_id IS NULL AND project_path IS
-- NOT NULL) matches "", and the backfill in refreshConversationCache refuses
-- to overwrite a falsy-but-non-null projectPath — so a row like this can
-- never self-heal and permanently forces a full reconcile on every scan.
-- Idempotent: a rerun matches zero rows once these are NULL.
UPDATE conversation_meta SET project_path = NULL WHERE project_path = '';
