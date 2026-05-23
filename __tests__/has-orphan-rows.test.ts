import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ConversationsRepository } from "../src/db/repositories/conversations.repository";

let dbDir: string;
let cache: ConversationCache;
let repo: ConversationsRepository;

const META = (id: string, projectPath: string | null) => ({
  id,
  sessionId: id,
  filePath: `/p/${id}.jsonl`,
  projectPath,
  projectName: projectPath ? "A" : null,
  title: "A",
  model: null,
  account: null,
  gitBranch: null,
  messageCount: 1,
  timestamp: "2024-01-01T00:00:00.000Z",
  firstMessage: null,
  lastMessage: null,
  preview: null,
});

beforeEach(() => {
  dbDir = join(tmpdir(), `has-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  repo = new ConversationsRepository(cache);
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ConversationsRepository.hasOrphanRows", () => {
  it("returns false on an empty cache", () => {
    expect(repo.hasOrphanRows()).toBe(false);
  });

  it("returns true when a row has project_path but no project_id", () => {
    cache.upsertFromScannerMeta([META("c1", "/proj/a") as never]);
    expect(repo.hasOrphanRows()).toBe(true);
  });

  it("returns false after backfilling project_id on the orphan", () => {
    cache.upsertFromScannerMeta([META("c1", "/proj/a") as never]);
    repo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });
    expect(repo.hasOrphanRows()).toBe(false);
  });

  it("ignores rows that have neither project_path nor project_id (skeleton-only)", () => {
    // Such rows can be created by the chokidar watcher's insertSkeleton path
    // before a scanner pass has run. They aren't backfill-eligible, so the
    // orphan gate should not fire for them.
    cache.upsertFromScannerMeta([META("c1", null) as never]);
    expect(repo.hasOrphanRows()).toBe(false);
  });
});
