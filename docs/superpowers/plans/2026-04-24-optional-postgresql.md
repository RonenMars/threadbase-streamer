# Optional PostgreSQL Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional PostgreSQL persistence for managed sessions in the Threadbase streamer, gated by the `THREADBASE_DATABASE_URL` environment variable.

**Architecture:** A `SessionPersistence` interface with two implementations (`MemorySessionPersistence` and `PgSessionPersistence`) injected into `SessionStore`. Writes are write-through (memory + DB). On startup with DB configured, migrations run automatically and managed sessions are rehydrated from Postgres into the in-memory Map. When DB is not configured, behavior is identical to the current in-memory-only code.

**Tech Stack:** TypeScript, `pg` (node-postgres) for Postgres client + pool, vitest for testing, plain SQL migrations with a minimal runner.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/db/config.ts` | Create | Read env vars, export `getDbConfig()` and `isDbEnabled()` |
| `src/db/pool.ts` | Create | Create `pg.Pool`, mask password in logs, graceful shutdown |
| `src/db/migrations.ts` | Create | Minimal migration runner using `_migrations` tracking table |
| `src/db/migrations/001_create_managed_sessions.sql` | Create | Phase 1 schema DDL |
| `src/db/session-persistence.ts` | Create | `SessionPersistence` interface + `PgSessionPersistence` class |
| `src/db/memory-persistence.ts` | Create | `MemorySessionPersistence` (no-op default) |
| `src/db/index.ts` | Create | Barrel export for `src/db/` |
| `src/session-store.ts` | Modify | Accept optional `SessionPersistence`, wire write-through + rehydrate |
| `src/server.ts` | Modify | Wire DB pool, migrations, persistence on startup; pool shutdown on close |
| `src/index.ts` | Modify | Re-export DB types for library consumers |
| `__tests__/session-store.test.ts` | Modify | Add tests for persistence integration |
| `__tests__/db/pg-session-persistence.test.ts` | Create | Unit tests for `PgSessionPersistence` with mocked `pg` |
| `__tests__/db/migrations.test.ts` | Create | Unit tests for migration runner |
| `__tests__/db/integration.test.ts` | Create | Integration test requiring real Postgres |
| `docs/database.md` | Create | Env vars, activation rules, local dev Postgres setup |
| `docker-compose.yml` | Create | Postgres container for local dev |
| `package.json` | Modify | Add `pg` dependency, `@types/pg` devDependency |

---

### Task 1: Install Dependencies and DB Config

**Files:**
- Modify: `package.json`
- Create: `src/db/config.ts`
- Test: `__tests__/db/config.test.ts`

- [ ] **Step 1: Install `pg` and `@types/pg`**

Run from `streamer/`:
```bash
npm install pg
npm install --save-dev @types/pg
```

- [ ] **Step 2: Write failing tests for DB config**

Create `__tests__/db/config.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { getDbConfig, isDbEnabled } from "../../src/db/config";

