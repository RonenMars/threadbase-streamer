import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ManagedSessionsRepository,
  PROBE_SET_MAX,
  TERMINAL_RETENTION_MS,
} from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import type { ManagedSession } from "../src/types";

let dbDir: string;
let store: RuntimeStore;
let repo: ManagedSessionsRepository;

const STARTED = new Date("2026-07-24T10:00:00Z");

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    provider: "claude-code",
    projectPath: "/repo",
    projectName: "repo",
    branch: "main",
    status: "running",
    startedAt: STARTED,
    completedAt: null,
    promptCount: 3,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

beforeEach(() => {
  dbDir = join(tmpdir(), `managed-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  store = RuntimeStore.open(join(dbDir, "runtime.db"));
  repo = new ManagedSessionsRepository(store.getDatabase());
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("ManagedSessionsRepository", () => {
  it("persists the metadata a restart currently loses", () => {
    repo.recordSpawn({
      session: mkSession({
        sessionName: "my session",
        projectId: "proj-9",
        boundConversationId: "rollout-42",
        resumedFromConversationId: "prev-7",
      }),
      pid: 4242,
      cmdline: "claude --resume sess-1",
      streamerInstanceId: "inst-a",
    });

    const row = repo.get("sess-1");
    expect(row).not.toBeNull();
    // These are exactly the fields that vanish today when the process restarts.
    expect(row?.started_at).toBe(STARTED.getTime());
    expect(row?.prompt_count).toBe(3);
    expect(row?.session_name).toBe("my session");
    expect(row?.project_id).toBe("proj-9");
    expect(row?.bound_conversation_id).toBe("rollout-42");
    expect(row?.resumed_from_conversation_id).toBe("prev-7");
    expect(row?.pid).toBe(4242);
    expect(row?.streamer_instance_id).toBe("inst-a");
  });

  it("upserts rather than duplicating when the same session respawns", () => {
    repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "claude --resume sess-1",
      streamerInstanceId: "inst-a",
    });
    repo.recordSpawn({
      session: mkSession({ promptCount: 9 }),
      pid: 2,
      cmdline: "claude --resume sess-1",
      streamerInstanceId: "inst-b",
    });

    expect(repo.listNonTerminal()).toHaveLength(1);
    expect(repo.get("sess-1")?.pid).toBe(2);
    expect(repo.get("sess-1")?.prompt_count).toBe(9);
    expect(repo.get("sess-1")?.streamer_instance_id).toBe("inst-b");
  });

  // status_source is required, not defaulted: the reconciler decides how far to
  // trust a stored status by how it was obtained.
  it("records the provenance of a status transition", () => {
    repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "c",
      streamerInstanceId: "inst-a",
    });
    expect(repo.get("sess-1")?.status_source).toBe("spawn");

    repo.recordStatus("sess-1", "waiting_input", "transition");

    expect(repo.get("sess-1")?.status).toBe("waiting_input");
    expect(repo.get("sess-1")?.status_source).toBe("transition");
  });

  it("keeps an existing failure reason when a later write omits one", () => {
    repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "c",
      streamerInstanceId: "inst-a",
    });
    repo.recordStatus("sess-1", "idle", "exit", {
      completedAt: new Date(STARTED.getTime() + 5_000),
      failureReason: "binary not found",
    });
    // A later probe knows the status but nothing new about why it failed —
    // it must not erase the diagnosis.
    repo.recordStatus("sess-1", "idle", "probe");

    expect(repo.get("sess-1")?.failure_reason).toBe("binary not found");
  });

  describe("listNonTerminal", () => {
    it("returns only sessions with no recorded completion", () => {
      repo.recordSpawn({
        session: mkSession({ id: "live" }),
        pid: 1,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });
      repo.recordSpawn({
        session: mkSession({ id: "done" }),
        pid: 2,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });
      repo.recordStatus("done", "idle", "exit", { completedAt: new Date() });

      expect(repo.listNonTerminal().map((r) => r.session_id)).toEqual(["live"]);
    });

    it("is empty on a fresh database — a first run and a pre-010 db look alike", () => {
      expect(repo.listNonTerminal()).toEqual([]);
    });

    it("never returns more than the cap, oldest first", () => {
      for (let i = 0; i < 5; i++) {
        repo.recordSpawn({
          session: mkSession({ id: `s-${i}`, startedAt: new Date(STARTED.getTime() + i * 1000) }),
          pid: i,
          cmdline: "c",
          streamerInstanceId: "inst-a",
        });
      }

      const clipped = repo.listNonTerminal(3);
      expect(clipped.map((r) => r.session_id)).toEqual(["s-0", "s-1", "s-2"]);
    });

    it("defaults to PROBE_SET_MAX", () => {
      repo.recordSpawn({
        session: mkSession({ id: "only" }),
        pid: 1,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });

      expect(PROBE_SET_MAX).toBe(200);
      expect(repo.listNonTerminal()).toHaveLength(1);
    });
  });

  describe("pruneTerminal", () => {
    const DAY = 24 * 3_600_000;

    function recordCompletedAt(id: string, completedAt: Date): void {
      repo.recordSpawn({
        session: mkSession({ id }),
        pid: 1,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });
      repo.recordStatus(id, "idle", "exit", { completedAt });
    }

    it("deletes terminal rows past the retention window and reports the count", () => {
      recordCompletedAt("old", new Date(Date.now() - 40 * DAY));
      recordCompletedAt("recent", new Date(Date.now() - 2 * DAY));

      expect(repo.pruneTerminal(30 * DAY)).toBe(1);
      expect(repo.get("old")).toBeNull();
      expect(repo.get("recent")).not.toBeNull();
    });

    it("never touches a row with no completed_at, however old it looks", () => {
      // Unfinished business by definition — the reconciler and rehydrator both
      // still want it, and `started_at` alone must not make it eligible.
      repo.recordSpawn({
        session: mkSession({ id: "ancient", startedAt: new Date(Date.now() - 400 * DAY) }),
        pid: 1,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });

      expect(repo.pruneTerminal(30 * DAY)).toBe(0);
      expect(repo.get("ancient")).not.toBeNull();
    });

    it("defaults to a 30-day window", () => {
      recordCompletedAt("old", new Date(Date.now() - 31 * DAY));
      recordCompletedAt("young", new Date(Date.now() - 29 * DAY));

      expect(TERMINAL_RETENTION_MS).toBe(30 * DAY);
      expect(repo.pruneTerminal()).toBe(1);
      expect(repo.get("young")).not.toBeNull();
    });
  });

  describe("listRecoverable", () => {
    const HOUR = 3_600_000;

    /** Spawn a row, then optionally close it the way `source` would. */
    function seed(id: string, source?: "shutdown" | "exit", agoMs = 0): void {
      repo.recordSpawn({
        session: mkSession({ id }),
        pid: 1,
        cmdline: "c",
        streamerInstanceId: "inst-a",
      });
      if (source) {
        repo.recordStatus(id, "idle", source, { completedAt: new Date() });
      }
      if (agoMs > 0) {
        store
          .getDatabase()
          .prepare("UPDATE managed_sessions SET status_updated_at = ? WHERE session_id = ?")
          .run(Date.now() - agoMs, id);
      }
    }

    const ids = (rows: { session_id: string }[]) => rows.map((r) => r.session_id).sort();

    it("returns rows we shut down as well as rows still open", () => {
      // The whole point: recordShutdownState stamps completed_at, which takes a
      // cleanly-restarted session out of listNonTerminal's probe set.
      seed("still-open");
      seed("we-stopped-it", "shutdown");

      expect(ids(repo.listRecoverable({ sinceMs: 0, limit: 10 }))).toEqual([
        "still-open",
        "we-stopped-it",
      ]);
    });

    it("excludes a session the agent's own process ended", () => {
      seed("agent-exited", "exit");
      expect(repo.listRecoverable({ sinceMs: 0, limit: 10 })).toEqual([]);
    });

    it("honours the since bound", () => {
      seed("recent", "shutdown");
      seed("ancient", "shutdown", 48 * HOUR);

      const rows = repo.listRecoverable({ sinceMs: Date.now() - 24 * HOUR, limit: 10 });
      expect(ids(rows)).toEqual(["recent"]);
    });

    it("returns the newest first and honours the limit", () => {
      seed("oldest", "shutdown", 3 * HOUR);
      seed("middle", "shutdown", 2 * HOUR);
      seed("newest", "shutdown", 1 * HOUR);

      const rows = repo.listRecoverable({ sinceMs: 0, limit: 10 });
      expect(rows.map((r) => r.session_id)).toEqual(["newest", "middle", "oldest"]);
      expect(repo.listRecoverable({ sinceMs: 0, limit: 2 }).map((r) => r.session_id)).toEqual([
        "newest",
        "middle",
      ]);
    });

    it("is empty on a fresh database", () => {
      expect(repo.listRecoverable({ sinceMs: 0, limit: 10 })).toEqual([]);
    });
  });

  describe("session_name across a status write", () => {
    // The real ordering: a fresh session is recorded at spawn with no name,
    // because the name is derived from a first user message that has not been
    // typed yet. Before recordStatus carried the column, that made the registry
    // permanently unnamed and every recovered session came back nameless.
    function spawnUnnamed(): void {
      repo.recordSpawn({
        session: mkSession({ sessionName: undefined }),
        pid: 1,
        cmdline: "claude",
        streamerInstanceId: "inst-a",
      });
    }

    it("persists a name that only exists after spawn", () => {
      spawnUnnamed();
      expect(repo.get("sess-1")?.session_name).toBeNull();

      repo.recordStatus("sess-1", "running", "transition", { sessionName: "fix the parser" });

      expect(repo.get("sess-1")?.session_name).toBe("fix the parser");
    });

    it("does not clear a stored name when a later write omits it", () => {
      spawnUnnamed();
      repo.recordStatus("sess-1", "running", "transition", { sessionName: "fix the parser" });

      // Every other recordStatus caller — the reconciler and the shutdown
      // stamp — passes no name at all. COALESCE is what stops them wiping it.
      repo.recordStatus("sess-1", "idle", "shutdown", { completedAt: new Date() });

      expect(repo.get("sess-1")?.session_name).toBe("fix the parser");
    });

    it("leaves the name null when it is still unknown", () => {
      spawnUnnamed();
      repo.recordStatus("sess-1", "running", "transition", {});
      expect(repo.get("sess-1")?.session_name).toBeNull();
    });
  });
});
