// Issue #960: the effective model and effort of a Claude session are persisted
// in runtime.db (migration 008) so a held / restarted session still knows them.

import { cpSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedSessionsRepository } from "../src/db/repositories/managed-sessions.repository";
import { RuntimeStore } from "../src/db/runtime-store";
import { resolveMigrationsDir } from "../src/db/sqlite-migrate";
import { rowToStubSession } from "../src/services/sessions/rehydrateSessions";
import type { ManagedSession } from "../src/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-model-effort-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "sess-1",
    provider: "claude-code",
    projectPath: "/w/app",
    projectName: "app",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-10-01T08:00:00Z"),
    completedAt: null,
    promptCount: 1,
    lastOutput: "",
    ...over,
  } as ManagedSession;
}

function record(repo: ManagedSessionsRepository, s: ManagedSession): void {
  repo.recordSpawn({ session: s, pid: null, cmdline: null, streamerInstanceId: "test" });
}

function columns(store: RuntimeStore): string[] {
  return (
    store.getDatabase().prepare("PRAGMA table_info(managed_sessions)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

describe("managed_sessions model / effort (migration 008)", () => {
  it("adds nullable model and effort columns on a fresh runtime.db", () => {
    const store = RuntimeStore.open(join(dir, "runtime.db"));
    expect(columns(store)).toEqual(expect.arrayContaining(["model", "effort"]));
    const applied = store.getDatabase().prepare("SELECT id FROM schema_migrations").all() as Array<{
      id: string;
    }>;
    expect(applied.map((r) => r.id)).toContain("008_add_managed_session_model_effort.sql");
    store.close();
  });

  it("upgrades a runtime.db already at 007 and leaves old rows null", () => {
    const partial = join(dir, "migrations-at-007");
    cpSync(resolveMigrationsDir("runtime-migrations"), partial, {
      recursive: true,
      filter: (src) => !src.endsWith("008_add_managed_session_model_effort.sql"),
    });
    const dbPath = join(dir, "old.db");
    const before = RuntimeStore.open(dbPath, partial);
    expect(columns(before)).not.toContain("model");
    // Raw SQL: the repository's statements already name the 008 columns.
    before
      .getDatabase()
      .prepare(
        `INSERT INTO managed_sessions (session_id, provider, project_path, project_name, branch,
           status, status_source, status_updated_at, started_at, prompt_count, streamer_instance_id)
         VALUES ('sess-1', 'claude-code', '/w/app', 'app', 'main', 'idle', 'spawn', 1, 1, 0, 'old')`,
      )
      .run();
    before.close();

    const after = RuntimeStore.open(dbPath);
    expect(columns(after)).toEqual(expect.arrayContaining(["model", "effort"]));
    const row = new ManagedSessionsRepository(after.getDatabase()).get("sess-1");
    expect(row?.model).toBeNull();
    expect(row?.effort).toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted just above
    const stub = rowToStubSession(row!);
    expect(stub).not.toHaveProperty("model");
    expect(stub).not.toHaveProperty("effort");
    after.close();
  });

  describe("repository", () => {
    let store: RuntimeStore;
    let repo: ManagedSessionsRepository;

    beforeEach(() => {
      store = RuntimeStore.open(join(dir, "runtime.db"));
      repo = new ManagedSessionsRepository(store.getDatabase());
    });

    afterEach(() => store.close());

    it("round-trips through recordSpawn and the rehydrated stub", () => {
      record(repo, session({ model: "claude-sonnet-5", effort: "high" }));
      const row = repo.get("sess-1");
      expect(row?.model).toBe("claude-sonnet-5");
      expect(row?.effort).toBe("high");
      // biome-ignore lint/style/noNonNullAssertion: asserted just above
      const stub = rowToStubSession(row!);
      expect(stub.model).toBe("claude-sonnet-5");
      expect(stub.effort).toBe("high");
    });

    it("stores NULL when the session has none (a non-Claude provider)", () => {
      record(repo, session({ provider: "codex-cli" }));
      const row = repo.get("sess-1");
      expect(row?.model).toBeNull();
      expect(row?.effort).toBeNull();
    });

    it("recordSetting overwrites one column and leaves the other alone", () => {
      record(repo, session({ model: "sonnet", effort: "low" }));
      repo.recordSetting("sess-1", "model", "opus");
      expect(repo.get("sess-1")).toMatchObject({ model: "opus", effort: "low" });
      repo.recordSetting("sess-1", "effort", "max");
      expect(repo.get("sess-1")).toMatchObject({ model: "opus", effort: "max" });
    });

    it("a resume re-record replaces the earlier values", () => {
      record(repo, session({ model: "sonnet", effort: "low" }));
      record(repo, session({ model: "opus", effort: "max" }));
      const row = repo.get("sess-1");
      expect(row?.model).toBe("opus");
      expect(row?.effort).toBe("max");
    });
  });
});
