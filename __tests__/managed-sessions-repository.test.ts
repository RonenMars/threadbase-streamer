import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import type { ManagedSession } from "../src/types";

let dbDir: string;
let cache: ConversationCache;
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
  cache = ConversationCache.open(join(dbDir, "cache.db"));
  repo = new ManagedSessionsRepository(cache.getDatabase());
});

afterEach(() => {
  cache.close();
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
  });
});
