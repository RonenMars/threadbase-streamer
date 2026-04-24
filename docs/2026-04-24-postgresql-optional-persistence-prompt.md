# Prompt: Optional PostgreSQL for the Threadbase streamer

Use this document as the **full specification** for an implementation pass (AI agent, contractor, or self).

**What to paste into an agent chat:** Prefer the **entire document** (from “Goal” through “Acceptance criteria”). That preserves phased scope, security notes, testing expectations, and the deliverables checklist. The **Implementation brief** at the bottom is only a condensed reminder for tight context windows or follow-up turns—it is not a substitute for the full spec.

## Goal

Extend the Threadbase **streamer** so it can optionally use **PostgreSQL** for persistence and/or caching when database-related **environment variables** are set.

If those variables are **absent**, runtime behavior must match **today’s** streamer: in-memory session state only, no database dependency, no new required configuration files.

## Current behavior (do not break)

- `SessionStore` (`src/session-store.ts`) keeps **managed** and **discovered** sessions in **in-memory `Map`s** only.
- **Managed** sessions are created via `POST /api/sessions/resume` (see `StreamerServer` in `src/server.ts`).
- **Discovered** sessions are refreshed on **`GET /api/sessions`** via `discoverClaudeProcesses()` and `setDiscovered()`.
- **Neither** bucket is persisted across process restart; restarting the streamer clears managed entries until the user resumes again.
- Existing config (e.g. `~/.threadbase/server.yaml` for `api_key`) stays supported. Document how **env vs file** interact if you add DB URL to file as an optional extension.

## Configuration (env-first, optional)

Define a small, documented set of environment variables. Suggested primary variable (pick one name and use it consistently):

| Variable | Required when DB enabled | Purpose |
|----------|---------------------------|---------|
| `THREADBASE_DATABASE_URL` | Yes, if DB mode on | PostgreSQL connection URI |
| `THREADBASE_DATABASE_SSL` | No | `require`, `disable`, etc., if not encoded in URL |
| `THREADBASE_DATABASE_POOL_MAX` | No | Connection pool cap (sensible default) |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | No | Optional query timeout |

**Activation rule:** If `THREADBASE_DATABASE_URL` (or the chosen primary var) is **unset or empty**, the streamer must **not** open a pool, **not** run migrations at startup, and must use **only** the existing in-memory paths.

If you support reading DB settings from `server.yaml` as well, specify precedence: **e.g. env overrides file**.

## Architecture

1. **Abstraction:** Introduce a narrow interface (e.g. `SessionPersistence` / `SessionRepository`) used by the server layer so HTTP handlers and `SessionStore` (or a successor) stay testable without a live DB.
2. **Dual mode:**  
   - **Memory-only (default):** identical semantics to current code.  
   - **DB enabled:** Postgres backs chosen data; in-memory structures may still exist for hot paths if needed, but **source of truth** for persisted fields must be defined (prefer DB for rows you claim survive restart).
3. **Migrations:** Versioned SQL or a small migration runner committed in-repo; run automatically on startup when DB is configured, or document a `npm run db:migrate` step—pick one approach and document it.

## Scope: what to store (phased)

### Phase 1 (recommended minimum viable)

- **Persist managed session metadata** so it survives streamer restart: fields needed to rebuild `SessionResponse` / `ManagedSession` for list and `GET /api/sessions/:id` (ids, `conversation_id`, `project_path`, `project_name`, `branch`, `status`, `started_at`, `completed_at`, `prompt_count`, `last_output` or equivalent—align with `src/types.ts`).
- On startup with DB configured: **rehydrate** managed rows into the store (or serve from repository) and **merge** with `discoverClaudeProcesses()` using the **same deduplication rule** as today (skip discovered when `conversationId` already managed).

### Phase 2 (optional; only after Phase 1 is solid)

- **Cache** expensive read paths (e.g. conversation index snippets, search results) with explicit **TTL** and/or **invalidation** hooks tied to file watcher or known mutations. If invalidation is unclear, **omit** Phase 2 in the first PR and leave a short ADR or TODO.

**Explicit non-goals for v1:** Replacing the scanner’s on-disk index entirely; changing mobile API shapes unless a new field is strictly necessary (prefer additive, optional JSON fields).

## Security and operations

- Use **parameterized queries** only; never interpolate secrets into SQL.
- Do **not** log the full database URL (strip password from logs).
- Document supported **Postgres major version** (e.g. 15+).
- Connection pooling with graceful shutdown on `server.close()`.

## Testing

- **Without** `THREADBASE_DATABASE_URL`: existing test suite passes; **no** DB client constructed (or lazy-import only after positive config—document choice).
- **With** URL pointed at a test DB: integration test (Testcontainers, or CI service container, or documented local script) proving: resume creates/updates a row; restart simulation reloads managed session; dedupe with discovered still works.
- Unit tests for the repository with a mocked driver if that matches repo style.

## Deliverables checklist

- [ ] README or `docs/` section listing env vars and activation rules.
- [ ] SQL migrations + schema for Phase 1 tables.
- [ ] Repository implementation + wiring in `StreamerServer` / session lifecycle.
- [ ] Startup rehydration + dedupe with discovery.
- [ ] Tests for memory-only and DB-enabled paths.
- [ ] Optional: `docker-compose.yml` snippet with Postgres for local dev.

## Acceptance criteria

1. With DB env **unset**, behavior and public HTTP/WS contracts match the pre-change streamer (existing tests green).
2. With DB env **set** and Postgres available: after `POST /api/sessions/resume`, managed session metadata is **written** to Postgres; after process restart, `GET /api/sessions` still returns that session as **`source: "managed"`** with correct core fields (or documented subset if output is intentionally trimmed).
3. Discovered listing behavior is unchanged except **no duplicate** for the same `conversation_id` as a rehydrated managed session.

---

## Implementation brief (optional shortcut)

You are working in the **Threadbase streamer** (`streamer/`, Node + TypeScript).

**Task:** Add **optional** PostgreSQL support gated by env (e.g. `THREADBASE_DATABASE_URL`). If unset, keep **100%** current in-memory `SessionStore` behavior—no DB, no migrations.

**Phase 1:** Persist **managed** session metadata to Postgres on resume/updates; on startup with DB configured, run migrations, open a pool, **rehydrate** managed sessions and merge with existing `discoverClaudeProcesses()` dedupe. Use a small repository interface; parameterized queries; no password in logs.

**Deliver:** migrations, wiring, docs for env vars, and tests proving no-env path unchanged and env path survives restart for managed sessions. Optional Phase 2 caching only with TTL/invalidation—defer if not trivial.

**Acceptance:** Same checklist as in the full doc above.
