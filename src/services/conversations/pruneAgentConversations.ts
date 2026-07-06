import { existsSync } from "fs";
import type { ConversationCache } from "../../conversation-cache";

export interface PruneAgentConversationsResult {
  scanned: number;
  pruned: number;
  missing: number;
}

// Walks conversation_meta once at startup and deletes any row whose JSONL has
// the sdk-cli marker. Idempotent. Safe to call on every boot — the second run
// will simply find nothing to delete.
export function pruneAgentConversations(cache: ConversationCache): PruneAgentConversationsResult {
  const db = cache.getDatabase();
  const rows = db.prepare("SELECT id, file_path FROM conversation_meta").all() as Array<{
    id: string;
    file_path: string;
  }>;

  let pruned = 0;
  let missing = 0;
  for (const row of rows) {
    if (!existsSync(row.file_path)) {
      missing += 1;
      continue;
    }
    if (cache.isAgentFileCached(row.file_path)) {
      cache.deleteByFilePath(row.file_path);
      pruned += 1;
    }
  }

  return { scanned: rows.length, pruned, missing };
}
