import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { CacheMetadataRepository } from "../src/db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "../src/db/repositories/conversations.repository";
import { shouldRefreshProjectsFromHdd } from "../src/services/conversations/shouldRefreshProjectsFromHdd";

let dbDir: string;
let cache: ConversationCache;
let conversationsRepo: ConversationsRepository;
let cacheMetadataRepo: CacheMetadataRepository;

const META = (id: string, ts: string) => ({
  id,
  sessionId: id,
  filePath: `/p/${id}.jsonl`,
  projectPath: "/proj/a",
  projectName: "A",
  title: "A",
  model: null,
  account: null,
  gitBranch: null,
  messageCount: 1,
  timestamp: ts,
  firstMessage: null,
  lastMessage: null,
  preview: null,
});

beforeEach(() => {
  dbDir = join(tmpdir(), `should-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  conversationsRepo = new ConversationsRepository(cache);
  cacheMetadataRepo = new CacheMetadataRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("shouldRefreshProjectsFromHdd", () => {
  it("returns false when there are no conversations", () => {
    expect(shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo)).toBe(false);
  });

  it("returns true when latest HDD id differs from cached", () => {
    cache.upsertFromScannerMeta([META("c1", "2024-01-01T00:00:00.000Z") as any]);
    cacheMetadataRepo.setCacheMetadata("last_conversation_id", "DIFFERENT");
    expect(shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo)).toBe(true);
  });

  it("returns false when latest HDD id matches cached", () => {
    cache.upsertFromScannerMeta([META("c1", "2024-01-01T00:00:00.000Z") as any]);
    cacheMetadataRepo.setCacheMetadata("last_conversation_id", "c1");
    expect(shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo)).toBe(false);
  });
});
