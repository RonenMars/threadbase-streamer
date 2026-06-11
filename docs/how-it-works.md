# How the streamer works

Living reference for the runtime flow and module layout. For dated design documents (problem framing, alternatives, decisions) see [architecture/](architecture/README.md).

## Session start → PTY → broadcast

When a client calls `POST /api/sessions/start` (new conversation) or `POST /api/sessions/resume` (existing conversation), the server delegates to `PTYManager`, which spawns a `claude` process inside a PTY via `node-pty`. The server returns `202` immediately — the PTY launch is async. As the PTY emits output, `PTYManager` appends it to an in-memory ring buffer (64 KB cap per session) and forwards each chunk to `WSHub`, which fans it out to every connected WebSocket client as a `terminal_output` event.

When a WebSocket client subscribes to a session (`subscribe_session`), the server unicasts the rendered terminal state as a `terminal_replay` event so the client can reconstruct the current screen without an extra HTTP round-trip. Once the PTY process is ready (Claude's first prompt marker appears), the server broadcasts a `session_ready` event with the full session object.

## Session registry

`SessionStore` is the single source of truth for in-flight state. It holds two maps: *managed sessions* (those with an active or recently-active PTY) and *discovered processes* (externally-running `claude` processes found by `process-discovery.ts` via `pgrep`/`lsof` on Unix or `tasklist`/`wmic` on Windows). When building the session list, managed sessions take priority — a discovered process whose `conversationId` matches an existing managed session is suppressed. The discovery scan result is cached for 15 seconds.

## Conversation cache

`ConversationCache` (`src/conversation-cache.ts`) maintains a SQLite database of conversation metadata, message tails, projects, and cache metadata. On open, it runs the SQLite migrations under `src/db/migrations/` (tracked in a `schema_migrations` table). It is updated incrementally: `ConversationWatcher` (`src/services/conversations/conversationWatcher.ts`, chokidar-backed) tails JSONL conversation files and emits new lines, which `ConversationCache` parses and upserts. The cache backs the `GET /api/conversations`, `GET /api/sessions`, and `GET /project-chats` endpoints, avoiding a full filesystem scan on every request.

## Projects + cache freshness

A `projects` row is the canonical identity for a project (UUID + canonical path). Every cached conversation carries a `project_id` foreign key. Project discovery is conversation-driven: as the cache learns about conversations, it upserts one project per unique canonical project path (`src/utils/canonicalizeProjectPath.ts`).

`/project-chats` is the unified active-sessions + historical-conversations list. By default the server short-circuits the rescan when `cache_metadata.last_conversation_id` matches the latest conversation id known to the cache; pass `?refreshConversations=1` (or legacy `?refresh=1`) to force a refresh. The merge step hides any conversation that has been resumed into an active session (matched on `resumedFromConversationId`).

## Session lifecycle & hold

Live statuses are `running`, `waiting_input`, and `idle` (`SessionStatus` in `src/types.ts`). A session becomes `waiting_input` when Claude prints a prompt marker (`╭` or `❯`, with a fallback timer), and returns to `running` when input arrives. Any PTY exit lands on `idle`; an instant non-zero exit with no output gets a diagnosed `failureReason`.

When the last WebSocket subscriber disconnects, the server starts a grace timer (`ptyGracePeriodMs`, default 270 000 ms = 4.5 minutes) that calls `PTYManager.putOnHold()` — SIGINT to the PTY, status `idle`, conversation history intact. A client can hold immediately by sending `{ type: "hold_session", sessionId }` over WebSocket (same path, zero delay). Idle sessions are resumed via `POST /api/sessions/resume` with the same `conversationId`; historical conversations are surfaced to clients as resumable shapes with `status: "on_hold"`.

## Mobile pairing

On startup (or via `tb-streamer pair`), the server prints a QR code encoding a `threadbase://pair?url=…&token=…&exp=…` deep-link URL. The token is minted by `pair-store.ts` (single-use, 180 s TTL). The mobile client trades it at `POST /api/pair/exchange` along with its X25519 public key; `seal.ts` encrypts the API key into a NaCl sealed box so the key never appears in the QR or in transit unencrypted.

## Module reference

```
src/
  server.ts                                HTTP + WebSocket server lifecycle, ApiDeps wiring, grace timers
  api/
    app.ts                                 Hono app factory: CORS + auth middleware, route mounting, WS upgrade
    types/api-deps.ts                      ApiDeps dependency-injection interface for route factories
    middleware/                            auth (Bearer + ?key=), CORS, onError
    routes/                                One file per endpoint group: health, misc, sessions, conversations,
                                           projects, scanner, browse, pair, progress, ws
  session-store.ts                         In-memory registry of managed + discovered sessions
  pty-manager.ts                           Spawn/resume Claude sessions via node-pty, ring buffer, prompt detection
  process-discovery.ts                     Find running claude processes (pgrep/lsof on Unix, tasklist/wmic on Windows)
  conversation-cache.ts                    SQLite cache (conversation_meta + tail + projects + cache_metadata); runs migrations on open
  ws-hub.ts                                WebSocket broadcast hub, 30 s ping keepalive
  auth.ts                                  Bearer token generation/validation (constant-time compare)
  browse.ts                                File system browser (list/mkdir)
  uploads.ts                               File upload handling for session file attachments
  pair-store.ts                            Short-lived pairing token registry
  seal.ts                                  X25519 sealed-box encryption for mobile pairing
  platform.ts                              Platform detection, Claude binary resolution
  lan-url.ts                               LAN IP resolution for QR code URLs
  lifecycle/                               Prod/dev port coordination (see guides/prod-dev-lifecycle.md)
  updater/                                 Self-update: check, install, restart (see guides/auto-update.md)
  agent/                                   Multi-agent mode: errors, config, Temporal wiring (see multi-agent-mode.md)
  utils/
    canonicalizeProjectPath.ts             Trim + trailing-slash strip; canonical key for project identity
    dates.ts                               date-fns wrapper: parseIsoDateOrNull, compareIsoDesc
  schemas/                                 zod schemas: ProjectChat, query params, message cursor, project, conversation
  handlers/
    handleListProjectChats.ts              GET /project-chats — zod-validates query, delegates to listProjectChats
  services/
    projectChats/                          Compose /project-chats: normalize, merge (hide resumed), sort
    projects/                              ensureProjectsForConversations, upsertProjectByPath
    conversations/                         conversationWatcher, refreshConversationCache, freshness check,
                                           isAgentConversation + pruneAgentConversations (agent-JSONL filtering)
    sessions/                              Link sessions to projects, backfill projectId
    cache/                                 cache_metadata key/value helpers
  db/
    config.ts                              Env var parsing (isDbEnabled, getDbConfig)
    pool.ts                                pg.Pool creation with password masking
    sqlite-migrate.ts                      SQLite migration runner (used by ConversationCache.open)
    migrations/                            SQLite versioned .sql files (projects, project_id columns, cache_metadata)
    migrations.ts                          Postgres migration runner (dormant — upload records only)
    pg-migrations/                         Postgres versioned .sql files
    repositories/                          projects / conversations / sessions / cacheMetadata repositories
scripts/
  migrate.ts                               Apply SQLite migrations to ~/.threadbase/cache/cache.db
  migrate-projects.ts                      Backfill projects + conversation.project_id (idempotent)
  validate-db.ts                           Report conversations missing project_id, duplicate paths, orphans
```
