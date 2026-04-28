# @threadbase/streamer

PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. Manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API for conversation history, search, and session control.

## Quick Start

```bash
npm install
npm run build
node dist/cli.cjs serve --verbose --local-no-auth
```

The server starts on `http://localhost:3456` by default with WebSocket at `ws://localhost:3456/ws`.

## Persistence Modes

The streamer supports two persistence modes for managed sessions (sessions created via `POST /api/sessions/resume`):

### Memory-only (default)

No configuration needed. Sessions are kept in-memory and lost when the process restarts. Discovered processes (running `claude` instances found via process scanning) are always refreshed live regardless of persistence mode.

```bash
# Just start the server — no env vars, no database
node dist/cli.cjs serve
```

### PostgreSQL-backed

Set `THREADBASE_DATABASE_URL` to enable. Managed session metadata is written to Postgres on every mutation and rehydrated on startup, so sessions survive process restarts.

```bash
# 1. Start a local Postgres (or use an existing one)
docker compose up -d postgres

# 2. Set the connection string
export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"

# 3. Start the server — migrations run automatically
node dist/cli.cjs serve --verbose
```

On startup the server will log:
```
Database enabled: postgresql://threadbase:***@localhost:5432/threadbase
Database migrations applied, sessions rehydrated
```

To switch back to memory-only, unset the variable:
```bash
unset THREADBASE_DATABASE_URL
node dist/cli.cjs serve
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `THREADBASE_DATABASE_URL` | Yes (to enable DB) | — | PostgreSQL connection URI |
| `THREADBASE_DATABASE_SSL` | No | — | `require` or `disable` |
| `THREADBASE_DATABASE_POOL_MAX` | No | `10` | Maximum pool connections |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | No | — | Query timeout in ms |

See [docs/database.md](docs/database.md) for full details on the database configuration.

## Architecture

Three layers: **core engine** (`src/*.ts`) -> **API layer** (`src/index.ts` exports) -> **CLI wrapper** (`cli/`).

```
src/
  server.ts           HTTP + WebSocket server, request routing, auth
  session-store.ts    In-memory registry with optional DB persistence
  pty-manager.ts      Spawn/resume Claude sessions via node-pty
  process-discovery.ts  Find running claude processes (pgrep/lsof)
  file-watcher.ts     Tail JSONL files for structured events
  ws-hub.ts           WebSocket broadcast hub
  auth.ts             Bearer token generation/validation
  db/
    config.ts           Env var parsing (isDbEnabled, getDbConfig)
    pool.ts             pg.Pool creation with password masking
    migrations.ts       SQL migration runner
    migrations/         Versioned .sql files
    session-persistence.ts  SessionPersistence interface
    memory-persistence.ts   No-op implementation (default)
    pg-session-persistence.ts  Postgres implementation
```

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/info` | Server info (version, platform, active sessions) |
| GET | `/api/sessions` | List managed + discovered sessions |
| GET | `/api/sessions/:id` | Get single session |
| POST | `/api/sessions/resume` | Resume a conversation (creates managed session) |
| POST | `/api/sessions/:id/input` | Send input to a managed session |
| POST | `/api/sessions/:id/cancel` | Cancel a managed session |
| GET | `/api/sessions/:id/output` | Get terminal output buffer |
| GET | `/api/conversations` | Paginated conversation history |
| GET | `/api/conversations/:id` | Full conversation with messages |
| GET | `/api/search?q=...` | Full-text search across conversations |
| POST | `/api/pair/start` | Mint a short-lived pair token (authenticated) |
| POST | `/api/pair/exchange` | Trade a pair token + client public key for a sealed API key (unauthenticated) |

## Mobile Pairing (QR)

Mobile clients pair by scanning a QR that encodes a `threadbase://pair?url=…&token=…&exp=…` URL. The token is single-use and expires after 180 seconds; the client then trades it (with its X25519 public key) at `/api/pair/exchange` for a sealed-box-encrypted API key, so the key never appears in the QR.

A QR is printed automatically when the server starts:

```bash
node dist/cli.cjs serve
```

Skip it with `--no-pair-qr`. To re-print a fresh QR while a server is already running:

```bash
node dist/cli.cjs pair          # uses default port 3456
node dist/cli.cjs pair -p 4000
```

If the mobile device can't reach `localhost`, point clients at a reachable address so the QR encodes it. In order of precedence:

1. `--public-url <https-url>` flag on `serve`
2. `THREADBASE_PUBLIC_URL` environment variable
3. `public_url:` in `~/.threadbase/server.yaml`

`https://` is required (except for `localhost`).

## Development

```bash
npm test              # Run all tests
npm run lint          # Type-check + Biome lint
npm run format        # Auto-format
npm run build         # Build ESM/CJS + copy migrations
npm run dev           # Watch mode
```

### Running with a Local Postgres

```bash
docker compose up -d postgres
export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"
npm run dev
```

### Integration Tests

Integration tests require a running Postgres and are skipped by default:

```bash
export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"
npm test
```

## Dependencies

- `@threadbase/scanner` — conversation history scanning and search
- `node-pty` — native PTY management
- `ws` — WebSocket server
- `pg` — PostgreSQL client (lazy-loaded, only when DB is configured)
- `commander` — CLI argument parsing
