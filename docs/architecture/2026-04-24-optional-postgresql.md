# Optional PostgreSQL Persistence — Design

**Date:** 2026-04-24
**Status:** Approved

## Goal

Extend the streamer so it can optionally use PostgreSQL for managed session persistence when `THREADBASE_DATABASE_URL` is set. If unset, behavior is identical to today's in-memory-only `SessionStore`.

## Architecture

A `SessionPersistence` interface with two implementations:

- `MemorySessionPersistence` — no-op (default when DB not configured)
- `PgSessionPersistence` — Postgres-backed via `pg` (node-postgres)

`SessionStore` is injected with a `SessionPersistence` at construction time. Writes are **write-through** (memory + DB updated together). Reads always hit the in-memory Map for zero-latency hot paths.

On startup with DB configured: run migrations, open pool, rehydrate managed sessions from DB into memory, then merge with `discoverClaudeProcesses()` using existing dedupe logic.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `THREADBASE_DATABASE_URL` | Yes (to enable DB) | PostgreSQL connection URI |
| `THREADBASE_DATABASE_SSL` | No | `require`, `disable`, etc. |
| `THREADBASE_DATABASE_POOL_MAX` | No | Pool cap (default: 10) |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | No | Query timeout |

No `server.yaml` support in v1 — env-only.

## Postgres Client

`pg` (node-postgres) — lightweight, widely trusted, built-in pool with graceful shutdown.

## Migration Strategy

Versioned SQL files in `src/db/migrations/` with a minimal runner tracking applied versions in a `_migrations` table. Runs automatically on startup when DB is configured.

## Schema (Phase 1)

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

## New Files

| File | Purpose |
|------|---------|
| `src/db/config.ts` | Read env vars, build pool config, `isDbEnabled()` |
| `src/db/pool.ts` | Create/close `pg.Pool`, mask password in logs |
| `src/db/migrations.ts` | Migration runner |
| `src/db/migrations/001_create_managed_sessions.sql` | Phase 1 schema |
| `src/db/session-persistence.ts` | `SessionPersistence` interface + `PgSessionPersistence` |
| `src/db/memory-persistence.ts` | `MemorySessionPersistence` (no-op) |
| `__tests__/db/session-persistence.test.ts` | Unit tests with mocked pg |
| `__tests__/db/integration.test.ts` | Integration test (requires Postgres) |
| `docs/database.md` | Env vars, activation rules, local dev setup |

## SessionStore Changes

- Constructor accepts optional `SessionPersistence`
- `addManaged` / `updateManaged` / `removeManaged` call through to persistence
- New `rehydrate()` method loads all managed sessions from persistence into the Map
- No persistence injected = exact current behavior (Maps only)

## StreamerServer Changes

- Constructor: check `isDbEnabled()`, if yes create pool + persistence
- `listen()`: run migrations, rehydrate managed sessions
- `close()`: call `pool.end()` for graceful shutdown
- `handleResume` / `onStatusChange`: no changes (write-through happens inside SessionStore)

## Testing

- Existing tests pass unchanged (no persistence injected)
- Unit tests mock `pg.Pool` to verify SQL + params
- Integration test guarded by `THREADBASE_DATABASE_URL` env var, skipped in normal `npm test`

## Phase 2 (deferred)

Cache expensive read paths (conversation index, search results) with TTL/invalidation. Only after Phase 1 is solid.
