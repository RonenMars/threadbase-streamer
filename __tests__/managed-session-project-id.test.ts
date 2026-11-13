// A managed session's projectId used to live only in memory. It was set when a
// transcript bound (or by resume enrichment) and never reached runtime.db,
// whose project_id column only the spawn-time upsert wrote, before any path
// had set it. So after a restart, an adopt, a session with no prompt yet, or a
// Codex rollout that never bound, GET /api/sessions reported projectId null for
// a session whose siblings at the same path carried the project's id, and a
// client grouping by projectId split one folder into two project cards.
//
// Two halves, both covered here:
//   - the response resolves a missing projectId from the projects table by path
//     (a read never creates a project row);
//   - the link and resume paths persist projectId, so a rehydrated row has it.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import type { ProjectsRepository } from "../src/db/repositories/projects.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { rowToStubSession } from "../src/services/sessions/rehydrateSessions";
import type { ManagedSession } from "../src/types";

const API_KEY = "tb_test_managed_project_id";

interface Internals {
  sessionStore: { addManaged(s: ManagedSession): void };
  projectsRepo: ProjectsRepository | null;
  managedSessionsRepo: ManagedSessionsRepository | null;
  cache: { getMetaById(id: string): unknown } | null;
  sessionWatchers: {
    linkSessionToProject(sessionId: string, projectPath: string, filePath: string): void;
  };
  enrichResumedSessionAsync(sessionId: string, projectPath: string, conv: unknown): void;
}

