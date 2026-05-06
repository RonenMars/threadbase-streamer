import type Database from "better-sqlite3";

export type CacheMetadataKey =
  | "last_conversation_id"
  | "last_conversation_created_at"
  | "projects_last_indexed_at"
  | "conversations_last_indexed_at"
  | "conversations_dirty";

export class CacheMetadataRepository {
  private get: Database.Statement;
  private upsert: Database.Statement;
  private del: Database.Statement;

  constructor(db: Database.Database) {
    this.get = db.prepare("SELECT value FROM cache_metadata WHERE key = ?");
    this.upsert = db.prepare(`
      INSERT INTO cache_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.del = db.prepare("DELETE FROM cache_metadata WHERE key = ?");
  }

  getCacheMetadata(key: CacheMetadataKey): string | null {
    const row = this.get.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCacheMetadata(key: CacheMetadataKey, value: string): void {
    this.upsert.run(key, value, new Date().toISOString());
  }

  deleteCacheMetadata(key: CacheMetadataKey): void {
    this.del.run(key);
  }
}
