import { describe, expect, it, vi } from "vitest";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import {
  classifySession,
  type ReconcileProbe,
  reconcileSessions,
} from "../src/services/sessions/reconcileSessions";

const INSTANCE = "instance-current";

function mkRow(over: Partial<ManagedSessionRow> = {}): ManagedSessionRow {
  return {
    session_id: "sess-1",
    provider: "claude-code",
    pid: 4242,
    cmdline: "sess-1",
    project_path: "/work/repo",
    project_name: "repo",
    branch: "main",
    status: "running",
    status_source: "spawn",
    status_updated_at: 1_000,
    started_at: 1_000,
    completed_at: null,
    last_activity_at: null,
    prompt_count: 0,
    session_name: null,
    project_id: null,
    bound_conversation_id: null,
    resumed_from_conversation_id: null,
    failure_reason: null,
    streamer_instance_id: "instance-previous",
    ...over,
  };
}

function mkProbe(over: Partial<ReconcileProbe> = {}): ReconcileProbe {
  return {
    isPidAlive: () => false,
    getProcessArgs: async () => "",
    ...over,
  };
}

describe("classifySession", () => {
  it("reports a live, identity-matched process from a previous run as detached", async () => {
    const verdict = await classifySession(
      mkRow(),
      mkProbe({
        isPidAlive: () => true,
        getProcessArgs: async () => "claude --resume sess-1 --model sonnet",
      }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("detached");
  });

  it("reports a live, identity-matched process from THIS run as attached", async () => {
    const verdict = await classifySession(
      mkRow({ streamer_instance_id: INSTANCE }),
      mkProbe({
        isPidAlive: () => true,
        getProcessArgs: async () => "claude --resume sess-1",
      }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("attached");
  });

  // The guard that stops a durability feature from becoming a
  // kill-an-unrelated-process bug.
  it("reports a recycled pid as orphaned rather than claiming it", async () => {
    const verdict = await classifySession(
      mkRow(),
      mkProbe({
        isPidAlive: () => true,
        // Someone else's process now owns that pid.
        getProcessArgs: async () => "/usr/bin/postgres -D /var/lib/postgres",
      }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("orphaned");
    expect(verdict.reason).toMatch(/does not match/);
  });

  it("treats an unreadable command line as cannot-confirm, not confirmed", async () => {
    const verdict = await classifySession(
      mkRow(),
      mkProbe({ isPidAlive: () => true, getProcessArgs: async () => "" }),
      INSTANCE,
    );

    // Never `detached` — an unreadable argv must not promote an unknown
    // process into a managed session.
    expect(verdict.lifecycle).toBe("orphaned");
    expect(verdict.reason).toMatch(/unreadable/);
  });

  it("never trusts a stored running status over a dead pid", async () => {
    // The SIGKILL case: the row still claims `running` because no exit write
    // ever ran, but the process is gone.
    const verdict = await classifySession(
      mkRow({ status: "running", status_source: "spawn" }),
      mkProbe({ isPidAlive: () => false }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("resumable");
  });

  it("reports a dead pid whose history ended cleanly as completed", async () => {
    const verdict = await classifySession(
      mkRow(),
      mkProbe({ isPidAlive: () => false, endedCleanly: () => true }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("completed");
  });

  it("classifies a recorded clean exit as completed without probing", async () => {
    const isPidAlive = vi.fn(() => true);
    const verdict = await classifySession(
      mkRow({ completed_at: 5_000, status: "idle", status_source: "exit" }),
      mkProbe({ isPidAlive }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("completed");
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it("classifies a recorded exit carrying a failure reason as failed", async () => {
    const verdict = await classifySession(
      mkRow({
        completed_at: 5_000,
        status: "idle",
        status_source: "exit",
        failure_reason: "Project directory not found",
      }),
      mkProbe(),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("failed");
  });

  // A deliberate shutdown is terminal but blameless — it must not be reported
  // as a session failure on the next boot.
  it("classifies a shutdown-stamped session as completed, not failed", async () => {
    const verdict = await classifySession(
      mkRow({ completed_at: 5_000, status: "idle", status_source: "shutdown" }),
      mkProbe(),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("completed");
  });

  it("falls back to resumable when no pid was ever recorded", async () => {
    const verdict = await classifySession(mkRow({ pid: null }), mkProbe(), INSTANCE);
    expect(verdict.lifecycle).toBe("resumable");
  });
});

describe("reconcileSessions", () => {
  it("classifies every row and never signals a process", async () => {
    const rows = [
      mkRow({ session_id: "alive", pid: 1, cmdline: "alive" }),
      mkRow({ session_id: "dead", pid: 2, cmdline: "dead" }),
    ];
    const probe = mkProbe({
      isPidAlive: (pid) => pid === 1,
      getProcessArgs: async () => "claude --resume alive",
    });

    const verdicts = await reconcileSessions(rows, probe, INSTANCE);

    expect(verdicts.map((v) => [v.sessionId, v.lifecycle])).toEqual([
      ["alive", "detached"],
      ["dead", "resumable"],
    ]);
  });
});
