import { mkdirSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { CacheMetadataRepository } from "../src/db/repositories/cacheMetadata.repository";
import { ConversationsRepository } from "../src/db/repositories/conversations.repository";
import { ProjectsRepository } from "../src/db/repositories/projects.repository";
import { SessionsRepository } from "../src/db/repositories/sessions.repository";
import { setCacheMetadata } from "../src/services/cache/cacheMetadata";
import { listProjectChats } from "../src/services/projectChats/listProjectChats";
import { SessionStore } from "../src/session-store";

let dbDir: string;
let projectsDir: string;
let cache: ConversationCache;
let projectsRepo: ProjectsRepository;
let conversationsRepo: ConversationsRepository;
let sessionsRepo: SessionsRepository;
let cacheMetadataRepo: CacheMetadataRepository;

// A minimal scanner stub. Each test sets the metas the scanner "would return"
// on its next scan() call so we can prove the gate triggered a rebuild.
class FakeScanner {
  metas = new Map<string, unknown>();
  scanCount = 0;

  setMetas(metas: Array<Record<string, unknown>>) {
    this.metas.clear();
    for (const m of metas) {
      this.metas.set(m.filePath as string, m);
    }
  }

  async scan() {
    this.scanCount += 1;
    return { conversations: [...this.metas.values()] };
  }

  getMetadataCache() {
    return this.metas;
  }
}

const META = (id: string, projectPath: string, ts: string) => ({
  id,
  sessionId: id,
  filePath: `/p/${id}.jsonl`,
  projectPath,
  projectName: projectPath.split("/").pop() ?? null,
  title: projectPath.split("/").pop() ?? null,
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
  dbDir = join(tmpdir(), `list-pc-refresh-${stamp}`);
  projectsDir = join(tmpdir(), `claude-projects-${stamp}`);
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  projectsRepo = new ProjectsRepository(cache.getDatabase());
  conversationsRepo = new ConversationsRepository(cache);
  sessionsRepo = new SessionsRepository(new SessionStore());
  cacheMetadataRepo = new CacheMetadataRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(projectsDir, { recursive: true, force: true });
});

const touchDir = (dir: string, when: Date) => utimesSync(dir, when, when);

describe("listProjectChats — scanner-triggered rebuild", () => {
  it("triggers a scanner pass when the projects dir is newer than last indexed", async () => {
    const scanner = new FakeScanner();
    scanner.setMetas([
      META("new-conv", "/proj/a", new Date().toISOString()) as Record<string, unknown>,
    ]);

    // Cache starts empty. Last indexed: 1h ago. Dir mtime: now.
    setCacheMetadata(
      cacheMetadataRepo,
      "conversations_last_indexed_at",
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
    touchDir(projectsDir, new Date());

    const result = await listProjectChats(
      {
        cache,
        projectsRepo,
        conversationsRepo,
        sessionsRepo,
        cacheMetadataRepo,
        getSessionResponses: () => [],
        getFreshScanner: async () => {
          await scanner.scan();
          return scanner as never;
        },
        projectsDir,
      },
      { refreshConversations: false },
    );

    expect(scanner.scanCount).toBe(1);
    expect(result.find((c) => c.type === "conversation")).toBeTruthy();
  });

  it("does not run the scanner when the cache is fresh", async () => {
    const scanner = new FakeScanner();

    // Cache has one row, with project_id already backfilled. Last indexed: now.
    // Dir mtime: 1h ago.
    cache.upsertFromScannerMeta([META("c1", "/proj/a", new Date().toISOString()) as never]);
    conversationsRepo.updateConversationProjectId({ conversationId: "c1", projectId: "p1" });
    setCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at", new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60 * 60 * 1000));

    await listProjectChats(
      {
        cache,
        projectsRepo,
        conversationsRepo,
        sessionsRepo,
        cacheMetadataRepo,
        getSessionResponses: () => [],
        getFreshScanner: async () => {
          await scanner.scan();
          return scanner as never;
        },
        projectsDir,
      },
      { refreshConversations: false },
    );

    expect(scanner.scanCount).toBe(0);
  });

  it("always runs scanner when refreshConversations=true regardless of gate", async () => {
    const scanner = new FakeScanner();
    setCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at", new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60 * 60 * 1000));

    await listProjectChats(
      {
        cache,
        projectsRepo,
        conversationsRepo,
        sessionsRepo,
        cacheMetadataRepo,
        getSessionResponses: () => [],
        getFreshScanner: async () => {
          await scanner.scan();
          return scanner as never;
        },
        projectsDir,
      },
      { refreshConversations: true },
    );

    expect(scanner.scanCount).toBe(1);
  });

  it("backfills project_id for orphan rows discovered by the scanner pass", async () => {
    const scanner = new FakeScanner();
    scanner.setMetas([
      META("c-orphan", "/proj/a", new Date().toISOString()) as Record<string, unknown>,
    ]);

    // Seed the cache with the same row already present but missing project_id.
    cache.upsertFromScannerMeta([META("c-orphan", "/proj/a", new Date().toISOString()) as never]);
    expect(conversationsRepo.hasOrphanRows()).toBe(true);

    setCacheMetadata(cacheMetadataRepo, "conversations_last_indexed_at", new Date().toISOString());
    touchDir(projectsDir, new Date(Date.now() - 60 * 60 * 1000));

    const result = await listProjectChats(
      {
        cache,
        projectsRepo,
        conversationsRepo,
        sessionsRepo,
        cacheMetadataRepo,
        getSessionResponses: () => [],
        getFreshScanner: async () => {
          await scanner.scan();
          return scanner as never;
        },
        projectsDir,
      },
      { refreshConversations: false },
    );

    expect(conversationsRepo.hasOrphanRows()).toBe(false);
    expect(result.find((c) => c.type === "conversation" && c.id === "c-orphan")).toBeTruthy();
  });
});
