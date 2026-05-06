import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ProjectsRepository } from "../src/db/repositories/projects.repository";
import { ensureProjectsForConversations } from "../src/services/projects/ensureProjectsForConversations";

let dbDir: string;
let cache: ConversationCache;
let repo: ProjectsRepository;

beforeEach(() => {
  dbDir = join(tmpdir(), `ensure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  repo = new ProjectsRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ensureProjectsForConversations", () => {
  it("creates one project per unique canonical project path", () => {
    const map = ensureProjectsForConversations(repo, [
      { id: "c1", projectPath: "/proj/a" },
      { id: "c2", projectPath: "/proj/a/" },
      { id: "c3", projectPath: "/proj/b" },
    ]);
    expect(map.size).toBe(2);
    expect(repo.listProjects()).toHaveLength(2);
  });

  it("ignores conversations without projectPath", () => {
    const map = ensureProjectsForConversations(repo, [
      { id: "c1", projectPath: null },
      { id: "c2", projectPath: undefined },
    ]);
    expect(map.size).toBe(0);
    expect(repo.listProjects()).toHaveLength(0);
  });

  it("is idempotent across runs", () => {
    ensureProjectsForConversations(repo, [{ id: "c1", projectPath: "/proj/a" }]);
    ensureProjectsForConversations(repo, [{ id: "c1", projectPath: "/proj/a" }]);
    expect(repo.listProjects()).toHaveLength(1);
  });

  it("picks the latest conversation per project for lastConversationId", () => {
    ensureProjectsForConversations(repo, [
      { id: "c-old", projectPath: "/p", latestMessageAt: "2024-01-01T00:00:00.000Z" },
      { id: "c-new", projectPath: "/p", latestMessageAt: "2024-06-01T00:00:00.000Z" },
    ]);
    const project = repo.getProjectByPath("/p");
    expect(project?.lastConversationId).toBe("c-new");
  });
});
