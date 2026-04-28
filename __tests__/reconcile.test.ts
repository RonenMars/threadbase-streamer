import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConversationIdForSession, reconcileOrphanedSessions } from "../src/reconcile";
import { SessionStore } from "../src/session-store";
import type { ManagedSession } from "../src/types";

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_test",
    conversationId: "",
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-20T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

describe("reconcileOrphanedSessions", () => {
  let store: SessionStore;
  let projectsRoot: string;
  const NOW = new Date("2026-04-28T12:00:00Z");

  beforeEach(async () => {
    store = new SessionStore();
    projectsRoot = await mkdtemp(join(tmpdir(), "tb-reconcile-"));
  });

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true });
  });

  it("marks running sessions as failed", async () => {
    store.addManaged(makeSession({ id: "ses_a", status: "running" }));

    const results = await reconcileOrphanedSessions(store, {
      claudeProjectsRoot: projectsRoot,
      now: NOW,
    });

    const updated = store.getManaged("ses_a");
    expect(updated?.status).toBe("failed");
    expect(updated?.completedAt).toEqual(NOW);
    expect(results[0]?.updates.status).toBe("failed");
  });

  it("marks waiting_input sessions as failed", async () => {
    store.addManaged(makeSession({ id: "ses_b", status: "waiting_input" }));

    await reconcileOrphanedSessions(store, {
      claudeProjectsRoot: projectsRoot,
      now: NOW,
    });

    expect(store.getManaged("ses_b")?.status).toBe("failed");
  });

  it("leaves completed sessions alone", async () => {
    const completedAt = new Date("2026-04-21T10:00:00Z");
    store.addManaged(
      makeSession({
        id: "ses_c",
        status: "completed",
        conversationId: "conv_already_set",
        completedAt,
      }),
    );

    const results = await reconcileOrphanedSessions(store, {
      claudeProjectsRoot: projectsRoot,
      now: NOW,
    });

    expect(results).toHaveLength(0);
    const after = store.getManaged("ses_c");
    expect(after?.status).toBe("completed");
    expect(after?.completedAt).toEqual(completedAt);
  });

  it("backfills conversationId from a JSONL whose mtime matches startedAt", async () => {
    const startedAt = new Date("2026-04-25T08:00:00Z");
    store.addManaged(
      makeSession({
        id: "ses_d",
        status: "running",
        projectPath: "/tmp/myproj",
        conversationId: "",
        startedAt,
      }),
    );

    // Encoding: "/" and "." → "-"
    const encodedDir = join(projectsRoot, "-tmp-myproj");
    await mkdir(encodedDir, { recursive: true });
    const matchUuid = "11111111-2222-3333-4444-555555555555";
    const matchFile = join(encodedDir, `${matchUuid}.jsonl`);
    await writeFile(matchFile, "{}\n");
    await utimes(matchFile, startedAt, startedAt);

    // A second, much older file in the same dir — should not win.
    const olderUuid = "99999999-9999-9999-9999-999999999999";
    const olderFile = join(encodedDir, `${olderUuid}.jsonl`);
    await writeFile(olderFile, "{}\n");
    const old = new Date("2025-01-01T00:00:00Z");
    await utimes(olderFile, old, old);

    await reconcileOrphanedSessions(store, {
      claudeProjectsRoot: projectsRoot,
      now: NOW,
    });

    expect(store.getManaged("ses_d")?.conversationId).toBe(matchUuid);
  });

  it("leaves conversationId empty when no JSONL falls within the tolerance window", async () => {
    store.addManaged(
      makeSession({
        id: "ses_e",
        projectPath: "/tmp/farpast",
        startedAt: new Date("2026-04-25T08:00:00Z"),
      }),
    );

    const encodedDir = join(projectsRoot, "-tmp-farpast");
    await mkdir(encodedDir, { recursive: true });
    const farUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const farFile = join(encodedDir, `${farUuid}.jsonl`);
    await writeFile(farFile, "{}\n");
    const farPast = new Date("2024-01-01T00:00:00Z");
    await utimes(farFile, farPast, farPast);

    await reconcileOrphanedSessions(store, {
      claudeProjectsRoot: projectsRoot,
      now: NOW,
    });

    expect(store.getManaged("ses_e")?.conversationId).toBe("");
  });

  it("returns null when the encoded project directory does not exist", async () => {
    const found = await findConversationIdForSession(
      { projectPath: "/tmp/nope", startedAt: new Date() },
      projectsRoot,
    );
    expect(found).toBeNull();
  });

  it("encodes both '/' and '.' as '-' when locating the project dir", async () => {
    const startedAt = new Date("2026-04-25T08:00:00Z");
    // Project path with an embedded "." segment, like a worktree.
    const projectPath = "/Users/x/y/.claude/worktrees/foo";
    const encodedDir = join(projectsRoot, "-Users-x-y--claude-worktrees-foo");
    await mkdir(encodedDir, { recursive: true });
    const uuid = "abcabcab-1111-2222-3333-444444444444";
    const file = join(encodedDir, `${uuid}.jsonl`);
    await writeFile(file, "{}\n");
    await utimes(file, startedAt, startedAt);

    const found = await findConversationIdForSession({ projectPath, startedAt }, projectsRoot);
    expect(found).toBe(uuid);
  });
});
