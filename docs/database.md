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
| `THREADBASE_INSTANCE_ID` | No | OS hostname | Unique identifier for this streamer instance. Sessions are scoped to this ID — each instance only sees its own sessions. Required when multiple instances share a database. |
| `THREADBASE_DATABASE_SSL` | No | — | SSL mode: `require` or `disable` |
| `THREADBASE_DATABASE_POOL_MAX` | No | `10` | Maximum connections in pool |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | No | — | Query timeout in milliseconds |

## What Gets Persisted (Phase 1)

Managed session metadata — sessions created via `POST /api/sessions/resume`:

- Session ID, conversation ID, project path/name, branch
- Status, timestamps, prompt count, last output

On startup with DB configured, these sessions are rehydrated and merged with discovered processes using the same deduplication rule (discovered processes with the same `conversationId` as a managed session are excluded).

## Multi-Instance Support

When multiple streamer instances share a single database (e.g., Neon), each instance must have a unique `THREADBASE_INSTANCE_ID`. All persistence operations (save, update, remove, load) are scoped to this ID, so instances only see and manage their own sessions.

If `THREADBASE_INSTANCE_ID` is not set, it defaults to the OS hostname. Set it explicitly when the hostname is not unique or meaningful (e.g., containers, VMs).

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
