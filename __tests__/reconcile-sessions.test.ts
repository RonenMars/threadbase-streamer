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

// Phase 2: a pid recorded under a previous boot identifies nothing today, so it
// must never be probed. See docs/plans/live-sessions-persistence-plan.md.
describe("classifySession across machine boots", () => {
  const BOOT = "boot-current";

  it("classifies a foreign boot token as resumable without probing the pid", async () => {
    const isPidAlive = vi.fn(() => true);
    const getProcessArgs = vi.fn(async () => "claude --resume sess-1");

    const verdict = await classifySession(
      mkRow({ boot_token: "boot-previous" }),
      mkProbe({ isPidAlive, getProcessArgs }),
      INSTANCE,
      BOOT,
    );

    // A live process with a matching argv token at that pid is exactly the case
    // that used to produce a false `detached`.
    expect(verdict.lifecycle).toBe("resumable");
    expect(verdict.reason).toMatch(/before this machine boot/);
    expect(isPidAlive).not.toHaveBeenCalled();
    expect(getProcessArgs).not.toHaveBeenCalled();
  });

  it("treats a row recorded before the column existed exactly like a mismatch", async () => {
    const isPidAlive = vi.fn(() => true);

    const verdict = await classifySession(
      mkRow({ boot_token: null }),
      mkProbe({ isPidAlive, getProcessArgs: async () => "claude --resume sess-1" }),
      INSTANCE,
      BOOT,
    );

    expect(verdict.lifecycle).toBe("resumable");
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it("leaves the same-boot decision table alone", async () => {
    const ours = await classifySession(
      mkRow({ boot_token: BOOT }),
      mkProbe({ isPidAlive: () => true, getProcessArgs: async () => "claude --resume sess-1" }),
      INSTANCE,
      BOOT,
    );
    expect(ours.lifecycle).toBe("detached");

    const recycled = await classifySession(
      mkRow({ boot_token: BOOT }),
      mkProbe({ isPidAlive: () => true, getProcessArgs: async () => "/usr/bin/postgres" }),
      INSTANCE,
      BOOT,
    );
    expect(recycled.lifecycle).toBe("orphaned");
  });
});

describe("classifySession — Codex resume identity", () => {
  const unbound = { provider: "codex-cli", session_id: "placeholder", cmdline: "/work/repo" };

  it("reports a dead unbound Codex session as failed, not resumable", async () => {
    const verdict = await classifySession(mkRow(unbound), mkProbe(), INSTANCE);

    expect(verdict.lifecycle).toBe("failed");
    expect(verdict.reason).toBe("Codex session ended before its rollout id was known");
  });

  it("applies the same verdict on the no-pid and pre-boot paths", async () => {
    const noPid = await classifySession(mkRow({ ...unbound, pid: null }), mkProbe(), INSTANCE);
    expect(noPid.lifecycle).toBe("failed");

    const preBoot = await classifySession(
      mkRow({ ...unbound, boot_token: "boot-previous" }),
      mkProbe({ isPidAlive: () => true }),
      INSTANCE,
      "boot-current",
    );
    expect(preBoot.lifecycle).toBe("failed");
  });

  it("leaves a bound Codex session resumable", async () => {
    const verdict = await classifySession(
      mkRow({ ...unbound, bound_conversation_id: "rollout-uuid" }),
      mkProbe(),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("resumable");
    expect(verdict.reason).toMatch(/process gone/);
  });

  it("does not touch a live unbound Codex session — it needs no resume id yet", async () => {
    const verdict = await classifySession(
      mkRow(unbound),
      mkProbe({ isPidAlive: () => true, getProcessArgs: async () => "codex --cd /work/repo" }),
      INSTANCE,
    );

    expect(verdict.lifecycle).toBe("detached");
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
