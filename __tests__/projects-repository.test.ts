import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ProjectsRepository } from "../src/db/repositories/projects.repository";

let dbDir: string;
let cache: ConversationCache;
let repo: ProjectsRepository;

beforeEach(() => {
  dbDir = join(tmpdir(), `projects-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  repo = new ProjectsRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ProjectsRepository", () => {
  it("inserts a new project on first upsert", () => {
    const project = repo.upsertProjectByPath("/a/b");
    expect(project.path).toBe("/a/b");
    expect(project.id).toMatch(/[0-9a-f-]{36}/i);
  });

  it("returns the same project for the same path on second upsert", () => {
    const a = repo.upsertProjectByPath("/a/b");
    const b = repo.upsertProjectByPath("/a/b");
    expect(b.id).toBe(a.id);
  });

  it("dedupes project paths that differ only by trailing slash", () => {
    const a = repo.upsertProjectByPath("/a/b/");
    const b = repo.upsertProjectByPath("/a/b");
    expect(b.id).toBe(a.id);
  });

  it("does not merge case-different paths", () => {
    const a = repo.upsertProjectByPath("/a/b");
    const b = repo.upsertProjectByPath("/A/B");
    expect(b.id).not.toBe(a.id);
  });

  it("getProjectByPath finds by canonical path", () => {
    const created = repo.upsertProjectByPath("/a/b");
    const found = repo.getProjectByPath("/a/b/");
    expect(found?.id).toBe(created.id);
  });

  it("upsert updates lastConversationId on subsequent calls", () => {
    repo.upsertProjectByPath("/a/b", { lastConversationId: "conv-1" });
    const updated = repo.upsertProjectByPath("/a/b", { lastConversationId: "conv-2" });
    expect(updated.lastConversationId).toBe("conv-2");
  });

  it("listProjects returns inserted rows", () => {
    repo.upsertProjectByPath("/p1");
    repo.upsertProjectByPath("/p2");
    expect(repo.listProjects()).toHaveLength(2);
  });
});
