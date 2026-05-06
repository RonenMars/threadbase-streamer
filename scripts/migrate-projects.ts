#!/usr/bin/env tsx
/**
 * Idempotent backfill script:
 *   1. Apply SQLite schema migrations.
 *   2. Read existing conversation_meta rows.
 *   3. Upsert one project per unique canonical project_path.
 *   4. Backfill conversation_meta.project_id where missing.
 *   5. Update cache_metadata.last_conversation_id.
 *   6. Print a summary.
 *
 * Sessions are in-memory at runtime, so they are not backfilled here;
 * they get their projectId via the live session-creation/resume flow.
 */
import { homedir } from "os";
import { join } from "path";
import { ConversationCache } from "../src/conversation-cache";
// scripts/migrate-projects.ts uses ConversationCache.open which resolves
// migrations relative to the compiled module location; no __dirname needed.
import { CacheMetadataRepository } from "../src/db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "../src/db/repositories/conversations.repository";
import { ProjectsRepository } from "../src/db/repositories/projects.repository";
import { refreshConversationCache } from "../src/services/conversations/refreshConversationCache";

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function main(): void {
  const dbPath = parseArg("--db") ?? join(homedir(), ".threadbase", "cache", "cache.db");

  console.log(`Opening cache at ${dbPath}`);
  const cache = ConversationCache.open(dbPath);
  const db = cache.getDatabase();

  const projectsRepo = new ProjectsRepository(db);
  const conversationsRepo = new ConversationsRepository(cache);
  const cacheMetadataRepo = new CacheMetadataRepository(db);

  const before = conversationsRepo.listConversationsForProjectBackfill();
  const beforeWithProjectId = before.filter((c) => c.projectId).length;

  const result = refreshConversationCache({
    cache,
    projectsRepo,
    conversationsRepo,
    cacheMetadataRepo,
  });

  const after = conversationsRepo.listConversationsForProjectBackfill();
  const afterWithProjectId = after.filter((c) => c.projectId).length;

  console.log("Projects migration complete:");
  console.log(`- conversations scanned:                ${before.length}`);
  console.log(`- projects touched:                    ${result.projectsTouched}`);
  console.log(`- conversations backfilled:            ${result.conversationsBackfilled}`);
  console.log(`- conversations with project_id (was): ${beforeWithProjectId}`);
  console.log(`- conversations with project_id (now): ${afterWithProjectId}`);
  console.log(`- last conversation id:                ${result.latestConversationId ?? "(none)"}`);

  cache.close();
}

main();