describe("db/config", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isDbEnabled", () => {
    it("returns false when THREADBASE_DATABASE_URL is not set", () => {
      process.env = { ...originalEnv };
      delete process.env.THREADBASE_DATABASE_URL;
      expect(isDbEnabled()).toBe(false);
    });

    it("returns false when THREADBASE_DATABASE_URL is empty", () => {
      process.env = { ...originalEnv, THREADBASE_DATABASE_URL: "" };
      expect(isDbEnabled()).toBe(false);
    });

    it("returns true when THREADBASE_DATABASE_URL is set", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
      };
      expect(isDbEnabled()).toBe(true);
    });
  });

  describe("getDbConfig", () => {
    it("returns null when DB is not enabled", () => {
      process.env = { ...originalEnv };
      delete process.env.THREADBASE_DATABASE_URL;
      expect(getDbConfig()).toBeNull();
    });

    it("returns config with connection string and defaults", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://user:pass@localhost:5432/threadbase",
      };
      const config = getDbConfig();
      expect(config).not.toBeNull();
      expect(config!.connectionString).toBe("postgresql://user:pass@localhost:5432/threadbase");
      expect(config!.max).toBe(10);
      expect(config!.statementTimeout).toBeUndefined();
    });

    it("reads optional env vars", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
        THREADBASE_DATABASE_POOL_MAX: "5",
        THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS: "3000",
        THREADBASE_DATABASE_SSL: "require",
      };
      const config = getDbConfig();
      expect(config!.max).toBe(5);
      expect(config!.statementTimeout).toBe(3000);
      expect(config!.ssl).toBe("require");
    });

    it("ignores non-numeric pool max", () => {
      process.env = {
        ...originalEnv,
        THREADBASE_DATABASE_URL: "postgresql://localhost:5432/threadbase",
        THREADBASE_DATABASE_POOL_MAX: "abc",
      };
      const config = getDbConfig();
      expect(config!.max).toBe(10);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/config.test.ts
```
Expected: FAIL — module `../../src/db/config` does not exist.

- [ ] **Step 4: Implement `src/db/config.ts`**

```typescript
export interface DbConfig {
  connectionString: string;
  max: number;
  ssl?: string;
  statementTimeout?: number;
}

export function isDbEnabled(): boolean {
  const url = process.env.THREADBASE_DATABASE_URL;
  return typeof url === "string" && url.length > 0;
}

export function getDbConfig(): DbConfig | null {
  if (!isDbEnabled()) return null;

  const connectionString = process.env.THREADBASE_DATABASE_URL!;
  const poolMax = Number.parseInt(process.env.THREADBASE_DATABASE_POOL_MAX ?? "", 10);
  const stmtTimeout = Number.parseInt(
    process.env.THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS ?? "",
    10,
  );
  const ssl = process.env.THREADBASE_DATABASE_SSL || undefined;

  return {
    connectionString,
    max: Number.isNaN(poolMax) ? 10 : poolMax,
    ssl,
    statementTimeout: Number.isNaN(stmtTimeout) ? undefined : stmtTimeout,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run __tests__/db/config.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/config.ts __tests__/db/config.test.ts package.json package-lock.json
git commit -m "feat(streamer): add DB config module with env var parsing"
```

---

### Task 2: Pool Creation with Password Masking

**Files:**
- Create: `src/db/pool.ts`
- Test: `__tests__/db/pool.test.ts`

- [ ] **Step 1: Write failing tests for pool module**

Create `__tests__/db/pool.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock pg before importing pool
vi.mock("pg", () => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
  return { default: { Pool: vi.fn(() => mockPool) }, Pool: vi.fn(() => mockPool) };
});

import { createPool, maskConnectionString } from "../../src/db/pool";

describe("db/pool", () => {
  describe("maskConnectionString", () => {
    it("masks password in connection string", () => {
      const url = "postgresql://user:secret123@localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://user:***@localhost:5432/threadbase");
    });

    it("handles connection string without password", () => {
      const url = "postgresql://localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://localhost:5432/threadbase");
    });

    it("handles connection string with empty password", () => {
      const url = "postgresql://user:@localhost:5432/threadbase";
      expect(maskConnectionString(url)).toBe("postgresql://user:***@localhost:5432/threadbase");
    });
  });

  describe("createPool", () => {
    it("creates a pool with provided config", () => {
      const pool = createPool({
        connectionString: "postgresql://localhost:5432/threadbase",
        max: 5,
      });
      expect(pool).toBeDefined();
      expect(pool.end).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/pool.test.ts
```
Expected: FAIL — module `../../src/db/pool` does not exist.

- [ ] **Step 3: Implement `src/db/pool.ts`**

```typescript
import pg from "pg";
import type { DbConfig } from "./config";

const { Pool } = pg;

export function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "***masked***";
  }
}

export function createPool(config: DbConfig): pg.Pool {
  const poolConfig: pg.PoolConfig = {
    connectionString: config.connectionString,
    max: config.max,
  };

  if (config.ssl === "require") {
    poolConfig.ssl = { rejectUnauthorized: false };
  } else if (config.ssl === "disable") {
    poolConfig.ssl = false;
  }

  if (config.statementTimeout) {
    poolConfig.statement_timeout = config.statementTimeout;
  }

  return new Pool(poolConfig);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run __tests__/db/pool.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/pool.ts __tests__/db/pool.test.ts
git commit -m "feat(streamer): add Postgres pool creation with password masking"
```

---

### Task 3: Migration Runner

**Files:**
- Create: `src/db/migrations.ts`
- Create: `src/db/migrations/001_create_managed_sessions.sql`
- Test: `__tests__/db/migrations.test.ts`

- [ ] **Step 1: Create the SQL migration file**

Create `src/db/migrations/001_create_managed_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS managed_sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  project_name    TEXT NOT NULL,
  branch          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  prompt_count    INTEGER NOT NULL DEFAULT 0,
  last_output     TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_managed_sessions_conversation_id
  ON managed_sessions(conversation_id);
```

- [ ] **Step 2: Write failing tests for migration runner**

Create `__tests__/db/migrations.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };

vi.mock("fs", () => ({
  readdirSync: vi.fn(() => ["001_create_managed_sessions.sql"]),
  readFileSync: vi.fn(() => "CREATE TABLE managed_sessions (id TEXT);"),
}));

import { runMigrations } from "../../src/db/migrations";

describe("db/migrations", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("creates _migrations table if not exists", async () => {
    // First call: create _migrations table
    // Second call: SELECT applied migrations (empty)
    // Third call: INSERT migration record
    // Fourth call: run SQL
    mockQuery
      .mockResolvedValueOnce({}) // CREATE _migrations
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValueOnce({}) // run migration SQL
      .mockResolvedValueOnce({}); // INSERT record

    await runMigrations(mockPool as any, new URL("file:///fake/migrations"));

    expect(mockQuery.mock.calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS _migrations");
  });

  it("skips already-applied migrations", async () => {
    mockQuery
      .mockResolvedValueOnce({}) // CREATE _migrations
      .mockResolvedValueOnce({
        rows: [{ name: "001_create_managed_sessions.sql" }],
      }); // SELECT applied — already has the migration

    await runMigrations(mockPool as any, new URL("file:///fake/migrations"));

    // Only 2 calls: create table + select. No migration execution.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("applies unapplied migrations in order", async () => {
    mockQuery
      .mockResolvedValueOnce({}) // CREATE _migrations
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied (none)
      .mockResolvedValueOnce({}) // run migration SQL
      .mockResolvedValueOnce({}); // INSERT record

    await runMigrations(mockPool as any, new URL("file:///fake/migrations"));

    // Should have executed the migration SQL
    expect(mockQuery.mock.calls[2][0]).toContain("CREATE TABLE managed_sessions");
    // Should have recorded it
    expect(mockQuery.mock.calls[3][0]).toContain("INSERT INTO _migrations");
    expect(mockQuery.mock.calls[3][1]).toContain("001_create_managed_sessions.sql");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/migrations.test.ts
```
Expected: FAIL — module `../../src/db/migrations` does not exist.

- [ ] **Step 4: Implement `src/db/migrations.ts`**

```typescript
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type pg from "pg";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: URL = MIGRATIONS_DIR,
): Promise<void> {
  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const { rows: applied } = await pool.query<{ name: string }>(
    "SELECT name FROM _migrations ORDER BY name",
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files from disk
  const dir = fileURLToPath(migrationsDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(join(dir, file), "utf-8");
    await pool.query(sql);
    await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run __tests__/db/migrations.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/db/migrations/001_create_managed_sessions.sql __tests__/db/migrations.test.ts
git commit -m "feat(streamer): add SQL migration runner and Phase 1 schema"
```

---

### Task 4: SessionPersistence Interface and MemorySessionPersistence

**Files:**
- Create: `src/db/session-persistence.ts`
- Create: `src/db/memory-persistence.ts`
- Test: `__tests__/db/memory-persistence.test.ts`

- [ ] **Step 1: Write failing tests for MemorySessionPersistence**

Create `__tests__/db/memory-persistence.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MemorySessionPersistence } from "../../src/db/memory-persistence";
import type { ManagedSession } from "../../src/types";

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_abc123",
    conversationId: "conv_xyz",
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-18T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

describe("MemorySessionPersistence", () => {
  it("implements all interface methods as no-ops", async () => {
    const persistence = new MemorySessionPersistence();
    const session = makeSession();

    // All methods should resolve without error
    await persistence.save(session);
    await persistence.update("ses_abc123", { status: "completed" });
    await persistence.remove("ses_abc123");

    // loadAll returns empty array
    const loaded = await persistence.loadAll();
    expect(loaded).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/memory-persistence.test.ts
```
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/db/session-persistence.ts` (interface only)**

```typescript
import type { ManagedSession } from "../types";

export interface SessionPersistence {
  save(session: ManagedSession): Promise<void>;
  update(sessionId: string, updates: Partial<ManagedSession>): Promise<void>;
  remove(sessionId: string): Promise<void>;
  loadAll(): Promise<ManagedSession[]>;
}
```

- [ ] **Step 4: Implement `src/db/memory-persistence.ts`**

```typescript
import type { ManagedSession } from "../types";
import type { SessionPersistence } from "./session-persistence";

export class MemorySessionPersistence implements SessionPersistence {
  async save(_session: ManagedSession): Promise<void> {}
  async update(_sessionId: string, _updates: Partial<ManagedSession>): Promise<void> {}
  async remove(_sessionId: string): Promise<void> {}
  async loadAll(): Promise<ManagedSession[]> {
    return [];
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run __tests__/db/memory-persistence.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/session-persistence.ts src/db/memory-persistence.ts __tests__/db/memory-persistence.test.ts
git commit -m "feat(streamer): add SessionPersistence interface and MemorySessionPersistence"
```

---

### Task 5: PgSessionPersistence

**Files:**
- Create: `src/db/pg-session-persistence.ts`
- Test: `__tests__/db/pg-session-persistence.test.ts`

- [ ] **Step 1: Write failing tests for PgSessionPersistence**

Create `__tests__/db/pg-session-persistence.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "../../src/types";

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "ses_abc123",
    conversationId: "conv_xyz",
    projectPath: "/tmp/project",
    projectName: "project",
    branch: "main",
    status: "running",
    startedAt: new Date("2026-04-18T10:00:00Z"),
    completedAt: null,
    promptCount: 0,
    lastOutput: "",
    ...overrides,
  };
}

// Import after mocks are set up
import { PgSessionPersistence } from "../../src/db/pg-session-persistence";

describe("PgSessionPersistence", () => {
  let persistence: PgSessionPersistence;

  beforeEach(() => {
    mockQuery.mockReset();
    persistence = new PgSessionPersistence(mockPool as any);
  });

  describe("save", () => {
    it("inserts a managed session with parameterized query", async () => {
      mockQuery.mockResolvedValueOnce({});
      const session = makeSession();

      await persistence.save(session);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO managed_sessions");
      expect(sql).toContain("$1");
      expect(params).toContain("ses_abc123");
      expect(params).toContain("conv_xyz");
      expect(params).toContain("/tmp/project");
      expect(params).toContain("project");
      expect(params).toContain("main");
      expect(params).toContain("running");
    });

    it("uses ON CONFLICT to upsert", async () => {
      mockQuery.mockResolvedValueOnce({});
      await persistence.save(makeSession());

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("ON CONFLICT");
    });
  });

  describe("update", () => {
    it("updates only provided fields", async () => {
      mockQuery.mockResolvedValueOnce({});

      await persistence.update("ses_abc123", {
        status: "completed",
        completedAt: new Date("2026-04-18T10:05:00Z"),
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("UPDATE managed_sessions");
      expect(sql).toContain("WHERE id = ");
      expect(params).toContain("ses_abc123");
    });

    it("does nothing when updates object is empty", async () => {
      await persistence.update("ses_abc123", {});
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes by session id with parameterized query", async () => {
      mockQuery.mockResolvedValueOnce({});

      await persistence.remove("ses_abc123");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM managed_sessions");
      expect(params).toEqual(["ses_abc123"]);
    });
  });

  describe("loadAll", () => {
    it("returns deserialized ManagedSession objects", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "ses_abc123",
            conversation_id: "conv_xyz",
            project_path: "/tmp/project",
            project_name: "project",
            branch: "main",
            status: "running",
            started_at: new Date("2026-04-18T10:00:00Z"),
            completed_at: null,
            prompt_count: 0,
            last_output: "",
          },
        ],
      });

      const sessions = await persistence.loadAll();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses_abc123");
      expect(sessions[0].conversationId).toBe("conv_xyz");
      expect(sessions[0].projectPath).toBe("/tmp/project");
      expect(sessions[0].startedAt).toEqual(new Date("2026-04-18T10:00:00Z"));
      expect(sessions[0].completedAt).toBeNull();
    });

    it("returns empty array when no rows", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const sessions = await persistence.loadAll();
      expect(sessions).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run __tests__/db/pg-session-persistence.test.ts
```
Expected: FAIL — module `../../src/db/pg-session-persistence` does not exist.

- [ ] **Step 3: Implement `src/db/pg-session-persistence.ts`**

```typescript
import type pg from "pg";
import type { ManagedSession } from "../types";
import type { SessionPersistence } from "./session-persistence";

export class PgSessionPersistence implements SessionPersistence {
  constructor(private pool: pg.Pool) {}

  async save(session: ManagedSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO managed_sessions (
        id, conversation_id, project_path, project_name, branch,
        status, started_at, completed_at, prompt_count, last_output
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        prompt_count = EXCLUDED.prompt_count,
        last_output = EXCLUDED.last_output,
        updated_at = NOW()`,
      [
        session.id,
        session.conversationId,
        session.projectPath,
        session.projectName,
        session.branch,
        session.status,
        session.startedAt,
        session.completedAt,
        session.promptCount,
        session.lastOutput,
      ],
    );
  }

  async update(sessionId: string, updates: Partial<ManagedSession>): Promise<void> {
    const fieldMap: Record<string, string> = {
      conversationId: "conversation_id",
      projectPath: "project_path",
      projectName: "project_name",
      branch: "branch",
      status: "status",
      startedAt: "started_at",
      completedAt: "completed_at",
      promptCount: "prompt_count",
      lastOutput: "last_output",
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const [tsKey, dbCol] of Object.entries(fieldMap)) {
      if (tsKey in updates) {
        setClauses.push(`${dbCol} = $${paramIdx}`);
        values.push((updates as any)[tsKey]);
        paramIdx++;
      }
    }

    if (setClauses.length === 0) return;

    setClauses.push(`updated_at = NOW()`);
    values.push(sessionId);

    await this.pool.query(
      `UPDATE managed_sessions SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values,
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM managed_sessions WHERE id = $1", [sessionId]);
  }

  async loadAll(): Promise<ManagedSession[]> {
    const { rows } = await this.pool.query<{
      id: string;
      conversation_id: string;
      project_path: string;
      project_name: string;
      branch: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      prompt_count: number;
      last_output: string;
    }>("SELECT * FROM managed_sessions ORDER BY started_at DESC");

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      branch: row.branch,
      status: row.status as ManagedSession["status"],
      startedAt: row.started_at,
      completedAt: row.completed_at,
      promptCount: row.prompt_count,
      lastOutput: row.last_output,
    }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run __tests__/db/pg-session-persistence.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/pg-session-persistence.ts __tests__/db/pg-session-persistence.test.ts
git commit -m "feat(streamer): add PgSessionPersistence with parameterized queries"
```

---

### Task 6: Wire Persistence into SessionStore

**Files:**
- Modify: `src/session-store.ts`
- Modify: `__tests__/session-store.test.ts`

- [ ] **Step 1: Write new tests for persistence-backed SessionStore**

Add these tests to the bottom of `__tests__/session-store.test.ts`, after the existing `describe("SessionStore", ...)` block:

```typescript
import { vi } from "vitest";
import type { SessionPersistence } from "../src/db/session-persistence";

function makePersistenceMock(): SessionPersistence {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
  };
}

describe("SessionStore with persistence", () => {
  it("calls persistence.save on addManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    const session = makeManagedSession();

    store.addManaged(session);

    expect(persistence.save).toHaveBeenCalledWith(session);
  });

  it("calls persistence.update on updateManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    const updates = { status: "completed" as const };
    store.updateManaged("ses_abc123", updates);

    expect(persistence.update).toHaveBeenCalledWith("ses_abc123", updates);
  });

  it("does not call persistence.update for nonexistent session", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);

    store.updateManaged("nonexistent", { status: "failed" });

    expect(persistence.update).not.toHaveBeenCalled();
  });

  it("calls persistence.remove on removeManaged", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);
    store.addManaged(makeManagedSession());

    store.removeManaged("ses_abc123");

    expect(persistence.remove).toHaveBeenCalledWith("ses_abc123");
  });

  it("does not call persistence.remove for nonexistent session", () => {
    const persistence = makePersistenceMock();
    const store = new SessionStore(persistence);

    store.removeManaged("nonexistent");

    expect(persistence.remove).not.toHaveBeenCalled();
  });

  it("rehydrates managed sessions from persistence", async () => {
    const session = makeManagedSession();
    const persistence = makePersistenceMock();
    (persistence.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([session]);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    const resp = store.get("ses_abc123");
    expect(resp).not.toBeNull();
    expect(resp?.source).toBe("managed");
    expect(resp?.conversationId).toBe("conv_xyz");
  });

  it("rehydrated sessions dedupe discovered processes", async () => {
    const managed = makeManagedSession({ conversationId: "shared_conv" });
    const persistence = makePersistenceMock();
    (persistence.loadAll as ReturnType<typeof vi.fn>).mockResolvedValue([managed]);

    const store = new SessionStore(persistence);
    await store.rehydrate();

    // Add discovered with same conversationId
    store.setDiscovered([makeDiscoveredProcess({ conversationId: "shared_conv" })]);

    const all = store.list();
    // Only managed should appear — discovered is deduped
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe("managed");
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail (old tests still pass)**

```bash
npx vitest run __tests__/session-store.test.ts
```
Expected: existing tests PASS, new tests FAIL because `SessionStore` constructor doesn't accept persistence param yet.

- [ ] **Step 3: Modify `src/session-store.ts` to accept persistence**

Replace the full content of `src/session-store.ts`:

```typescript
import type { DiscoveredProcess, ManagedSession, SessionResponse } from "./types";
import type { SessionPersistence } from "./db/session-persistence";

export class SessionStore {
  private managed = new Map<string, ManagedSession>();
  private discovered = new Map<number, DiscoveredProcess>();
  private persistence: SessionPersistence | null;

  constructor(persistence?: SessionPersistence) {
    this.persistence = persistence ?? null;
  }

  addManaged(session: ManagedSession): void {
    this.managed.set(session.id, session);
    this.persistence?.save(session);
  }

  updateManaged(sessionId: string, updates: Partial<ManagedSession>): ManagedSession | null {
    const session = this.managed.get(sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    this.persistence?.update(sessionId, updates);
    return session;
  }

  removeManaged(sessionId: string): boolean {
    const existed = this.managed.delete(sessionId);
    if (existed) {
      this.persistence?.remove(sessionId);
    }
    return existed;
  }

  getManaged(sessionId: string): ManagedSession | null {
    return this.managed.get(sessionId) ?? null;
  }

  async rehydrate(): Promise<void> {
    if (!this.persistence) return;
    const sessions = await this.persistence.loadAll();
    for (const session of sessions) {
      this.managed.set(session.id, session);
    }
  }

  setDiscovered(processes: DiscoveredProcess[]): void {
    this.discovered.clear();
    for (const proc of processes) {
      this.discovered.set(proc.pid, proc);
    }
  }

  list(): SessionResponse[] {
    const results: SessionResponse[] = [];

    // Collect managed conversation IDs so we can skip discovered duplicates
    const managedConvIds = new Set<string>();
    for (const s of this.managed.values()) {
      results.push(managedToResponse(s));
      if (s.conversationId) managedConvIds.add(s.conversationId);
    }

    for (const d of this.discovered.values()) {
      // Skip discovered processes that are already tracked as managed sessions
      if (d.conversationId && managedConvIds.has(d.conversationId)) continue;
      results.push(discoveredToResponse(d));
    }

    return results;
  }

  get(sessionId: string): SessionResponse | null {
    const managed = this.managed.get(sessionId);
    if (managed) return managedToResponse(managed);

    // Check discovered by disc_<pid> format
    if (sessionId.startsWith("disc_")) {
      const pid = Number.parseInt(sessionId.slice(5), 10);
      const disc = this.discovered.get(pid);
      if (disc) return discoveredToResponse(disc);
    }

    return null;
  }
}

function managedToResponse(s: ManagedSession): SessionResponse {
  return {
    id: s.id,
    status: s.status,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    lastOutput: s.lastOutput,
    elapsedMs: (s.completedAt ?? new Date()).getTime() - s.startedAt.getTime(),
    promptCount: s.promptCount,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    conversationId: s.conversationId,
    source: "managed",
  };
}

function discoveredToResponse(d: DiscoveredProcess): SessionResponse {
  return {
    id: `disc_${d.pid}`,
    status: "running",
    projectPath: d.projectPath,
    projectName: d.projectName,
    branch: d.branch,
    lastOutput: "",
    elapsedMs: Date.now() - d.startedAt.getTime(),
    promptCount: 0,
    startedAt: d.startedAt.toISOString(),
    completedAt: null,
    conversationId: d.conversationId ?? "",
    source: "discovered",
    pid: d.pid,
  };
}
```

- [ ] **Step 4: Run all session-store tests**

```bash
npx vitest run __tests__/session-store.test.ts
```
Expected: all PASS (old tests unchanged — `new SessionStore()` with no args still works, new tests verify persistence calls).

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts __tests__/session-store.test.ts
git commit -m "feat(streamer): wire SessionPersistence into SessionStore with rehydrate"
```

---

### Task 7: Wire DB into StreamerServer

**Files:**
- Modify: `src/server.ts:25-48` (constructor), `src/server.ts:105-116` (listen), `src/server.ts:118-125` (close)
- Create: `src/db/index.ts`

- [ ] **Step 1: Create barrel export `src/db/index.ts`**

```typescript
export { getDbConfig, isDbEnabled } from "./config";
export type { DbConfig } from "./config";
export { createPool, maskConnectionString } from "./pool";
export { runMigrations } from "./migrations";
export { MemorySessionPersistence } from "./memory-persistence";
export { PgSessionPersistence } from "./pg-session-persistence";
export type { SessionPersistence } from "./session-persistence";
```

- [ ] **Step 2: Modify `src/server.ts` — add imports and DB fields**

At the top of `src/server.ts`, add after the existing imports (after line 23):

```typescript
import { isDbEnabled, getDbConfig, createPool, runMigrations, maskConnectionString } from "./db";
import { PgSessionPersistence } from "./db/pg-session-persistence";
import type pg from "pg";
```

Add a new private field in `StreamerServer` class (after `private scanProfiles` around line 40):

```typescript
  private dbPool: pg.Pool | null = null;
```

- [ ] **Step 3: Modify constructor to create pool + persistence when DB enabled**

Replace the `this.sessionStore = new SessionStore();` line (line 47) with:

```typescript
    // Set up optional DB persistence
    let persistence: import("./db/session-persistence").SessionPersistence | undefined;
    const dbConfig = getDbConfig();
    if (dbConfig) {
      this.dbPool = createPool(dbConfig);
      persistence = new PgSessionPersistence(this.dbPool);
      if (this.verbose) {
        console.log(`Database enabled: ${maskConnectionString(dbConfig.connectionString)}`);
      }
    }
    this.sessionStore = new SessionStore(persistence);
```

- [ ] **Step 4: Modify `listen()` to run migrations + rehydrate**

Replace the `listen` method (lines 105-116) with:

```typescript
  async listen(port: number): Promise<void> {
    // Run DB migrations and rehydrate sessions before accepting requests
    if (this.dbPool) {
      await runMigrations(this.dbPool);
      await this.sessionStore.rehydrate();
      if (this.verbose) {
        console.log("Database migrations applied, sessions rehydrated");
      }
    }

    return new Promise((resolve) => {
      this.httpServer.listen(port, () => {
        if (this.verbose) {
          console.log(`Streamer server listening on port ${port}`);
        }
        // Warm the conversation index so the first History request is less likely to block on disk I/O.
        void this.getScanner().catch(() => {});
        resolve();
      });
    });
  }
```

- [ ] **Step 5: Modify `close()` to shut down DB pool**

Replace the `close` method (lines 118-125) with:

```typescript
  async close(): Promise<void> {
    this.ptyManager.dispose();
    this.fileWatcher.dispose();
    this.wsHub.dispose();
    if (this.dbPool) {
      await this.dbPool.end();
    }
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }
```

- [ ] **Step 6: Run existing server tests to verify no regressions**

```bash
npx vitest run __tests__/server.test.ts
```
Expected: all PASS — no DB env vars set means memory-only mode, identical to before.

- [ ] **Step 7: Run full test suite**

```bash
npm test
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/index.ts src/server.ts
git commit -m "feat(streamer): wire Postgres pool, migrations, and persistence into StreamerServer"
```

---

### Task 8: Update Exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add DB exports to `src/index.ts`**

Add after the existing exports (after line 8):

```typescript
export { isDbEnabled, getDbConfig, createPool, maskConnectionString } from "./db";
export type { DbConfig, SessionPersistence } from "./db";
export { MemorySessionPersistence } from "./db/memory-persistence";
export { PgSessionPersistence } from "./db/pg-session-persistence";
```

- [ ] **Step 2: Verify build succeeds**

```bash
npm run build
```
Expected: build succeeds, `dist/` contains updated ESM/CJS/types.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(streamer): export DB modules from package entry point"
```

---

### Task 9: Integration Test

**Files:**
- Create: `__tests__/db/integration.test.ts`

This test requires a real Postgres and is gated by the `THREADBASE_DATABASE_URL` env var. It is skipped during normal `npm test`.

- [ ] **Step 1: Write the integration test**

Create `__tests__/db/integration.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
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
    // Clean up any leftover test data
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
    expect(found!.conversationId).toBe("conv_integration_test");
    expect(found!.projectPath).toBe("/tmp/integration-test");
    expect(found!.status).toBe("running");
  });

  it("update changes persisted fields", async () => {
    const session = makeSession();
    await persistence.save(session);

    const completedAt = new Date();
    await persistence.update(session.id, { status: "completed", completedAt });

    const loaded = await persistence.loadAll();
    const found = loaded.find((s) => s.id === session.id);

    expect(found!.status).toBe("completed");
    expect(found!.completedAt).toEqual(completedAt);
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
    expect(resp!.source).toBe("managed");
    expect(resp!.conversationId).toBe("conv_rehydrate_test");
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
    const matching = all.filter(
      (s) => s.conversationId === "conv_dedupe_test",
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].source).toBe("managed");
  });
});
```

- [ ] **Step 2: Verify test is skipped without DB**

```bash
npx vitest run __tests__/db/integration.test.ts
```
Expected: test suite shows as SKIPPED (no `THREADBASE_DATABASE_URL` set).

- [ ] **Step 3: Commit**

```bash
git add __tests__/db/integration.test.ts
git commit -m "test(streamer): add Postgres integration tests (gated by env var)"
```

---

### Task 10: Documentation and Docker Compose

**Files:**
- Create: `docs/database.md`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docs/database.md`**

```markdown
# Database Configuration

The streamer can optionally use PostgreSQL to persist managed session metadata across restarts.

## Activation

Set the `THREADBASE_DATABASE_URL` environment variable to a PostgreSQL connection URI:

```bash
export THREADBASE_DATABASE_URL="postgresql://user:password@localhost:5432/threadbase"
```

When this variable is **unset or empty**, the streamer runs in memory-only mode with no database dependency.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `THREADBASE_DATABASE_URL` | Yes (to enable DB) | — | PostgreSQL connection URI |
| `THREADBASE_DATABASE_SSL` | No | — | SSL mode: `require` or `disable` |
| `THREADBASE_DATABASE_POOL_MAX` | No | `10` | Maximum connections in pool |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | No | — | Query timeout in milliseconds |

## What Gets Persisted (Phase 1)

Managed session metadata — sessions created via `POST /api/sessions/resume`:

- Session ID, conversation ID, project path/name, branch
- Status, timestamps, prompt count, last output

On startup with DB configured, these sessions are rehydrated and merged with discovered processes using the same deduplication rule (discovered processes with the same `conversationId` as a managed session are excluded).

## Supported Postgres Versions

PostgreSQL 15 or later.

## Migrations

SQL migrations run automatically on startup when the database is configured. They are tracked in a `_migrations` table to avoid re-running.

Migration files: `src/db/migrations/`

## Local Development

Use the included `docker-compose.yml`:

```bash
docker compose up -d postgres
export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"
npm run dev
```

## Precedence

Environment variables are the only configuration source for database settings in v1. The `server.yaml` file is not used for database configuration.
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: threadbase
      POSTGRES_PASSWORD: threadbase
      POSTGRES_DB: threadbase
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

- [ ] **Step 3: Commit**

```bash
git add docs/database.md docker-compose.yml
git commit -m "docs(streamer): add database configuration guide and docker-compose for local dev"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run lint + type check**

```bash
npm run lint
```
Expected: PASS.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```
Expected: all PASS. Integration test skipped (no DB env).

- [ ] **Step 3: Run build**

```bash
npm run build
```
Expected: PASS.

- [ ] **Step 4: Verify tsup externals — `pg` should be external**

Check that `pg` is not bundled into the CLI output. Open `tsup.config.ts` and confirm `pg` needs to be added to the CLI entry's external list. If `pg` is a runtime dependency it should already work via the `noExternal` regex that only includes non-`node-pty` packages. Verify:

```bash
grep -c "require.*pg" dist/cli.cjs | head -5
```

If `pg` is bundled (grep returns matches), add `"pg"` to the CLI tsup entry's `external` array alongside `"node-pty"`. If it's lazily available via the bundled code, no change needed.

- [ ] **Step 5: Manual smoke test (memory-only mode)**

```bash
# No DB env — should work exactly like before
node dist/cli.cjs serve --verbose --local-no-auth
# In another terminal:
curl http://localhost:3456/api/sessions
# Should return [] with no DB errors in server output
```

- [ ] **Step 6: Manual smoke test (DB mode, requires docker compose up)**

```bash
docker compose up -d postgres
export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"
node dist/cli.cjs serve --verbose --local-no-auth
# Server should log "Database enabled: postgresql://threadbase:***@localhost:5432/threadbase"
# and "Database migrations applied, sessions rehydrated"
curl http://localhost:3456/api/sessions
# Should return []
```
