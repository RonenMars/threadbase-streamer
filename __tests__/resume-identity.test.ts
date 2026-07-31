import { describe, expect, it } from "vitest";
import type { ManagedSessionRow } from "../src/db/repositories/managed-sessions.repository";
import { resumeIdForRow } from "../src/services/sessions/resumeIdentity";

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
    streamer_instance_id: "instance-1",
    ...over,
  };
}

describe("resumeIdForRow", () => {
  it("returns the session id for a Claude row", () => {
    expect(resumeIdForRow(mkRow())).toBe("sess-1");
  });

  it("ignores a stray bound id on a Claude row — --resume takes the session id", () => {
    expect(resumeIdForRow(mkRow({ bound_conversation_id: "other" }))).toBe("sess-1");
  });

  it("returns the bound rollout id for a Codex row", () => {
    expect(
      resumeIdForRow(
        mkRow({
          provider: "codex-cli",
          session_id: "placeholder-uuid",
          bound_conversation_id: "rollout-uuid",
        }),
      ),
    ).toBe("rollout-uuid");
  });

  it("returns null for a Codex row that never bound — the placeholder cannot resume", () => {
    expect(
      resumeIdForRow(mkRow({ provider: "codex-cli", session_id: "placeholder-uuid" })),
    ).toBeNull();
  });
});