function mkSession(id: string, projectPath: string, over: Partial<ManagedSession> = {}) {
  return {
    id,
    provider: "claude-code",
    projectPath,
    projectName: "proj",
    branch: "main",
    status: "waiting_input",
    startedAt: new Date("2026-11-13T10:00:00.000Z"),
    completedAt: null,
    promptCount: 3,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

describe("managed session projectId", () => {
  let dir: string;
  let projectDir: string;
  let otherDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-msp-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-msp-proj-"));
    otherDir = mkdtempSync(join(tmpdir(), "tb-msp-other-"));
  });

  afterEach(() => {
    for (const d of [dir, projectDir, otherDir]) rmSync(d, { recursive: true, force: true });
  });

  async function makeServer() {
    const { StreamerServer } = await import("../src/server");
    const server = new StreamerServer({
      port: 0,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir: join(dir, "cache"),
      runtimeDbPath: join(dir, "runtime.db"),
      browseRoot: projectDir,
      scanProfiles: [
        {
          id: "test",
          label: "Test",
          configDir: join(dir, "cfg"),
          enabled: true,
          emoji: "🧪",
        },
      ],
      scannerPersistent: false,
      codexRoots: [],
    });
    await server.listen(0, { awaitReady: true });
    const internals = server as unknown as Internals;
    if (!internals.projectsRepo || !internals.managedSessionsRepo) {
      throw new Error("test server opened without projectsRepo / managedSessionsRepo");
    }
    return {
      server,
      port: server.port,
      internals,
      projectsRepo: internals.projectsRepo,
      managedSessionsRepo: internals.managedSessionsRepo,
    };
  }

  async function listById(port: number): Promise<Map<string, Record<string, unknown>>> {
    const res = await fetch(`http://localhost:${port}/api/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const rows = (
      Array.isArray(body) ? body : (body as { sessions: unknown[] }).sessions
    ) as Record<string, unknown>[];
    return new Map(rows.map((r) => [r.id as string, r]));
  }

  async function getOne(port: number, id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`http://localhost:${port}/api/sessions/${id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it("a session with no prompt yet (no transcript, nothing linked) reports its path's project", async () => {
    const { server, port, internals } = await makeServer();
    try {
      const project = internals.projectsRepo!.upsertProjectByPath(projectDir);
      internals.sessionStore.addManaged(mkSession("no-prompt", projectDir, { promptCount: 0 }));

      expect((await getOne(port, "no-prompt")).projectId).toBe(project.id);
      expect((await listById(port)).get("no-prompt")?.projectId).toBe(project.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  // handleAdopt adds the session and only calls watchConversationFile, which
  // never links a project: the record it leaves is this one, prompted and
  // bound to nothing.
  it("an adopted session (prompted, never linked) reports its path's project", async () => {
    const { server, port, internals } = await makeServer();
    try {
      const project = internals.projectsRepo!.upsertProjectByPath(projectDir);
      internals.sessionStore.addManaged(
        mkSession("adopted", projectDir, { promptCount: 9, status: "idle" }),
      );

      expect((await getOne(port, "adopted")).projectId).toBe(project.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("sessions at one path agree on projectId, and a read never creates a project", async () => {
    const { server, port, internals } = await makeServer();
    try {
      const repo = internals.projectsRepo!;
      const project = repo.upsertProjectByPath(projectDir);
      internals.sessionStore.addManaged(mkSession("linked", projectDir, { projectId: project.id }));
      internals.sessionStore.addManaged(mkSession("unlinked", projectDir));
      // Same folder spelled with a trailing slash: canonicalization must match it.
      internals.sessionStore.addManaged(mkSession("slashed", `${projectDir}/`));
      // A folder with no project row yet.
      internals.sessionStore.addManaged(mkSession("orphan", otherDir));
      const before = repo.listProjects().length;

      const rows = await listById(port);
      expect(rows.get("linked")?.projectId).toBe(project.id);
      expect(rows.get("unlinked")?.projectId).toBe(project.id);
      expect(rows.get("slashed")?.projectId).toBe(project.id);
      expect(rows.get("orphan")).toBeDefined();
      expect(rows.get("orphan")?.projectId).toBeUndefined();
      expect(repo.listProjects().length).toBe(before);
      expect(repo.getProjectByPath(otherDir)).toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);

  // An external session is a discovered process, built by a different function
  // than the managed ones above; it must resolve the same way.
  it("external sessions report their path's project, and agree with managed ones", async () => {
    const { server, internals } = await makeServer();
    try {
      const repo = internals.projectsRepo;
      if (!repo) throw new Error("no projectsRepo");
      const project = repo.upsertProjectByPath(projectDir);
      const proc = (pid: number, conversationId: string, projectPath: string) => ({
        pid,
        provider: "claude-code" as const,
        projectPath,
        projectName: "proj",
        branch: "main",
        conversationId,
        startedAt: new Date("2026-11-13T10:00:00.000Z"),
      });
      internals.sessionStore.addManaged(mkSession("managed", projectDir));
      (
        internals.sessionStore as unknown as {
          setDiscovered(p: ReturnType<typeof proc>[]): void;
        }
      ).setDiscovered([
        proc(9001, "ext-hit", projectDir),
        // Same folder spelled with a trailing slash: canonicalization must match it.
        proc(9002, "ext-slashed", `${projectDir}/`),
        // A folder with no project row.
        proc(9003, "ext-orphan", otherDir),
      ]);
      const before = repo.listProjects().length;

      // The store directly: the list handler re-runs discovery and would
      // replace the processes set above.
      const store = internals.sessionStore as unknown as {
        list(attached: Set<string>): Record<string, unknown>[];
        get(id: string, attached: Set<string>): Record<string, unknown> | null;
      };
      const rows = new Map(store.list(new Set()).map((r) => [r.id as string, r]));
      expect(rows.get("ext-hit")?.ownership).toBe("external");
      expect(rows.get("ext-hit")?.projectId).toBe(project.id);
      expect(rows.get("ext-slashed")?.projectId).toBe(project.id);
      expect(rows.get("ext-hit")?.projectId).toBe(rows.get("managed")?.projectId);
      expect(rows.get("ext-orphan")).toBeDefined();
      expect(rows.get("ext-orphan")?.projectId).toBeUndefined();
      expect(store.get("ext-hit", new Set())?.projectId).toBe(project.id);
      expect(repo.listProjects().length).toBe(before);
      expect(repo.getProjectByPath(otherDir)).toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("linking a session to its project persists project_id, so a restart rehydrates it", async () => {
    const { server, internals } = await makeServer();
    try {
      const session = mkSession("bound", projectDir);
      internals.sessionStore.addManaged(session);
      internals.managedSessionsRepo!.recordSpawn({
        session,
        pid: null,
        cmdline: "claude",
        streamerInstanceId: "test",
      });

      internals.sessionWatchers.linkSessionToProject("bound", projectDir, "/tmp/bound.jsonl");

      const project = internals.projectsRepo!.getProjectByPath(projectDir);
      expect(project).not.toBeNull();
      const row = internals.managedSessionsRepo!.get("bound");
      expect(row?.project_id).toBe(project!.id);
      // What the next boot builds from that row.
      expect(rowToStubSession(row!).projectId).toBe(project!.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("boot backfills project_id on rows that predate the fix", async () => {
    const first = await makeServer();
    let project: { id: string };
    try {
      project = first.projectsRepo.upsertProjectByPath(projectDir);
      // Rows as an older streamer left them: project_id null.
      for (const [id, path] of [
        ["old-hit", projectDir],
        ["old-miss", otherDir],
      ] as const) {
        first.managedSessionsRepo.recordSpawn({
          session: mkSession(id, path),
          pid: null,
          cmdline: "claude",
          streamerInstanceId: "test",
        });
      }
    } finally {
      await first.server.close();
    }

    const second = await makeServer();
    try {
      const repo = second.managedSessionsRepo;
      expect(repo.get("old-hit")?.project_id).toBe(project.id);
      expect(repo.get("old-miss")?.project_id).toBeNull();
      // A backfill resolves; it never creates a project.
      expect(second.projectsRepo.getProjectByPath(otherDir)).toBeNull();
    } finally {
      await second.server.close();
    }
  }, 60_000);

  it("resume enrichment persists project_id", async () => {
    const { server, internals } = await makeServer();
    try {
      const session = mkSession("resumed", projectDir);
      internals.sessionStore.addManaged(session);
      internals.managedSessionsRepo!.recordSpawn({
        session,
        pid: null,
        cmdline: "claude",
        streamerInstanceId: "test",
      });
      if (internals.cache) {
        vi.spyOn(internals.cache, "getMetaById").mockReturnValue({
          projectId: "proj-cached",
        });
      }

      internals.enrichResumedSessionAsync("resumed", projectDir, null);

      expect(internals.managedSessionsRepo!.get("resumed")?.project_id).toBe("proj-cached");
    } finally {
      await server.close();
    }
  }, 30_000);
});

describe("ManagedSessionsRepository.recordProjectId", () => {
  let dir: string;
  let store: RuntimeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-msp-repo-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the column the spawn-time upsert left null", () => {
    const repo = new ManagedSessionsRepository(store.getDatabase());
    repo.recordSpawn({
      session: mkSession("s1", "/repo"),
      pid: 1,
      cmdline: "claude",
      streamerInstanceId: "test",
    });
    expect(repo.get("s1")?.project_id).toBeNull();

    repo.recordProjectId("s1", "proj-1");

    expect(repo.get("s1")?.project_id).toBe("proj-1");
    expect(rowToStubSession(repo.get("s1")!).projectId).toBe("proj-1");
  });
});

describe("ManagedSessionsRepository.backfillProjectIds", () => {
  let dir: string;
  let store: RuntimeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-msp-backfill-"));
    store = RuntimeStore.open(join(dir, "runtime.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function spawn(repo: ManagedSessionsRepository, id: string, path: string, projectId?: string) {
    repo.recordSpawn({
      session: mkSession(id, path, projectId ? { projectId } : {}),
      pid: 1,
      cmdline: "claude",
      streamerInstanceId: "test",
    });
  }

  it("fills a null project_id from the lookup, leaves a miss null, never overwrites", () => {
    const repo = new ManagedSessionsRepository(store.getDatabase());
    spawn(repo, "hit", "/repo/a");
    spawn(repo, "miss", "/repo/none");
    spawn(repo, "set", "/repo/a", "already");
    const lookup = (path: string) => (path === "/repo/a" ? "proj-a" : undefined);

    expect(repo.backfillProjectIds(lookup)).toBe(1);
    expect(repo.get("hit")?.project_id).toBe("proj-a");
    expect(repo.get("miss")?.project_id).toBeNull();
    expect(repo.get("set")?.project_id).toBe("already");
    // Idempotent: a second pass has nothing left to fill.
    expect(repo.backfillProjectIds(lookup)).toBe(0);
  });
});
