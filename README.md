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

Three layers: **core engine** (`src/*.ts`) → **API layer** (`src/index.ts` exports) → **CLI wrapper** (`cli/`).

### How it works

**Session start → PTY → broadcast**

When a client calls `POST /api/sessions/start` (new conversation) or `POST /api/sessions/resume` (existing conversation), `server.ts` delegates to `PTYManager`, which spawns a `claude` process inside a PTY via `node-pty`. The server returns `202 Accepted` immediately — the PTY launch is async. As the PTY emits output, `PTYManager` appends it to an in-memory ring buffer (64 KB cap per session) and forwards each chunk to `WSHub`, which fans it out to every connected WebSocket client as a `terminal_output` event.

When a WebSocket client subscribes to a session (`subscribe_session`), the server unicasts the full ring buffer as a `terminal_replay` event so the client can reconstruct the current terminal state without an extra HTTP round-trip. Once the PTY process is ready (Claude's first prompt marker appears), the server broadcasts a `session_ready` event with the full session object.

**Session registry**

`SessionStore` is the single source of truth for in-flight state. It holds two maps: *managed sessions* (those with an active or recently-active PTY) and *discovered processes* (externally-running `claude` processes found by `process-discovery.ts` via `pgrep`/`lsof` on Unix or `tasklist`/`wmic` on Windows). When building the session list, managed sessions take priority — a discovered process whose `conversationId` matches an existing managed session is suppressed.

**Conversation cache**

`ConversationCache` (`src/conversation-cache.ts`) maintains a SQLite database of conversation metadata, message tails, projects, and cache metadata. On open, it runs the SQLite migrations under `src/db/migrations/` (tracked in a `schema_migrations` table). It is updated incrementally: `ConversationWatcher` (`src/services/conversations/conversationWatcher.ts`, chokidar-backed) tails JSONL conversation files and emits new lines, which `ConversationCache` parses and upserts. The cache backs the `GET /api/conversations`, `GET /api/sessions`, and `GET /project-chats` endpoints, avoiding a full filesystem scan on every request. Metadata TTL is 5 seconds; the discovery process cache is 15 seconds.

**Projects + cache freshness**

A `projects` row is the canonical identity for a project (UUID + canonical path). Every cached conversation carries a `project_id` foreign key. Project discovery is conversation-driven: as the cache learns about conversations, it upserts one project per unique canonical project path (`src/utils/canonicalizeProjectPath.ts`).

`/project-chats` is the unified active-sessions + historical-conversations list. By default the server short-circuits the rescan when `cache_metadata.last_conversation_id` matches the latest conversation id known to the cache; pass `?refreshConversations=1` (or legacy `?refresh=1`) to force a refresh. The merge step hides any conversation that has been resumed into an active session (matched on `resumedFromConversationId`).

**Idle management & reconciliation**

`IdleSweeper` runs every 30 seconds. When a managed session has been in `waiting_input` state for longer than `idleTimeoutMs` (default 60 s), it calls `PTYManager.putOnHold()`, which sets a tombstone timestamp and sends `SIGINT` to the PTY before the exit handler can misclassify the exit as `failed`. On server restart, `reconcile.ts` scans the session store for any sessions that were `running` or `waiting_input` and marks them `on_hold` — their conversation history is intact and they can be resumed via `POST /api/sessions/resume`.

Clients can also explicitly hold a session by sending `{ type: "hold_session", sessionId }` over WebSocket.

**Mobile pairing**

On startup (or via `tb pair`), the server prints a QR code encoding a `threadbase://pair?url=…&token=…&exp=…` deep-link URL. The token is minted by `pair-store.ts` (single-use, 180 s TTL). The mobile client trades it at `POST /api/pair/exchange` along with its X25519 public key; `seal.ts` encrypts the API key into a NaCl sealed box so the key never appears in the QR or in transit unencrypted.

**Module reference**

```
src/
  server.ts                                HTTP + WebSocket server, request routing, auth, repo wiring
  session-store.ts                         In-memory registry of managed + discovered sessions
  pty-manager.ts                           Spawn/resume Claude sessions via node-pty, ring buffer
  process-discovery.ts                     Find running claude processes (pgrep/lsof on Unix, tasklist/wmic on Windows)
  conversation-cache.ts                    SQLite cache (conversation_meta + tail + projects + cache_metadata + session_names); runs SQLite migrations on open
  ws-hub.ts                                WebSocket broadcast hub, 30 s ping keepalive
  idle-sweeper.ts                          Periodic sweep putting idle waiting_input sessions on_hold
  reconcile.ts                             Mark in-flight sessions on_hold on server restart
  auth.ts                                  Bearer token generation/validation (constant-time compare)
  browse.ts                                File system browser (list/mkdir)
  uploads.ts                               File upload handling for session file attachments
  pair-store.ts                            Short-lived pairing token registry
  seal.ts                                  X25519 sealed-box encryption for mobile pairing
  platform.ts                              Platform detection and path resolution
  lan-url.ts                               LAN IP resolution for QR code URLs
  utils/
    canonicalizeProjectPath.ts             Trim + trailing-slash strip; canonical key for project identity
    dates.ts                               date-fns wrapper: parseIsoDateOrNull, compareIsoDesc
  schemas/
    projectChat.schema.ts                  Discriminated-union ProjectChat zod schema
    queryParams.schema.ts                  /project-chats query params (refresh, refreshConversations)
    messageCursor.schema.ts                Compound cursor for delta message sync
    project.schema.ts                      Project row shape
    conversation.schema.ts                 Scanner output shape
  handlers/
    handleListProjectChats.ts              GET /project-chats — zod-validates query, delegates to listProjectChats
  services/
    projectChats/
      listProjectChats.ts                  Compose /project-chats response (refresh check + merge + sort)
      mergeProjectChats.ts                 Hide resumed-into-active conversations, then sort
      sortProjectChats.ts                  latestMessageAt → updatedAt → createdAt → title
      normalizeSessionToProjectChat.ts     SessionResponse → ProjectChat
      normalizeConversationToProjectChat.ts ConversationListItem → ProjectChat
    projects/
      ensureProjectsForConversations.ts    One project per unique canonical project path
      upsertProjectByPath.ts               Repository adapter
    conversations/
      conversationWatcher.ts               Chokidar tail + directory watcher (replaces former file-watcher.ts)
      refreshConversationCache.ts          Upsert projects, backfill conversation.project_id, update cache_metadata
      shouldRefreshProjectsFromHdd.ts      Latest-conversation-id freshness check
      getLatestConversation.ts             Repository adapter
    sessions/
      createSessionForProjectPath.ts       Link session+conversation to a project after JSONL exists
      ensureSessionProjectIdsFromExistingProjects.ts  Backfill projectId on managed sessions
    cache/
      cacheMetadata.ts                     Helpers over the cache_metadata key/value table
  db/
    config.ts                              Env var parsing (isDbEnabled, getDbConfig)
    pool.ts                                pg.Pool creation with password masking
    sqlite-migrate.ts                      SQLite migration runner (used by ConversationCache.open)
    migrations/                            SQLite versioned .sql files (projects, project_id columns, cache_metadata)
    migrations.ts                          Postgres migration runner
    pg-migrations/                         Postgres versioned .sql files (formerly migrations/)
    repositories/
      projects.repository.ts               UUID + canonical-path upsert
      conversations.repository.ts          Cache wrapper for project_id linking
      sessions.repository.ts               SessionStore wrapper
      cacheMetadata.repository.ts          Get/set/delete on cache_metadata
    session-persistence.ts                 SessionPersistence interface (Postgres optional path)
    memory-persistence.ts                  No-op implementation (default)
    pg-session-persistence.ts              Postgres implementation
scripts/
  migrate.ts                               Apply SQLite migrations to ~/.threadbase/cache/cache.db
  migrate-projects.ts                      Backfill projects + conversation.project_id (idempotent)
  validate-db.ts                           Report conversations missing project_id, duplicate paths, orphans
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
| GET | `/project-chats` | Unified active-sessions + historical-conversations list (discriminated union); accepts `?refreshConversations=1` |
| GET | `/api/search?q=...` | Full-text search across conversations |
| GET | `/api/browse` | Browse the file system |
| POST | `/api/browse/mkdir` | Create a directory |
| GET | `/api/profiles` | List scan profiles |
| POST | `/api/push/register` | Register a push notification token |
| POST | `/api/pair/start` | Mint a short-lived pair token (authenticated) |
| POST | `/api/pair/exchange` | Trade a pair token + client public key for a sealed API key (unauthenticated) |

## Remote Access (tunnels, funnels, proxies)

By default the streamer binds to `127.0.0.1:8766` and isn't reachable from the network. For the mobile app to pair from outside your LAN you need something forwarding HTTPS traffic to that local port — a Cloudflare Tunnel, ngrok, Tailscale Funnel, or a reverse proxy on a VPS.

The fastest path is a Cloudflare quick-tunnel — no account, no domain, ~30 seconds:

```sh
# macOS / Linux / WSL / Git Bash
bash scripts/remote-access/cloudflare.sh

# Anywhere `pwsh` is installed (Windows native, or macOS/Linux via Homebrew)
pwsh scripts/remote-access/cloudflare.ps1
```

The script checks `cloudflared` is installed, brings the tunnel up, and verifies the round-trip with a small success page. When you're ready for a persistent hostname (so the QR doesn't break on the next restart), graduate to a named tunnel — see the full guide.

- **Hub:** [docs/remote-access.md](docs/remote-access.md) — concept overview, provider comparison, security baseline
- **Cloudflare Tunnel:** [docs/remote-access/cloudflare.md](docs/remote-access/cloudflare.md) — quick-tunnel + named-tunnel + Access
- **Other providers:** [ngrok](docs/remote-access/ngrok.md), [Tailscale Funnel](docs/remote-access/tailscale-funnel.md), [VPS reverse proxy](docs/remote-access/vps-reverse-proxy.md)

The Claude Code skill `setup-cloudflare-tunnel` runs the same script with prereq checks and named-tunnel guidance.

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

## Global commands (`tb-streamer` / `threadbase-streamer`)

`npm run deploy` automatically installs two global commands that wrap the deployed CLI at `~/.threadbase/cli.js`:

- `tb-streamer` — short name, matches the repo + npm package
- `threadbase-streamer` — long name, used by the auto-update docs and scheduled-job scripts

Both work for every subcommand: `tb-streamer pair`, `tb-streamer serve`, `threadbase-streamer update`, etc.

**Verify after a deploy:**

```bash
tb-streamer --version
tb-streamer pair          # default port 8766
tb-streamer pair -p 9000  # different port
```

**Where they get installed:**

| OS | default install dir |
|----|---------------------|
| macOS (Apple Silicon) | `/opt/homebrew/bin` |
| macOS (Intel) / Linux | `/usr/local/bin` |
| Windows | `%LOCALAPPDATA%\Programs\threadbase-streamer\bin` |

The deploy script prompts you on the first run (or you can pass `--install-shim=user-local` / `-InstallShim user-local` to use `~/.local/bin` instead). Your choice is persisted to `~/.threadbase/shim.conf` so future deploys are silent.

If the install dir isn't already on your `PATH`, the deploy prints the `export PATH=…` line you need. Pass `--path-update=auto` to have it appended to `~/.zshrc` / `~/.bashrc` automatically.

> **Lazy-nvm note:** if your shell wraps `node`/`npm` in a lazy nvm function (functions that source `~/.nvm/nvm.sh` on first call), `node` is *not* on `PATH` in fresh shells until you invoke it once. The shims will fail with "node not found" in that state. Cheapest fix: run `node -v` once per session, or eager-load nvm (`nvm use default --silent` after defining the lazy wrappers).

### Legacy: the `tb` shim

Earlier versions of the repo shipped a separate `tb` command installed via `scripts/install-tb.sh` (macOS/Linux) or `scripts/install-tb.ps1` (Windows). **That installer is deprecated** — the deploy now handles everything automatically. `scripts/install-tb.*` and `bin/tb*` are kept in the tree so existing `~/.local/bin/tb` symlinks keep working, but new installs should use the auto-installed commands above.

The one feature `tb` has that `tb-streamer` doesn't is the `THREADBASE_CLI` env var, which lets you point `tb` at a custom CLI path without redeploying — useful for running a dev build. If you rely on that, keep using `tb`.

## Development

```bash
npm test                  # Run all tests
npm run lint              # Type-check + Biome lint
npm run format            # Auto-format
npm run build             # Build ESM/CJS + copy SQLite + Postgres migrations
npm run dev               # Watch mode
npm run migrate           # Apply SQLite migrations to ~/.threadbase/cache/cache.db (override --db <path>)
npm run migrate:projects  # Backfill projects + conversation.project_id from existing cache (idempotent)
npm run db:validate       # Report conversations missing project_id, duplicate project paths, orphans
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
- `better-sqlite3` — SQLite driver for `ConversationCache` (conversation metadata, message tails, projects, cache_metadata, schema_migrations)
- `chokidar` — JSONL tail + directory watcher; replaces the previous `fs.watch`-based file-watcher
- `zod` — runtime validation at HTTP and scanner boundaries
- `date-fns` — ISO timestamp parsing and comparison helpers
- `pg` — PostgreSQL client (lazy-loaded, only when `THREADBASE_DATABASE_URL` is configured)
- `commander` — CLI argument parsing
