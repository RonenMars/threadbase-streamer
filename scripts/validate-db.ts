#!/usr/bin/env tsx
/**
 * Validation report over the SQLite cache. Prints rows that look wrong
 * after the projects migration:
 *   - conversations missing project_id
 *   - duplicate project paths
 *   - conversations referencing a project_id that no longer exists
 *
 * Sessions live in-memory and are not persisted to SQLite, so they are
 * not part of this report.
 */
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function main(): void {
  const dbPath = parseArg("--db") ?? join(homedir(), ".threadbase", "cache", "cache.db");
  const db = new Database(dbPath, { readonly: true });

  const conversationsMissing = db
    .prepare("SELECT id, project_path FROM conversation_meta WHERE project_id IS NULL")
    .all() as Array<{ id: string; project_path: string | null }>;

  const duplicatePaths = db
    .prepare("SELECT path, COUNT(*) AS n FROM projects GROUP BY path HAVING n > 1")
    .all() as Array<{ path: string; n: number }>;

  const orphanedConversations = db
    .prepare(
      `SELECT cm.id, cm.project_id
         FROM conversation_meta cm
    LEFT JOIN projects p ON p.id = cm.project_id
        WHERE cm.project_id IS NOT NULL AND p.id IS NULL`,
    )
    .all() as Array<{ id: string; project_id: string }>;

  console.log("=== conversation_meta missing project_id ===");
  console.log(`count: ${conversationsMissing.length}`);
  for (const row of conversationsMissing) {
    console.log(`  ${row.id}  project_path=${row.project_path ?? "(null)"}`);
  }

  console.log("\n=== duplicate projects.path ===");
  console.log(`count: ${duplicatePaths.length}`);
  for (const row of duplicatePaths) {
    console.log(`  ${row.path}  ×${row.n}`);
  }

  console.log("\n=== conversations with orphaned project_id ===");
  console.log(`count: ${orphanedConversations.length}`);
  for (const row of orphanedConversations) {
    console.log(`  ${row.id}  project_id=${row.project_id}`);
  }

  db.close();

  const anyIssue =
    conversationsMissing.length > 0 ||
    duplicatePaths.length > 0 ||
    orphanedConversations.length > 0;
  if (anyIssue) process.exit(1);
}

main();
