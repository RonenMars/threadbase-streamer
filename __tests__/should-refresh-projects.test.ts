import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { CacheMetadataRepository } from "../src/db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "../src/db/repositories/conversations.repository";
import { setCacheMetadata } from "../src/services/cache/cacheMetadata";
import { shouldRefreshProjectsFromHdd } from "../src/services/conversations/shouldRefreshProjectsFromHdd";

let dbDir: string;
let projectsDir: string;
let cache: ConversationCache;
let conversationsRepo: ConversationsRepository;
let cacheMetadataRepo: CacheMetadataRepository;

const META_WITH_PATH = (id: string, ts: string, projectPath: string) => ({
  id,
  sessionId: id,
  filePath: `/p/${id}.jsonl`,
  projectPath,
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
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbDir = join(tmpdir(), `should-refresh-${stamp}`);
  projectsDir = join(tmpdir(), `claude-projects-${stamp}`);
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  conversationsRepo = new ConversationsRepository(cache);
  cacheMetadataRepo = new CacheMetadataRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(projectsDir, { recursive: true, force: true });
});

const setIndexedAt = (iso: string) =>
  setCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at", iso);

const touchDir = (dir: string, when: Date) => utimesSync(dir, when, when);

describe("shouldRefreshProjectsFromHdd", () => {
  it("returns false when cache is empty and disk has no projects dir", () => {
    rmSync(projectsDir, { recursive: true, force: true });
    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(false);
  });

  it("returns true when a cache row has project_path but no project_id (orphan)", () => {
    cache.upsertFromScannerMeta([
      META_WITH_PATH("c1", "2024-01-01T00:00:00.000Z", "/proj/a") as never,
    ]);
    setIndexedAt(new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60_000));

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(true);
  });

  it("returns true when projects dir mtime is newer than conversations_last_indexed_at", () => {
    cache.upsertFromScannerMeta([
      META_WITH_PATH("c1", "2024-01-01T00:00:00.000Z", "/proj/a") as never,
    ]);
    conversationsRepo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    setIndexedAt(oneHourAgo.toISOString());
    touchDir(projectsDir, new Date());

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(true);
  });

  it("returns false when no orphans and projects dir mtime is older than last indexed", () => {
    cache.upsertFromScannerMeta([
      META_WITH_PATH("c1", "2024-01-01T00:00:00.000Z", "/proj/a") as never,
    ]);
    conversationsRepo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });

    setIndexedAt(new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60 * 60 * 1000));

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(false);
  });

  it("returns true when conversations_last_indexed_at has never been set but disk has files", () => {
    writeFileSync(join(projectsDir, "marker"), "x");

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(true);
  });

  it("returns true when a child project dir mtime is newer than last indexed (parent unchanged)", () => {
    cache.upsertFromScannerMeta([
      META_WITH_PATH("c1", "2024-01-01T00:00:00.000Z", "/proj/a") as never,
    ]);
    conversationsRepo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });

    const childDir = join(projectsDir, "-existing-project");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, "new.jsonl"), "{}\n");

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    setIndexedAt(oneHourAgo.toISOString());
    // Parent stays old; only the child project directory is new (new JSONL).
    touchDir(projectsDir, oneHourAgo);
    touchDir(childDir, new Date());

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(true);
  });

  it("returns false when child dirs are older than last indexed even if a nested file is newer", () => {
    cache.upsertFromScannerMeta([
      META_WITH_PATH("c1", "2024-01-01T00:00:00.000Z", "/proj/a") as never,
    ]);
    conversationsRepo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });

    const childDir = join(projectsDir, "-existing-project");
    mkdirSync(childDir, { recursive: true });
    const jsonl = join(childDir, "c1.jsonl");
    writeFileSync(jsonl, "{}\n");

    setIndexedAt(new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60_000));
    touchDir(childDir, new Date(Date.now() - 60_000));
    // Append-style growth: file mtime newer, directory mtimes unchanged.
    utimesSync(jsonl, new Date(), new Date());

    expect(
      shouldRefreshProjectsFromHdd(conversationsRepo, cacheMetadataRepo, { projectsDir }),
    ).toBe(false);
  });
});
