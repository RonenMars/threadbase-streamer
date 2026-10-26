import { cpSync, mkdtempSync, rmSync } from "fs";
import { Hono } from "hono";
import { tmpdir } from "os";
import { join } from "path";
import { createRecentDirsRoutes } from "../src/api/routes/recent-dirs.routes";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import {
  RECENT_DIRS_MAX,
  RecentDirsRepository,
  recentDirsFor,
} from "../src/db/repositories/recent-dirs.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { resolveMigrationsDir } from "../src/db/sqlite-migrate";
import { requiredCapability } from "../src/services/security/capabilities";
import { SessionRegistryBoot } from "../src/session-registry-boot";
import type { ManagedSession } from "../src/types";

let dir: string;
let store: RuntimeStore;
let repo: RecentDirsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-recent-dirs-"));
  store = RuntimeStore.open(join(dir, "runtime.db"));
  repo = new RecentDirsRepository(store.getDatabase());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("RecentDirsRepository", () => {
  it("lists newest first and counts repeat use of one directory", () => {
    repo.touch("/a", "claude-code", 1000);
    repo.touch("/b", "codex", 2000);
    repo.touch("/a/", undefined, 3000);

    expect(repo.list()).toEqual([
      {
        path: "/a",
        lastUsedAt: new Date(3000).toISOString(),
        useCount: 2,
        provider: "claude-code",
      },
      { path: "/b", lastUsedAt: new Date(2000).toISOString(), useCount: 1, provider: "codex" },
    ]);
  });

  it("never moves a directory back in time", () => {
    repo.touch("/a", "claude-code", 5000);
    repo.touch("/a", "codex", 1000);
    expect(repo.list()[0]).toMatchObject({
      lastUsedAt: new Date(5000).toISOString(),
      provider: "codex",
    });
  });

  it("ignores a blank path", () => {
    repo.touch("  ", "claude-code");
    expect(repo.list()).toEqual([]);
  });

  it(`keeps only the newest ${RECENT_DIRS_MAX}`, () => {
    for (let i = 0; i <= RECENT_DIRS_MAX; i++) repo.touch(`/p${i}`, "claude-code", i);
    const paths = repo.list().map((d) => d.path);
    expect(paths).toHaveLength(RECENT_DIRS_MAX);
    expect(paths).not.toContain("/p0");
    expect(paths[0]).toBe(`/p${RECENT_DIRS_MAX}`);
  });

  it("survives a reopen of runtime.db", () => {
    repo.touch("/a", "claude-code", 1000);
    store.close();
    store = RuntimeStore.open(join(dir, "runtime.db"));
    expect(
      recentDirsFor(store)
        ?.list()
        .map((d) => d.path),
    ).toEqual(["/a"]);
  });
});

describe("migration 007", () => {
  it("seeds the list from sessions already in the registry", () => {
    // Bring a database up to 006 only, record sessions, then apply 007.
    const partial = join(dir, "migrations-pre-007");
    cpSync(resolveMigrationsDir("runtime-migrations"), partial, {
      recursive: true,
      filter: (src) => !src.endsWith("007_create_recent_dirs.sql"),
    });
    const dbPath = join(dir, "seeded.db");
    const before = RuntimeStore.open(dbPath, partial);
    const sessions = new ManagedSessionsRepository(before.getDatabase());
    const spawn = (id: string, projectPath: string, at: number, provider: string) =>
      sessions.recordSpawn({
        session: {
          id,
          provider,
          projectPath,
          projectName: "p",
          branch: "main",
          status: "idle",
          startedAt: new Date(at),
          completedAt: null,
          promptCount: 1,
          lastOutput: "",
        } as ManagedSession,
        pid: null,
        cmdline: null,
        streamerInstanceId: "inst",
      });
    spawn("s1", "/old", 1000, "codex");
    spawn("s2", "/repo/", 2000, "codex");
    spawn("s3", "/repo", 3000, "claude-code");
    before.close();

    const after = RuntimeStore.open(dbPath);
    expect(new RecentDirsRepository(after.getDatabase()).list()).toEqual([
      {
        path: "/repo",
        lastUsedAt: new Date(3000).toISOString(),
        useCount: 2,
        provider: "claude-code",
      },
      { path: "/old", lastUsedAt: new Date(1000).toISOString(), useCount: 1, provider: "codex" },
    ]);
    after.close();
  });
});

describe("GET /api/recent-dirs", () => {
  const app = () => {
    const a = new Hono();
    a.route("/api/recent-dirs", createRecentDirsRoutes({ runtimeStore: () => store } as never));
    return a;
  };

  it("returns the list and honours limit", async () => {
    repo.touch("/a", "claude-code", 1000);
    repo.touch("/b", "claude-code", 2000);

    const all = await (await app().request("/api/recent-dirs")).json();
    expect(all.dirs.map((d: { path: string }) => d.path)).toEqual(["/b", "/a"]);

    const one = await (await app().request("/api/recent-dirs?limit=1")).json();
    expect(one.dirs).toHaveLength(1);
  });

  it("answers 503 without runtime.db", async () => {
    const a = new Hono();
    a.route("/", createRecentDirsRoutes({ runtimeStore: () => null } as never));
    expect((await a.request("/")).status).toBe(503);
  });

  it("is a browse read", () => {
    expect(requiredCapability("/api/recent-dirs", "GET")).toBe("fs:browse");
  });
});

describe("recording at spawn", () => {
  const session = { id: "s1", provider: "codex", projectPath: "/repo/" } as ManagedSession;
  const boot = (recentDirsRepo: () => RecentDirsRepository | null, warn = vi.fn()) =>
    new SessionRegistryBoot({
      log: () => ({ warn, info: vi.fn() }),
      managedSessionsRepo: () => null,
      recentDirsRepo,
    } as never);

  it("records the session's directory", () => {
    boot(() => repo).recordSessionSpawn(session);
    expect(repo.list()).toMatchObject([{ path: "/repo", provider: "codex", useCount: 1 }]);
  });

  it("never fails a spawn over it", () => {
    const warn = vi.fn();
    const broken = {
      touch: () => {
        throw new Error("disk full");
      },
    } as unknown as RecentDirsRepository;
    expect(() => boot(() => broken, warn).recordSessionSpawn(session)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "registry.recent_dir_write_failed" }),
    );
  });
});
