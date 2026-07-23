import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationCache } from "../src/conversation-cache";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import type { ManagedSession } from "../src/types";

/**
 * The C1 Phase 2 claim, tested end-to-end at the persistence layer: session
 * identity and provenance survive the process that created them.
 *
 * Before this, managed sessions lived only in SessionStore's Maps
 * (sessions.repository.ts said so outright), so a restart didn't leave a
 * "recoverable" session — it left nothing, and the session reappeared at best
 * as an external process with no managed metadata.
 *
 * Opening a second ConversationCache against the same file is the honest
 * simulation of a restart: a new process, new prepared statements, same disk.
 */

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "tb-registry-restart-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function openRepo(): { cache: ConversationCache; repo: ManagedSessionsRepository } {
  const cache = ConversationCache.open(join(cacheDir, "cache.db"));
  return { cache, repo: new ManagedSessionsRepository(cache.getDatabase()) };
}

const STARTED = new Date("2026-07-24T09:00:00Z");

function mkSession(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "restart-sess",
    provider: "claude-code",
    projectPath: "/work/repo",
    projectName: "repo",
    branch: "main",
    status: "running",
    startedAt: STARTED,
    completedAt: null,
    promptCount: 7,
    lastOutput: "",
    sessionName: "long refactor",
    ...over,
  } as ManagedSession;
}

describe("managed-session registry across a streamer restart", () => {
  it("recovers session metadata that used to be lost with the process", () => {
    const first = openRepo();
    first.repo.recordSpawn({
      session: mkSession({ projectId: "proj-1", boundConversationId: "rollout-77" }),
      pid: 31337,
      cmdline: "claude-code /work/repo",
      streamerInstanceId: "instance-1",
    });
    first.cache.close();

    // ── restart ──
    const second = openRepo();
    try {
      const [row] = second.repo.listNonTerminal();

      expect(row.session_id).toBe("restart-sess");
      // Every one of these is a field the in-memory-only design dropped.
      expect(row.started_at).toBe(STARTED.getTime());
      expect(row.prompt_count).toBe(7);
      expect(row.session_name).toBe("long refactor");
      expect(row.project_id).toBe("proj-1");
      expect(row.bound_conversation_id).toBe("rollout-77");
      expect(row.project_path).toBe("/work/repo");
      expect(row.pid).toBe(31337);
    } finally {
      second.cache.close();
    }
  });

  it("marks the previous run's sessions as belonging to a different instance", () => {
    const first = openRepo();
    first.repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "claude-code /work/repo",
      streamerInstanceId: "instance-1",
    });
    first.cache.close();

    const second = openRepo();
    try {
      // This is the orphan test the reconciler runs: a row whose instance id
      // is not the current run's outlived the streamer that started it.
      const [row] = second.repo.listNonTerminal();
      expect(row.streamer_instance_id).toBe("instance-1");
      expect(row.streamer_instance_id).not.toBe("instance-2");
    } finally {
      second.cache.close();
    }
  });

  it("keeps a shutdown-stamped session out of the next boot's probe set", () => {
    const first = openRepo();
    first.repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "claude-code /work/repo",
      streamerInstanceId: "instance-1",
    });
    // What close() now does for every live session before dispose() kills it.
    first.repo.recordStatus("restart-sess", "idle", "shutdown", { completedAt: new Date() });
    first.cache.close();

    const second = openRepo();
    try {
      // Terminal, so the reconciler has nothing to probe — and crucially it can
      // tell this apart from a crash, where no such row would exist.
      expect(second.repo.listNonTerminal()).toEqual([]);
      expect(second.repo.get("restart-sess")?.status_source).toBe("shutdown");
      // A deliberate shutdown is not a session failure.
      expect(second.repo.get("restart-sess")?.failure_reason).toBeNull();
    } finally {
      second.cache.close();
    }
  });

  it("leaves a crashed run's sessions in the probe set with no recorded exit", () => {
    const first = openRepo();
    first.repo.recordSpawn({
      session: mkSession(),
      pid: 1,
      cmdline: "claude-code /work/repo",
      streamerInstanceId: "instance-1",
    });
    // SIGKILL: close() never runs, so nothing stamps a terminal state.
    first.cache.close();

    const second = openRepo();
    try {
      const [row] = second.repo.listNonTerminal();
      // Still non-terminal and still claiming `running` — which is exactly why
      // the reconciler must probe the pid rather than trust a stored status.
      expect(row.status).toBe("running");
      expect(row.status_source).toBe("spawn");
      expect(row.completed_at).toBeNull();
    } finally {
      second.cache.close();
    }
  });
});
