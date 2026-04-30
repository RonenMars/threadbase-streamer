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
  idle-sweeper.ts     Periodic sweep putting idle sessions on_hold
  reconcile.ts        Mark in-flight sessions on_hold on server restart
  browse.ts           File system browser (list/mkdir)
  uploads.ts          File upload handling for session file attachments
  pair-store.ts       Short-lived pairing token registry
  seal.ts             X25519 sealed-box encryption for mobile pairing
  platform.ts         Platform detection and path resolution
  lan-url.ts          LAN IP resolution for QR code URLs
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
| GET | `/healthz` | Health check (version) |
| GET | `/api/info` | Server info (version, platform, active sessions) |
| GET | `/api/sessions` | List managed + discovered sessions |
| GET | `/api/sessions/count` | Count of active managed sessions |
| GET | `/api/sessions/:id` | Get single session |
| POST | `/api/sessions/start` | Start a new Claude session in a given directory |
| POST | `/api/sessions/resume` | Resume a conversation (creates managed session) |
| POST | `/api/sessions/:id/input` | Send input to a managed session |
| POST | `/api/sessions/:id/cancel` | Cancel a managed session |
| GET | `/api/sessions/:id/output` | Get terminal output buffer |
| POST | `/api/sessions/:id/files` | Upload a file attachment to a session |
| GET | `/api/conversations` | Paginated conversation history |
| GET | `/api/conversations/count` | Count conversations matching optional filters |
| GET | `/api/conversations/:id` | Full conversation with messages |
| GET | `/api/search?q=...` | Full-text search across conversations |
| GET | `/api/browse` | Browse the file system |
| POST | `/api/browse/mkdir` | Create a directory |
| GET | `/api/profiles` | List scan profiles |
| POST | `/api/push/register` | Register a push notification token |
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

## Installing the `tb` command

`tb` is a thin shim that runs the deployed CLI bundle (`~/.threadbase/cli.js`, maintained by `scripts/deploy.sh`). It is independent of any Node version manager and only needs `node` (>=18) on `PATH`.

**macOS / Linux / WSL / Git Bash:**

```bash
scripts/install-tb.sh
# Symlinks bin/tb -> ~/.local/bin/tb (override with TB_INSTALL_DIR=/some/dir)
```

If `~/.local/bin` isn't on your `PATH`, the installer prints the line to add to your shell rc.

**Windows (PowerShell):**

```powershell
pwsh scripts/install-tb.ps1
# Copies bin/tb*, tb.cmd, tb.ps1 to %USERPROFILE%\.threadbase\bin and adds it to user PATH.
# Open a new terminal to pick up the PATH change.
```

**Verify:**

```bash
tb --version
tb pair          # against a running server on default port 3456
tb pair -p 8766  # different port
```

**Override the bundle location** with the `THREADBASE_CLI` env var (or `%THREADBASE_CLI%` on Windows) — useful for pointing at a dev build without redeploying.

> **Lazy-nvm note:** if your shell wraps `node`/`npm` in a lazy nvm function (functions that source `~/.nvm/nvm.sh` on first call), `node` is *not* on `PATH` in fresh shells until you invoke it once. `tb` will fail with "node not found" in that state. Cheapest fix: run `node -v` once per session, or eager-load nvm (`nvm use default --silent` after defining the lazy wrappers).

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
