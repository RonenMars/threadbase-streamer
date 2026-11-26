import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ProjectsRepository } from "../src/db/repositories/projects.repository";
import { resolveProjectRoot } from "../src/utils/resolveProjectRoot";

let dir: string;
let root: string; // main checkout: .git is a directory
let wt: string; // linked worktree: .git is a file
let submodule: string;
let cache: ConversationCache;

beforeEach(() => {
  dir = join(tmpdir(), `project-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  root = join(dir, "apps", "ios", "Tabby");
  wt = join(dir, "apps", "ios", "Tabby-audio");
  submodule = join(dir, "apps", "ios", "Tabby-sub");
  mkdirSync(join(root, ".git", "worktrees", "Tabby-audio"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  mkdirSync(submodule, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "Tabby-audio")}\n`);
  writeFileSync(join(submodule, ".git"), `gitdir: ${join(root, ".git", "modules", "sub")}\n`);
  cache = ConversationCache.open(join(dir, "cache.db"));
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

const conv = (id: string, projectPath: string, timestamp: string) => ({
  id,
  sessionId: id,
  filePath: `/p/${id}.jsonl`,
  projectPath,
  projectName: projectPath.split("/").pop(),
  title: id,
  messageCount: 2,
  timestamp,
  firstMessage: null,
  lastMessage: null,
  preview: "hi",
});

describe("resolveProjectRoot", () => {
  it("a main checkout is its own root and not a worktree", () => {
    expect(resolveProjectRoot(root)).toEqual({ projectRoot: root, worktreePath: null });
  });

  it("a linked worktree resolves to the main checkout and records its own path", () => {
    expect(resolveProjectRoot(`${wt}/`)).toEqual({ projectRoot: root, worktreePath: wt });
  });

  it("does not remember a failed lookup: a path that appears later resolves", () => {
    const late = join(dir, "late");
    expect(resolveProjectRoot(late)).toBeNull();
    mkdirSync(join(late, ".git"), { recursive: true });
    expect(resolveProjectRoot(late)).toEqual({ projectRoot: late, worktreePath: null });
  });

  it("a submodule is its own project", () => {
    expect(resolveProjectRoot(submodule)).toEqual({ projectRoot: submodule, worktreePath: null });
  });

  it("a missing path or a directory with no .git resolves to nothing", () => {
    expect(resolveProjectRoot(join(dir, "gone"))).toBeNull();
    expect(resolveProjectRoot(dir)).toBeNull();
  });
});

describe("worktree grouping in the cache", () => {
  const seed = () =>
    cache.upsertFromScannerMeta([
      conv("m1", root, "2024-01-01T10:00:00.000Z"),
      conv("w1", wt, "2024-03-01T10:00:00.000Z"),
      conv("x1", "/elsewhere/proj", "2024-02-01T10:00:00.000Z"),
    ] as any);

  it("writes project_root and worktree_path on scan", () => {
    seed();
    expect(cache.getMetaById("w1")).toMatchObject({ projectRoot: root, worktreePath: wt });
    expect(cache.getMetaById("m1")).toMatchObject({ projectRoot: root, worktreePath: null });
    expect(cache.getMetaById("x1")?.projectRoot).toBeNull();
  });

  it("stores the root the scanner resolved, without looking at disk", () => {
    cache.upsertFromScannerMeta([
      {
        ...conv("s1", "/gone/wt", "2024-05-01T10:00:00.000Z"),
        projectRoot: "/gone/root",
        worktreePath: "/gone/wt",
      },
    ] as any);
    expect(cache.getMetaById("s1")).toMatchObject({
      projectRoot: "/gone/root",
      worktreePath: "/gone/wt",
    });
  });

  it("summarizes a repo and its worktrees as one project named after the root", () => {
    seed();
    const { projects, total } = cache.listProjectSummaries({ limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(projects[0]).toMatchObject({
      path: root,
      name: "apps/ios/Tabby",
      conversationCount: 2,
      lastActivity: "2024-03-01T10:00:00.000Z",
      worktreePaths: [wt],
    });
    expect(projects[1]).toMatchObject({ path: "/elsewhere/proj", worktreePaths: [] });
  });

  it("?project=<root> pages exactly what the summary row counts", () => {
    seed();
    const [tabby] = cache.listProjectSummaries({ limit: 10, offset: 0 }).projects;
    const page = cache.listConversations({ project: tabby.path, limit: 50, offset: 0 });
    expect(page.total).toBe(tabby.conversationCount);
    expect(page.conversations.map((c) => c.id).sort()).toEqual(["m1", "w1"]);
  });

  it("?project=<worktree> still pages only that worktree", () => {
    seed();
    const page = cache.listConversations({ project: wt, limit: 50, offset: 0 });
    expect(page.conversations.map((c) => c.id)).toEqual(["w1"]);
  });

  it("writes project_root for a live session's first cwd line", () => {
    cache.updateFromLines("/p/live.jsonl", [
      JSON.stringify({
        role: "user",
        cwd: wt,
        timestamp: "2024-04-01T10:00:00.000Z",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    const id = cache.getIdByFilePath("/p/live.jsonl") as string;
    expect(cache.getMetaById(id)).toMatchObject({ projectRoot: root, worktreePath: wt });
  });

  it("backfills rows written before the columns existed, on open", () => {
    seed();
    const db = cache.getDatabase();
    db.exec("UPDATE conversation_meta SET project_root = NULL, worktree_path = NULL");
    cache.close();
    cache = ConversationCache.open(join(dir, "cache.db"));
    expect(cache.getMetaById("w1")).toMatchObject({ projectRoot: root, worktreePath: wt });
  });
});

describe("ProjectsRepository", () => {
  it("records root and worktree path for a linked worktree", () => {
    const repo = new ProjectsRepository(cache.getDatabase());
    expect(repo.upsertProjectByPath(wt)).toMatchObject({ projectRoot: root, worktreePath: wt });
    expect(repo.upsertProjectByPath(root)).toMatchObject({ projectRoot: root, worktreePath: null });
  });
});
