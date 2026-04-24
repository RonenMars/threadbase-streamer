import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrations";
import { PgSessionPersistence } from "../../src/db/pg-session-persistence";
import { SessionStore } from "../../src/session-store";
import type { ManagedSession } from "../../src/types";

const DATABASE_URL = process.env.THREADBASE_DATABASE_URL;

const describeWithDb = DATABASE_URL ? describe : describe.skip;

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "conv_integration_test",
    projectPath: "/tmp/integration-test",
    projectName: "integration-test",
    branch: "main",
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

describeWithDb("PostgreSQL integration", () => {
  let pool: pg.Pool;
  let persistence: PgSessionPersistence;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await runMigrations(pool);
    persistence = new PgSessionPersistence(pool);
    await pool.query("DELETE FROM managed_sessions WHERE project_name = 'integration-test'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM managed_sessions WHERE project_name = 'integration-test'");
    await pool.end();
  });

  it("save + loadAll round-trips a managed session", async () => {
    const session = makeSession();
    await persistence.save(session);

    const loaded = await persistence.loadAll();
    const found = loaded.find((s) => s.id === session.id);

    expect(found).toBeDefined();
    expect(found?.conversationId).toBe("conv_integration_test");
    expect(found?.projectPath).toBe("/tmp/integration-test");
    expect(found?.status).toBe("running");
  });

  it("update changes persisted fields", async () => {
    const session = makeSession();
    await persistence.save(session);

    const completedAt = new Date();
    await persistence.update(session.id, { status: "completed", completedAt });

    const loaded = await persistence.loadAll();
    const found = loaded.find((s) => s.id === session.id);

    expect(found?.status).toBe("completed");
    expect(found?.completedAt).toEqual(completedAt);
  });

  it("remove deletes the row", async () => {
    const session = makeSession();
    await persistence.save(session);
    await persistence.remove(session.id);

    const loaded = await persistence.loadAll();
    const found = loaded.find((s) => s.id === session.id);
    expect(found).toBeUndefined();
  });

  it("SessionStore.rehydrate loads sessions from DB", async () => {
    const session = makeSession({ conversationId: "conv_rehydrate_test" });
    await persistence.save(session);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    const resp = store.get(session.id);
    expect(resp).not.toBeNull();
    expect(resp?.source).toBe("managed");
    expect(resp?.conversationId).toBe("conv_rehydrate_test");
  });

  it("rehydrated managed sessions dedupe discovered processes", async () => {
    const session = makeSession({ conversationId: "conv_dedupe_test" });
    await persistence.save(session);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    store.setDiscovered([
      {
        pid: 99999,
        projectPath: "/tmp/discovered",
        projectName: "discovered",
        branch: "main",
        conversationId: "conv_dedupe_test",
        startedAt: new Date(),
      },
    ]);

    const all = store.list();
    const matching = all.filter((s) => s.conversationId === "conv_dedupe_test");
    expect(matching).toHaveLength(1);
    expect(matching[0].source).toBe("managed");
  });
});
