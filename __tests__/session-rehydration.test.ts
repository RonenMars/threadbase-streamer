// Phase 1 of the live-sessions persistence plan: sessions a previous streamer
// run left behind come back into GET /api/sessions as recoverable stubs.
//
// The regression this exists to prevent is subtle: recordShutdownState() stamps
// completed_at on every live session as the streamer stops, which is exactly
// what removes the row from the reconciler's probe set — so the sessions most
// worth recovering were the ones nothing looked at.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import {
  REHYDRATE_MAX,
  REHYDRATE_WINDOW_MS,
  rehydrateSkipReason,
  rowToStubSession,
} from "../src/services/sessions/rehydrateSessions";
import { SessionStore } from "../src/session-store";
import type { SessionStatus } from "../src/types";

vi.mock("node-pty", () => {
  const { EventEmitter } = require("events");
  function makeMockProcess() {
    const ee = new EventEmitter();
    setImmediate(() => ee.emit("data", "╭\n"));
    return {
      pid: 99999,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const NOW = new Date("2026-07-31T12:00:00Z").getTime();

function mkRow(over: Partial<ManagedSessionRow> = {}): ManagedSessionRow {
  return {
    session_id: "sess-1",
    provider: "claude-code",
    pid: 4242,
    cmdline: "claude --resume sess-1",
    project_path: "/repo",
    project_name: "repo",
    branch: "main",
    status: "idle",
    status_source: "shutdown",
    status_updated_at: NOW - 60_000,
    started_at: NOW - 3_600_000,
    completed_at: NOW - 60_000,
    last_activity_at: NOW - 120_000,
    prompt_count: 7,
    session_name: "long refactor",
    project_id: "proj-1",
    bound_conversation_id: null,
    resumed_from_conversation_id: null,
    failure_reason: null,
    streamer_instance_id: "instance-1",
    ...over,
  };
}

const exists = () => true;
const missing = () => false;

describe("rehydrateSkipReason", () => {
  it("recovers a session the streamer itself stopped", () => {
    expect(rehydrateSkipReason(mkRow(), { now: NOW, projectExists: exists })).toBeNull();
  });

  it("skips a row whose project directory is gone", () => {
    // handleResume would fail to spawn there, so offering it is a wasted tap.
    expect(rehydrateSkipReason(mkRow(), { now: NOW, projectExists: missing })).toBe(
      "project_missing",
    );
  });

  it("skips a row older than the window", () => {
    const row = mkRow({ status_updated_at: NOW - REHYDRATE_WINDOW_MS - 1 });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBe("too_old");
  });

  it("keeps a row right at the window edge", () => {
    const row = mkRow({ status_updated_at: NOW - REHYDRATE_WINDOW_MS });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBeNull();
  });

  it("skips a session the agent ended on its own", () => {
    for (const status_source of ["exit", "process-exit"]) {
      const row = mkRow({ status_source, failure_reason: null });
      expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBe("agent_exited");
    }
  });

  it("still recovers an agent exit that recorded a failure", () => {
    // That one was cut short, so there is something left to resume.
    const row = mkRow({ status_source: "exit", failure_reason: "claude binary not found" });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBeNull();
  });

  it("skips a Codex row that never bound a rollout id", () => {
    // Nothing can resume it: `codex resume <placeholder>` fails (G6).
    const row = mkRow({ provider: "codex-cli", bound_conversation_id: null });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBe("codex_unbound");
  });

  it("recovers a Codex row that did bind", () => {
    const row = mkRow({ provider: "codex-cli", bound_conversation_id: "rollout-9" });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBeNull();
  });

  it("recovers a crashed row that never got a shutdown write", () => {
    const row = mkRow({ status: "running", status_source: "transition", completed_at: null });
    expect(rehydrateSkipReason(row, { now: NOW, projectExists: exists })).toBeNull();
  });
});

describe("rowToStubSession", () => {
  it("carries the metadata a restart used to lose", () => {
    const s = rowToStubSession(mkRow({ bound_conversation_id: "rollout-9" }));
    expect(s.id).toBe("sess-1");
    expect(s.sessionName).toBe("long refactor");
    expect(s.projectPath).toBe("/repo");
    expect(s.projectName).toBe("repo");
    expect(s.branch).toBe("main");
    expect(s.promptCount).toBe(7);
    expect(s.projectId).toBe("proj-1");
    expect(s.boundConversationId).toBe("rollout-9");
    expect(s.startedAt.getTime()).toBe(NOW - 3_600_000);
    expect(s.rehydrated).toBe(true);
  });

  it("reports idle, never a new status value", () => {
    // A new SessionStatus would be rejected by VALID_STATUSES on ?status= and
    // dropped by SessionStore.paginate's filter, making recovered sessions
    // vanish from already-shipped mobile clients.
    expect(rowToStubSession(mkRow({ status: "running" })).status).toBe("idle");
  });

  it("keeps the shutdown provenance but not a crashed row's stale source", () => {
    expect(rowToStubSession(mkRow()).statusSource).toBe("shutdown");
    // `transition` described a `running` status we are not emitting; copying it
    // would attach observed confidence to a value derived at boot.
    const crashed = rowToStubSession(mkRow({ status: "running", status_source: "transition" }));
    expect(crashed.statusSource).toBeUndefined();
  });

  it("carries what the session was doing when we stopped it", () => {
    // `status` has to flatten to `idle`; this is the one bit that would
    // otherwise be lost — whether the agent was mid-answer.
    for (const status of ["running", "waiting_input"] as const) {
      const s = rowToStubSession(mkRow({ status, status_source: "shutdown" }));
      expect(s.status).toBe("idle");
      expect(s.interruptedStatus).toBe(status);
    }
  });

  it("sets no interruptedStatus for a crash or a genuinely idle shutdown", () => {
    // A crashed row's `running` is a frozen value nobody confirmed — reporting
    // it as an interrupted turn would be an observation we never made.
    const crashed = rowToStubSession(mkRow({ status: "running", status_source: "transition" }));
    expect(crashed.interruptedStatus).toBeUndefined();

    const wasIdle = rowToStubSession(mkRow({ status: "idle", status_source: "shutdown" }));
    expect(wasIdle.interruptedStatus).toBeUndefined();
  });
});

describe("a rehydrated stub in SessionStore", () => {
  // The managedToResponse mapping itself lives in session-store.test.ts; this
  // covers the one property specific to rehydration — a resume must replace the
  // stub rather than list a second row beside it.
  it("is replaced, not duplicated, when a real session takes the same id", () => {
    const store = new SessionStore();
    store.addManaged(rowToStubSession(mkRow()));
    store.addManaged({
      id: "sess-1",
      projectPath: "/repo",
      projectName: "repo",
      branch: "main",
      status: "running",
      startedAt: new Date(NOW),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
    });

    const list = store.list(new Set(["sess-1"]));
    expect(list).toHaveLength(1);
    expect(list[0].ownership).toBe("managed");
    expect(list[0].lifecycle).toBe("attached");
  });
});

// ── boot integration ─────────────────────────────────────────────────────────

async function getRandomPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const API_KEY = "tb_test_session_rehydration";
const UUID = "cccccccc-1111-2222-3333-444444444444";

interface SessionListItem {
  id: string;
  status: string;
  ownership?: string;
  lifecycle?: string;
  ptyAttached: boolean;
  promptCount: number;
  sessionName?: string;
  projectPath: string;
  interruptedStatus?: string;
}

describe("boot rehydration", () => {
  let configDir: string;
  let projectDir: string;
  let cacheDir: string;
  let runtimeDir: string;
  let runtimeDbPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "tb-rehydrate-cfg-"));
    projectDir = mkdtempSync(join(tmpdir(), "tb-rehydrate-proj-"));
    cacheDir = mkdtempSync(join(tmpdir(), "tb-rehydrate-cache-"));
    runtimeDir = mkdtempSync(join(tmpdir(), "tb-rehydrate-runtime-"));
    runtimeDbPath = join(runtimeDir, "runtime.db");

    const encoded = projectDir.replace(/[/\\:.]/g, "-");
    const jsonlDir = join(configDir, "projects", encoded);
    mkdirSync(jsonlDir, { recursive: true });
    writeFileSync(
      join(jsonlDir, `${UUID}.jsonl`),
      `${JSON.stringify({ sessionId: UUID, cwd: projectDir, type: "user", message: "hi" })}\n`,
    );
  });

  afterEach(() => {
    for (const d of [configDir, projectDir, cacheDir, runtimeDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * Write the rows a previous streamer run would have left, then close the
   * database — the honest simulation of a restart is a second process opening
   * the same file.
   */
  function seedRegistry(
    sessions: {
      id: string;
      projectPath: string;
      name?: string;
      ageMs?: number;
      /** What the session was doing when the streamer stopped it. */
      status?: SessionStatus;
    }[],
  ): void {
    const store = RuntimeStore.open(runtimeDbPath);
    const repo = new ManagedSessionsRepository(store.getDatabase());
    for (const s of sessions) {
      repo.recordSpawn({
        session: {
          id: s.id,
          provider: "claude-code",
          projectPath: s.projectPath,
          projectName: "proj",
          branch: "main",
          status: "running",
          startedAt: new Date(Date.now() - 600_000),
          completedAt: null,
          promptCount: 4,
          lastOutput: "",
          sessionName: s.name ?? "recovered session",
        },
        pid: 999_999,
        cmdline: `claude --resume ${s.id}`,
        streamerInstanceId: "previous-run",
      });
      // What close() writes for every live session on the way out. This is the
      // write that used to make the session disappear. It records the session's
      // live status, not a flattened `idle` — `completed_at` is what makes the
      // row terminal.
      repo.recordStatus(s.id, s.status ?? "idle", "shutdown", {
        completedAt: new Date(Date.now() - (s.ageMs ?? 1_000)),
        promptCount: 4,
      });
    }
    // A shutdown row's status_updated_at is stamped by recordStatus at write
    // time, so backdate it directly when the test needs an old row.
    for (const s of sessions) {
      if (s.ageMs == null) continue;
      store
        .getDatabase()
        .prepare("UPDATE managed_sessions SET status_updated_at = ? WHERE session_id = ?")
        .run(Date.now() - s.ageMs, s.id);
    }
    store.close();
  }

  async function makeServer(over: Record<string, unknown> = {}) {
    const { StreamerServer } = await import("../src/server");
    const port = await getRandomPort();
    const server = new StreamerServer({
      port,
      apiKey: API_KEY,
      localNoAuth: false,
      verbose: false,
      disableDb: true,
      cacheDir,
      runtimeDbPath,
      scanProfiles: [{ id: "test", label: "Test", configDir, enabled: true, emoji: "🧪" }],
      scannerPersistent: false,
      codexRoots: [],
      ...over,
    });
    await server.listen(port, { awaitReady: true });
    return { server, port };
  }

  function api(port: number, path: string) {
    return fetch(`http://localhost:${port}${path}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  // A bare GET /api/sessions answers the legacy plain array. It can also carry
  // processes discovered on the host running the suite, so every assertion here
  // is scoped to the ids this test seeded rather than to the list length.
  async function listSessions(port: number): Promise<SessionListItem[]> {
    return (await (await api(port, "/api/sessions")).json()) as SessionListItem[];
  }

  /** Rehydration is chained off a fire-and-forget reconcile, so poll for it. */
  async function seededWhenSettled(port: number, expected: number): Promise<SessionListItem[]> {
    let seeded: SessionListItem[] = [];
    for (let i = 0; i < 100; i++) {
      seeded = (await listSessions(port)).filter((s) => s.ownership === "historical");
      if (seeded.length >= expected) return seeded;
      await new Promise((r) => setTimeout(r, 20));
    }
    return seeded;
  }

  it("lists an interrupted session with its metadata, and keeps it out of the count", async () => {
    seedRegistry([{ id: UUID, projectPath: projectDir, name: "yesterday's work" }]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);
      const sessions = await listSessions(port);
      const recovered = sessions.find((s) => s.id === UUID);
      expect(recovered).toBeDefined();
      expect(recovered?.status).toBe("idle");
      expect(recovered?.ownership).toBe("historical");
      expect(recovered?.lifecycle).toBe("resumable");
      expect(recovered?.ptyAttached).toBe(false);
      expect(recovered?.promptCount).toBe(4);
      expect(recovered?.sessionName).toBe("yesterday's work");
      expect(recovered?.projectPath).toBe(projectDir);

      // The badge means "sessions this streamer is running" — recovering a
      // session must not inflate it.
      const count = (await (await api(port, "/api/sessions/count")).json()) as { total: number };
      expect(count.total).toBe(sessions.filter((s) => s.ownership !== "historical").length);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("survives ?status= filtering, because it reports an existing status value", async () => {
    // The reason no new SessionStatus was introduced: paginate() drops anything
    // outside the requested set, so a novel value would make recovered sessions
    // vanish from already-shipped clients that filter.
    seedRegistry([{ id: UUID, projectPath: projectDir }]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);

      const idle = (await (await api(port, "/api/sessions?status=idle")).json()) as {
        sessions: SessionListItem[];
      };
      expect(idle.sessions.map((s) => s.id)).toContain(UUID);

      const running = (await (await api(port, "/api/sessions?status=running")).json()) as {
        sessions: SessionListItem[];
      };
      expect(running.sessions.map((s) => s.id)).not.toContain(UUID);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("does not list a session whose project directory was deleted", async () => {
    const gone = "dddddddd-1111-2222-3333-444444444444";
    seedRegistry([
      { id: UUID, projectPath: projectDir },
      { id: gone, projectPath: join(tmpdir(), "tb-rehydrate-deleted-worktree") },
    ]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);
      const ids = (await listSessions(port)).map((s) => s.id);
      expect(ids).toContain(UUID);
      expect(ids).not.toContain(gone);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("does not list a session older than the rehydration window", async () => {
    seedRegistry([{ id: UUID, projectPath: projectDir, ageMs: REHYDRATE_WINDOW_MS + 60_000 }]);
    const { server, port } = await makeServer();
    try {
      // Nothing to wait for; give the chained rehydration a moment to run.
      await new Promise((r) => setTimeout(r, 300));
      expect((await listSessions(port)).map((s) => s.id)).not.toContain(UUID);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("caps the number of recovered sessions", async () => {
    const seeds = Array.from({ length: REHYDRATE_MAX + 5 }, (_, i) => ({
      id: `eeeeeeee-1111-2222-3333-${String(i).padStart(12, "0")}`,
      projectPath: projectDir,
    }));
    seedRegistry(seeds);
    const { server, port } = await makeServer();
    try {
      const recovered = await seededWhenSettled(port, REHYDRATE_MAX);
      expect(recovered).toHaveLength(REHYDRATE_MAX);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("reproduces the old behaviour exactly when the flag is off", async () => {
    seedRegistry([{ id: UUID, projectPath: projectDir }]);
    const { server, port } = await makeServer({ featureFlags: { sessionRehydration: false } });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect((await listSessions(port)).map((s) => s.id)).not.toContain(UUID);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("keeps stubs out of the idle reaper and the grace timer", async () => {
    seedRegistry([{ id: UUID, projectPath: projectDir }]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);

      // Both iterate ptyManager.listSessions(), which a stub never enters. Ask
      // the reaper to sweep far into the future and the grace timer to fire now.
      const internals = server as unknown as {
        reapIdleSessions: (now: number) => string[];
        startGraceTimer: (id: string, delayMs: number) => void;
      };
      expect(internals.reapIdleSessions(Date.now() + 30 * 24 * 60 * 60 * 1000)).toEqual([]);
      internals.startGraceTimer(UUID, 0);
      await new Promise((r) => setTimeout(r, 50));

      expect((await listSessions(port)).map((s) => s.id)).toContain(UUID);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("resumes a recovered session without a spurious CONVERSATION_BUSY", async () => {
    // The JSONL was written moments ago — by us, on the way out. Without the
    // selfPtyEndedAt seeding this is the single most common resume in the
    // product and it would 409 (plan risk R3).
    seedRegistry([{ id: UUID, projectPath: projectDir }]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);

      const res = await fetch(`http://localhost:${port}/api/sessions/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ sessionId: UUID }),
      });
      expect(res.status).toBe(201);

      // The stub is replaced by the live session, not listed alongside it.
      const rows = (await listSessions(port)).filter((s) => s.id === UUID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownership).toBe("managed");
      expect(rows[0].ptyAttached).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);

  // Phase 5 acceptance: a session interrupted mid-turn says so.
  it("reports interruptedStatus for a session stopped mid-response", async () => {
    seedRegistry([{ id: UUID, projectPath: projectDir, status: "running" }]);
    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);
      const recovered = (await listSessions(port)).find((s) => s.id === UUID);

      // `status` still reports the existing vocabulary, so filtering clients
      // are untouched; the extra bit rides alongside it.
      expect(recovered?.status).toBe("idle");
      expect(recovered?.interruptedStatus).toBe("running");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("records the live status at shutdown instead of flattening it to idle", async () => {
    // The write half of interruptedStatus. recordShutdownState() used to write a
    // hardcoded `idle`, which erased the only signal a stub cannot re-derive —
    // so the field would have been permanently null.
    seedRegistry([{ id: UUID, projectPath: projectDir }]);
    const { server, port } = await makeServer();
    await seededWhenSettled(port, 1);

    const res = await fetch(`http://localhost:${port}/api/sessions/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ sessionId: UUID }),
    });
    expect(res.status).toBe(201);
    // The mocked PTY emits a prompt marker, so the session settles here.
    const live = (await listSessions(port)).find((s) => s.id === UUID);
    expect(live?.status).toBe("waiting_input");

    await server.close();

    const store = RuntimeStore.open(runtimeDbPath);
    try {
      const row = new ManagedSessionsRepository(store.getDatabase()).get(UUID);
      expect(row?.status_source).toBe("shutdown");
      expect(row?.status).toBe("waiting_input");
      // Still terminal — that is completed_at's job, not the status's.
      expect(row?.completed_at).not.toBeNull();
    } finally {
      store.close();
    }
  }, 60_000);

  // Phase 5: GET /api/sessions shows the outcome; this shows the reasoning.
  // The rows worth explaining are exactly the ones absent from the session list.
  it("explains every registry row over GET /api/diagnostics/sessions", async () => {
    const GONE = "bbbbbbbb-1111-4222-8333-555555555555";
    seedRegistry([
      { id: UUID, projectPath: projectDir },
      { id: GONE, projectPath: join(projectDir, "deleted-subdir") },
    ]);

    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);

      const res = await api(port, "/api/diagnostics/sessions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: {
          sessionId: string;
          rehydrated: boolean;
          rehydrateSkipReason: string | null;
          projectExists: boolean;
          projectPath: string;
          statusSource: string;
          recordedThisBoot: boolean;
        }[];
      };

      const recovered = body.sessions.find((s) => s.sessionId === UUID);
      // A real boolean, not the string "[redacted]". The field was previously
      // named `bootTokenMatches`, which redactValue's SECRET_KEY_RE scrubbed
      // because the key contained "token" — shipping a useless field that no
      // type check could catch, since the payload is serialized JSON.
      expect(typeof recovered?.recordedThisBoot).toBe("boolean");
      expect(JSON.stringify(body)).not.toContain("[redacted]");

      expect(recovered?.rehydrated).toBe(true);
      expect(recovered?.rehydrateSkipReason).toBeNull();
      expect(recovered?.projectExists).toBe(true);
      expect(recovered?.statusSource).toBe("shutdown");

      // The row that never made it into GET /api/sessions, and why.
      const skipped = body.sessions.find((s) => s.sessionId === GONE);
      expect(skipped?.rehydrated).toBe(false);
      expect(skipped?.rehydrateSkipReason).toBe("project_missing");

      // Paste-into-a-bug-report safe: paths are reduced to their tail, never
      // full. Asserted on the deeper of the two paths — the shallow one is
      // `/tmp/<dir>` on Linux CI, which redactPath passes through unchanged
      // because there is nothing above the last two segments to drop.
      expect(skipped?.projectPath).toMatch(/^…\//);
      expect(skipped?.projectPath).not.toContain(projectDir);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("answers 503 rather than pretending the registry is empty", async () => {
    // An unopenable runtime.db is exactly when someone reaches for diagnostics;
    // an empty list would read as "no sessions" and send them the wrong way.
    const { server, port } = await makeServer({ runtimeDbPath: join(runtimeDir, "nope", "r.db") });
    try {
      const res = await api(port, "/api/diagnostics/sessions");
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("REGISTRY_UNAVAILABLE");
    } finally {
      await server.close();
    }
  }, 30_000);

  // Phase 4: the registry is authoritative and never rebuilt, so nothing else
  // would ever remove a row — without retention it grows for the life of the
  // install and every boot pays for it.
  it("prunes terminal rows past the retention window on boot", async () => {
    const OLD = "aaaaaaaa-1111-4222-8333-444444444444";
    seedRegistry([
      { id: OLD, projectPath: projectDir, ageMs: 40 * 24 * 3_600_000 },
      { id: UUID, projectPath: projectDir },
    ]);

    const { server, port } = await makeServer();
    try {
      await seededWhenSettled(port, 1);

      const store = RuntimeStore.open(runtimeDbPath);
      const repo = new ManagedSessionsRepository(store.getDatabase());
      try {
        // Pruning is chained off the same fire-and-forget boot promise.
        for (let i = 0; i < 100 && repo.get(OLD) != null; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(repo.get(OLD)).toBeNull();
        // The recent one is history the user can still act on.
        expect(repo.get(UUID)).not.toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await server.close();
    }
  }, 30_000);
});
