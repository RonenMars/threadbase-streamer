# @threadbase-sh/streamer

PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. Manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API for conversation history, search, and session control.

## Quick Start

### Install via npm (recommended)

```bash
npm install -g @threadbase-sh/streamer

# One-time setup:
tb-streamer set-key <YOUR_API_KEY>

# Start the server:
tb-streamer serve
```

This installs the `tb-streamer` (and `threadbase-streamer`) CLI globally. Only `node-pty` compiles on install; everything else ships prebuilt. Optional automatic updates: see [docs/guides/auto-update.md](docs/guides/auto-update.md).

### Install via Homebrew (macOS + Linux)

```bash
brew tap RonenMars/threadbase
brew install tb-streamer

# One-time setup:
tb-streamer set-key <YOUR_API_KEY>

# Start the service (also starts on login):
brew services start tb-streamer
```

To stop or restart: `brew services stop tb-streamer` / `brew services restart tb-streamer`. Optional automatic updates: see [docs/guides/auto-update.md](docs/guides/auto-update.md).

> **Note:** the Homebrew install is mutually exclusive with the manual `scripts/deploy.sh` install. If you previously installed via that path, run `launchctl bootout gui/$UID/com.threadbase.streamer` before starting the Homebrew service.

### Run from source

```bash
npm install
npm run build
node dist/cli.cjs serve --verbose --local-no-auth
```

The server starts on `http://localhost:8766` by default with WebSocket at `ws://localhost:8766/ws`.

## Persistence

Conversation metadata lives in a SQLite cache at `~/.threadbase/cache/cache.db` — created and migrated automatically on startup, no configuration needed. Managed sessions are in-memory: a restart drops the live PTYs, but conversation history is on disk and every session can be resumed via `POST /api/sessions/resume`.

PostgreSQL is optional and currently dormant (it stores upload records only — not session state). Enable it by setting `THREADBASE_DATABASE_URL` (e.g. `docker compose up -d postgres` and `export THREADBASE_DATABASE_URL="postgresql://threadbase:threadbase@localhost:5432/threadbase"`); migrations run automatically. Related knobs: `THREADBASE_DATABASE_SSL`, `THREADBASE_DATABASE_POOL_MAX`, `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS`.

## Architecture

Three layers: **core engine** (`src/*.ts`) → **API layer** (`src/api/` + `src/index.ts` exports) → **CLI wrapper** (`cli/`).

The short version:

- `POST /api/sessions/start` / `resume` spawns a `claude` process in a PTY; output streams to all WebSocket clients as `terminal_output`, with a `terminal_replay` snapshot on subscribe.
- `SessionStore` registers managed (PTY) sessions plus externally-running `claude` processes found by process discovery.
- A chokidar-backed watcher tails conversation JSONL files into the SQLite cache, which backs the conversation/list endpoints without filesystem scans.
- When the last WebSocket subscriber disconnects, a grace timer (default 4.5 minutes) puts the PTY on hold — history intact, resumable any time.

Full runtime flow and module reference: [docs/how-it-works.md](docs/how-it-works.md). Dated design documents: [docs/architecture/](docs/architecture/README.md).

## Relationship to Claude Code dynamic workflows

[Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) live *inside* a Claude Code session — the kind of session **PTY mode** hosts. The meaningful comparison is with **`--multi-agent-flow` mode**, where the streamer hands each turn off to a Temporal pipeline in `tb-multi-agent` instead of a `node-pty` Claude session: developer-triggered in-session orchestration vs. durable per-turn orchestration with webhook → WebSocket result delivery.

Details: [docs/comparisons/claude-code-dynamic-workflows.md](docs/comparisons/claude-code-dynamic-workflows.md); multi-agent mode itself: [docs/multi-agent-mode.md](docs/multi-agent-mode.md).

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

By default the streamer binds to `127.0.0.1:8766` and isn't reachable from the network. For the mobile app to pair from outside your LAN you need something forwarding HTTPS traffic to that local port. The fastest path is a Cloudflare quick-tunnel — no account, no domain, ~30 seconds:

```sh
# macOS / Linux / WSL / Git Bash
bash scripts/remote-access/cloudflare.sh

# Anywhere `pwsh` is installed (Windows native, or macOS/Linux via Homebrew)
pwsh scripts/remote-access/cloudflare.ps1
```

- **Hub:** [docs/guides/remote-access/](docs/guides/remote-access/) — concept overview, provider comparison, security baseline
- **Cloudflare Tunnel:** [docs/guides/remote-access/cloudflare.md](docs/guides/remote-access/cloudflare.md) — quick-tunnel + named-tunnel + Access
- **Other providers:** [ngrok](docs/guides/remote-access/ngrok.md), [Tailscale Funnel](docs/guides/remote-access/tailscale-funnel.md), [VPS reverse proxy](docs/guides/remote-access/vps-reverse-proxy.md)

The Claude Code skill `setup-cloudflare-tunnel` runs the same script with prereq checks and named-tunnel guidance.

## Mobile Pairing (QR)

Mobile clients pair by scanning a QR that encodes a `threadbase://pair?url=…&token=…&exp=…` URL. The token is single-use and expires after 180 seconds; the client then trades it (with its X25519 public key) at `/api/pair/exchange` for a sealed-box-encrypted API key, so the key never appears in the QR.

A QR is printed automatically when the server starts (skip with `--no-pair-qr`). To re-print a fresh QR while a server is already running:

```bash
tb-streamer pair          # uses default port 8766
tb-streamer pair -p 4000
```

If the mobile device can't reach `localhost`, point clients at a reachable address so the QR encodes it. In order of precedence:

1. `--public-url <https-url>` flag on `serve`
2. `THREADBASE_PUBLIC_URL` environment variable
3. `public_url:` in `~/.threadbase/server.yaml`

`https://` is required (except for `localhost`).

## Global commands (`tb-streamer` / `threadbase-streamer`)

`npm run deploy` automatically installs two global commands that wrap the deployed CLI at `~/.threadbase/cli.js`: `tb-streamer` (short name) and `threadbase-streamer` (long name, used by the auto-update docs and scheduled-job scripts). Both work for every subcommand: `tb-streamer pair`, `threadbase-streamer update`, etc. The deploy prompts for the install dir on first run and persists the choice to `~/.threadbase/shim.conf`.

Install dirs, non-interactive flags, PATH handling, and the legacy `tb` shim: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

> **Lazy-nvm note:** if your shell wraps `node`/`npm` in a lazy nvm function, `node` is not on `PATH` in fresh shells until you invoke it once, and the shims fail with "node not found". Cheapest fix: run `node -v` once per session, or eager-load nvm.

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

## Dependencies

- `@threadbase-sh/scanner` + `@threadbase-sh/agent-types` — public npm packages (installed by `npm install`)
- `node-pty` — native PTY management
- `ws` — WebSocket server
- `better-sqlite3` — SQLite driver for the conversation cache
- `chokidar` — JSONL tail + directory watcher
- `zod` — runtime validation at HTTP and scanner boundaries
- `date-fns` — ISO timestamp parsing and comparison helpers
- `pg` — PostgreSQL client (lazy-loaded, only when `THREADBASE_DATABASE_URL` is configured)
- `commander` — CLI argument parsing
