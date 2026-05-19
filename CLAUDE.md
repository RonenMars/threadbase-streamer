# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Known deploy/runtime issues and their fixes: [docs/troubleshooting.md](docs/troubleshooting.md)

## Project

`@threadbase/streamer` — PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. TypeScript library + CLI that manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API. Replaces the Go CLI's `cch serve` command.

## Commands

- `npm test` — run all tests (vitest)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — dual ESM/CJS build via tsup (outputs to `dist/`)
- `npm run migrate` — apply SQLite schema migrations against `~/.threadbase/cache/cache.db` (override with `--db <path>`). Idempotent.
- `npm run migrate:projects` — backfill the `projects` table + `conversation_meta.project_id` from existing cached conversations; refresh `cache_metadata.last_conversation_id`. Idempotent.
- `npm run db:validate` — print conversations missing `project_id`, duplicate project paths, and orphaned `project_id` references. Exits non-zero if any issue is found.
- Single test: `npx vitest run __tests__/session-store.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/api/ + src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.cjs` with a shebang.

Key modules and their responsibilities:
- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap)
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions; sessions also carry `projectId` and `resumedFromConversationId`
- `process-discovery.ts` — find running claude processes via pgrep/lsof (Unix) or tasklist/wmic (Windows)
- `conversation-cache.ts` — SQLite cache of conversation metadata, message tails, projects, and cache_metadata; updated incrementally by `ConversationWatcher` (chokidar). Backs `/api/conversations`, `/api/sessions`, and `/project-chats` to avoid full filesystem scans. Runs SQLite migrations on open.
- `services/conversations/conversationWatcher.ts` — chokidar-backed JSONL tail + directory watcher. Replaces the deleted `file-watcher.ts`. Emits per-line events (for cache + WS broadcast) and per-file dirty events (for cache invalidation).
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list events; also unicasts terminal_replay on subscribe and session_ready on PTY spawn
- `server.ts` — HTTP server lifecycle manager. Wires `@hono/node-server` + `@hono/node-ws`, constructs `ApiDeps`, and delegates all request handling to the Hono app. Constructs SQLite repositories once the cache opens.
- `api/app.ts` — Hono app factory (`createHonoApp`). Registers CORS + auth middleware, mounts all route modules, and wires the `@hono/node-ws` WebSocket upgrade handler.
- `api/types/api-deps.ts` — `ApiDeps` dependency-injection interface; passed to every route factory so handlers call back into `StreamerServer` without tight coupling.
- `api/middleware/auth.middleware.ts` — Bearer + `?key=` auth; skips `/healthz` and `POST /api/pair/exchange`.
- `api/middleware/cors.middleware.ts` — `Access-Control-Allow-*` headers + OPTIONS 204 preflight.
- `api/middleware/error.middleware.ts` — Hono `onError` handler returning 500 JSON.
- `api/routes/` — one file per endpoint group: `health`, `misc`, `sessions`, `conversations`, `projects`, `scanner`, `browse`, `pair`, `ws`. Each factory accepts `ApiDeps` and returns a `Hono` sub-app. Handlers write directly to the Node `ServerResponse` via `c.env.outgoing` and return a sentinel `Response(null, { status: 597 })` (`ALREADY_HANDLED`) to skip Hono response piping.
- `handlers/handleListProjectChats.ts` — `GET /project-chats` handler. Validates query params with zod and delegates to `services/projectChats/listProjectChats.ts`.
- `services/projectChats/*` — pure functions: normalize sessions and conversations into a discriminated `ProjectChat` union, merge (hiding conversations resumed into active sessions), and sort by `latestMessageAt → updatedAt → createdAt → title`.
- `services/projects/*` — `upsertProjectByPath`, `ensureProjectsForConversations` (groups conversations by canonical project path, picks latest, upserts one project per path).
- `services/conversations/refreshConversationCache.ts` — after a scanner-driven cache rebuild, upsert projects and backfill `conversation_meta.project_id`. Updates `cache_metadata.last_conversation_id`.
- `services/conversations/shouldRefreshProjectsFromHdd.ts` — compares the latest conversation id known to the cache vs `cache_metadata.last_conversation_id`. Used by `/project-chats` to short-circuit refresh when nothing changed.
- `services/sessions/createSessionForProjectPath.ts` + `ensureSessionProjectIdsFromExistingProjects.ts` — link a managed session to its project once the JSONL exists; backfill `projectId` for sessions whose path matches an existing project.
- `services/cache/cacheMetadata.ts` — get/set helpers over the `cache_metadata` key/value table.
- `auth.ts` — bearer token generation/validation with constant-time comparison
- `idle-sweeper.ts` — periodic sweep that puts idle `waiting_input` sessions on hold after a configurable timeout
- `reconcile.ts` — on server restart, marks any in-flight running/waiting_input sessions as on_hold
- `utils/canonicalizeProjectPath.ts` — trims whitespace, strips trailing slashes/backslashes; preserves case. The single source of truth for project-path identity — every consumer must canonicalize before dedupe.
- `utils/dates.ts` — `parseIsoDateOrNull` + `compareIsoDesc` (date-fns wrapper) for ISO-string sorting and freshness checks.
- `schemas/*.schema.ts` — zod schemas for query params (`ListProjectChatsQuerySchema`), message cursor, ProjectChat, scanned conversation, and Project. Validate at HTTP/scanner boundaries.
- `db/config.ts` — env var parsing (`isDbEnabled`, `getDbConfig`, `getInstanceId`) for the optional Postgres path.
- `db/pool.ts` — pg.Pool creation with connection string password masking
- `db/migrations.ts` + `db/pg-migrations/*.sql` — Postgres migration runner. Postgres is no longer the primary persistence layer; only `session_uploads` + reserved future tables live here.
- `db/sqlite-migrate.ts` + `db/migrations/*.sql` — SQLite migration runner used by `ConversationCache.open()`. Migrations are tracked in `schema_migrations` and are idempotent. Current files: `001_create_projects.sql`, `002_add_project_id_columns.sql`, `003_create_cache_metadata.sql`.
- `db/repositories/*.repository.ts` — `ProjectsRepository` (UUID + canonical-path upsert), `ConversationsRepository` (wraps the cache for project_id linking), `SessionsRepository` (wraps SessionStore), `CacheMetadataRepository`.
- `db/session-persistence.ts` — `SessionPersistence` interface; `memory-persistence.ts` (no-op default) and `pg-session-persistence.ts` (Postgres) implement it

## Session lifecycle

Sessions move through these statuses:

```
running ──(╭ prompt marker)──► waiting_input ──(idle 60s / hold_session WS msg)──► on_hold
   │                                 │
   └──(user sends input)─────────────┘ (back to running)
   
running / waiting_input ──(exit 0)──► completed
running / waiting_input ──(exit ≠ 0)──► failed
running / waiting_input ──(server restart)──► on_hold   (reconcile.ts)
```

- **`waiting_input`**: Claude printed its `╭` prompt marker — it's idling, waiting for user input. The idle clock starts here (`lastActivityAt` is set).
- **`on_hold`**: PTY process was killed (SIGINT) after 60 s of inactivity, or explicitly by the client sending `{ type: "hold_session", sessionId }` over WebSocket. Conversation history is intact; resume via `POST /api/sessions/resume` with the same `conversationId`.
- `IdleSweeper` runs every 30 s, checks `lastActivityAt` against the threshold, and calls `PTYManager.putOnHold()` which sets a `holdAt` tombstone before killing to prevent the exit handler from overwriting the `on_hold` status with `failed`.
- Idle timeout is configurable via `ServerConfig.idleTimeoutMs` (default 60 000 ms). Set to `0` to disable.

## Environment variables

| Variable | Description |
|----------|-------------|
| `THREADBASE_DATABASE_URL` | PostgreSQL connection URI — enables DB persistence when set |
| `THREADBASE_DATABASE_SSL` | `require` or `disable` |
| `THREADBASE_DATABASE_POOL_MAX` | Max pool connections (default `10`) |
| `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS` | Query timeout in ms |
| `THREADBASE_INSTANCE_ID` | Stable identifier for this server instance (defaults to `os.hostname()`); used to scope DB-persisted sessions |
| `THREADBASE_PUBLIC_URL` | Public HTTPS URL for QR pairing (overrides `public_url:` in server.yaml) |

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`) from it, but most runtime knobs come exclusively from CLI flags — `--port` is the canonical example. Setting `port: 8766` in `server.yaml` does nothing; the server falls back to the CLI default `3456` if `--port` is missing.

Practical consequence: any service definition (launchd plist, systemd unit, Task Scheduler action) **must** pass `--port <n>` explicitly, even if `server.yaml` has a `port:` line. The deploy scripts already do this; only hand-written or stale plists are at risk.

## ServerConfig options (beyond CLI flags)

| Field | Default | Description |
|-------|---------|-------------|
| `idleTimeoutMs` | `60000` | How long a `waiting_input` session idles before being put on_hold; `0` disables |
| `ptyGracePeriodMs` | `270000` | Ms to keep the PTY alive after all WebSocket subscribers disconnect (4.5 minutes) |
| `cacheDir` | `~/.threadbase/cache` | Directory for the SQLite conversation cache |
| `tailSize` | `10` | Number of tail messages cached per conversation for fast session-list enrichment |

## Dependencies

- `@threadbase/scanner` — scan, parse, search, filter conversation history (used for REST endpoints)
- `node-pty` — native PTY management (external, not bundled by tsup)
- `ws` — WebSocket server
- `better-sqlite3` — SQLite driver for `ConversationCache` (incl. projects + cache_metadata + schema_migrations tables)
- `chokidar` — JSONL tail + directory watcher; replaces the previous `fs.watch`-based `file-watcher.ts`
- `zod` — runtime validation at HTTP and scanner boundaries (query params, ProjectChat shape, message cursor, scanned conversations)
- `date-fns` — ISO timestamp parsing/comparison helpers; used for ProjectChat sort and cache freshness checks
- `commander` — CLI argument parsing

## Build notes

- **CLI externals**: only `node-pty` is external for the CLI tsup entry. `pg` and all other deps must be bundled — the deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`.
- **Two migration folders at build time**: `npm run build` copies both `src/db/migrations/` (SQLite — used by `ConversationCache`) and `src/db/pg-migrations/` (Postgres — used only when `THREADBASE_DATABASE_URL` is set) into `dist/`. Both runners resolve their folder relative to the compiled module's `__dirname`/`import.meta.url`.
- **Migrations at deploy**: deploy scripts currently copy only `dist/migrations/` (SQLite). That is sufficient for the SQLite-first runtime. `dist/pg-migrations/` is NOT shipped to `~/.threadbase/`; the Postgres path is dormant. If/when Postgres persistence is re-enabled in production, the deploy scripts must be extended to copy `dist/pg-migrations/` alongside `dist/migrations/`.
  - macOS/Linux: symlink makes `__dirname` = `~/.threadbase/releases/` → copy SQLite migrations to `~/.threadbase/releases/migrations/`
  - Windows: `cli.js` is a real copy at `~/.threadbase/` so `__dirname` = `~/.threadbase/` → copy SQLite migrations to `~/.threadbase/migrations/`

## Cloudflare Tunnel

The streamer is exposed publicly via a Cloudflare Tunnel (`cloudflared` running as a Windows service). The active mapping is `https://tb-pc.rbv1000.win` → `http://127.0.0.1:8766`. Set `public_url: https://tb-pc.rbv1000.win` in `~/.threadbase/server.yaml` so the pairing QR code embeds the correct URL.

**Cloudflare Access behaviour:** the tunnel hostname is protected by Cloudflare Access. Requests without an `Authorization` header receive `401 Unauthorized` from the CF edge — including unauthenticated probes of `/healthz`. Requests that carry `Authorization: Bearer <api_key>` pass through to the origin. This means:
- Deploy-script healthchecks (which hit `http://localhost:8766/healthz` directly) are unaffected.
- External clients must always include the Bearer token — there is no anonymous access through the public URL, even for `/healthz`.
- `Test-NetConnection` and browser probes will be blocked by CF Access; use `Invoke-RestMethod` with the Bearer header to test the public URL.

**cloudflared config files:**
- `~/.cloudflared/config.yml` — user-level config (read when running `cloudflared` manually)
- `~/.cloudflared/config-system.yml` — used by the Windows service (runs under SYSTEM); this is the one that matters for the always-on tunnel
- Both must be kept in sync. After editing either file, restart the service: `Restart-Service cloudflared`

## Auto-update

Full guide: [docs/auto-update.md](docs/auto-update.md). Sample config: [docs/update.yaml.example](docs/update.yaml.example). For walking a user through enabling it on a deployed streamer, use the `setup-auto-updater` skill (`.claude/skills/setup-auto-updater/SKILL.md`).

Three independent triggers, all opt-in via `~/.threadbase/update.yaml`:
- **Manual:** `threadbase-streamer update [--check | --dry-run | --force | --allow-major | --version <tag>]`
- **Scheduled:** `scripts/install-auto-update.{sh,ps1}` registers a second platform job (launchd / systemd --user / Task Scheduler) — requires `auto_update: true`. Supports `uninstall`.
- **Webhook:** `POST /api/__update` with HMAC-SHA256 signature header — enabled when `webhook_secret` is set.

Things that will bite if you forget:
- On Windows, `swapCurrent()` is preceded by `stopService()` because open handles inside `current/dist/cli.cjs` block the file replace. Tests in `__tests__/install.test.ts` lock the order in — keep them green.
- Service-label resolution in `src/updater/restart.ts` falls through `serviceLabel` option → env var (`LAUNCHD_LABEL` / `THREADBASE_SYSTEMD_UNIT` / `THREADBASE_TASK_NAME`) → default matching `scripts/deploy.{sh,ps1}`. If you customize the label at deploy time, set the matching env var or the updater restarts a different service than was installed.
- Active-session defer has three outcomes: reachable+count>0 → defer, reachable+error → defer (state unknown is unsafe), unreachable → proceed. Don't simplify back to "any error returns 0".
- The auth middleware skips both Bearer and `?key=` for `POST /api/__update` (HMAC instead). Don't add other entries to `PUBLIC_POST_PATHS` without an equivalent gate.

## macOS-specific notes

- **launchd plist must set `PATH` via `EnvironmentVariables`**: launchd-spawned services inherit only `/usr/bin:/bin:/usr/sbin:/sbin`. Without an `EnvironmentVariables` block in the plist that includes `/opt/homebrew/bin` (Apple Silicon) and `/usr/local/bin` (Intel), `node-pty`'s `execvp("claude", …)` fails with `ENOENT`, and every session-start/resume produces an instant-exit zombie session with `status=idle`, blank terminal, no `failureReason`. The deploy script's plist generator and self-heal both write the block; symptom + diagnosis in [docs/troubleshooting.md](docs/troubleshooting.md).
- **`resolveClaudeExe()` now falls back to absolute Homebrew/local paths on macOS** (`src/platform.ts`) — defense-in-depth so a stale plist alone can't break the streamer.

## Windows-specific notes

- **`npm install` before first deploy**: A fresh clone (or a branch that added new packages) will fail lint/build with "Cannot find module" if `node_modules` is missing or stale. Run `npm install` before the first `npm run deploy:windows`. The `postinstall` script also patches `qrcode-terminal` and sets permissions on the `node-pty` prebuild.
- **Path separators**: `path.resolve()` returns backslash-separated paths on Windows. Always use `path.sep` (not `"/"`) for path prefix guards. Same applies to any `startsWith` checks on resolved paths.
- **File timestamps**: `fs.stat().birthtimeMs` reflects the real Windows creation time and is unaffected by `fs.utimes()`. Use `mtimeMs` for any timestamp matching that needs to survive cross-platform test assertions.
- **Task Scheduler log redirection**: Task Scheduler has no native stdout/stderr redirection. The scheduled task action must use `pwsh.exe` as the executor and redirect inside the PowerShell command string (`>> logfile 2>> errfile`). Without this, `%TEMP%\threadbase.err` is never written and healthcheck failures are undiagnosable.
- **Task Scheduler env var inheritance**: `[Environment]::SetEnvironmentVariable(..., 'User')` writes to the registry but does NOT update the live session environment. Tasks started via `Start-ScheduledTask` in the same terminal session that set the var will not pick it up. Always read back from registry with `[Environment]::GetEnvironmentVariable(..., 'User')` and inline the value directly in the `$psArg` command string. This applies to `THREADBASE_DATABASE_URL` and `THREADBASE_INSTANCE_ID`.
- **Stale port 8766**: Before starting the task after a deploy, check for and kill any node process already bound to port 8766 (old streamer version, leftover dev process). The new task will fail silently if the port is taken.
- **Submodule SSH → HTTPS**: Windows machines without SSH keys configured will fail `git submodule update --init` with "Permission denied (publickey)". Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`
- `node-pty` is dynamically imported to allow graceful failure when not installed
- All session state mutations go through SessionStore for consistency

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`

## Backward Compatibility with tb-mobile

`tb-mobile` is a released iOS/Android app — users on older app versions connect to whatever streamer version is deployed. The streamer must therefore remain backward-compatible with older mobile clients. The mobile client cannot be force-updated; a breaking server change will silently break functionality for any user who hasn't updated the app.

### What tb-mobile depends on (do not break without a migration plan)

**REST endpoint paths** — mobile hard-codes every path. Never rename or remove:
- `/healthz`, `/api/info`, `/api/pair/exchange`
- `/api/sessions`, `/api/sessions/count`, `/api/sessions/{id}`
- `/api/sessions/resume`, `/api/sessions/start`
- `/api/sessions/{id}/input`, `/api/sessions/{id}/cancel`
- `/api/sessions/{id}/output`, `/api/sessions/{id}/files`
- `/api/conversations`, `/api/conversations/count`, `/api/conversations/{id}`
- `/api/search`, `/api/browse`, `/api/browse/mkdir`

**New endpoint** — purely additive; older mobile builds simply don't call it:
- `GET /project-chats` — unified active-sessions + historical-conversations list. Accepts `?refreshConversations=1` (or legacy `?refresh=1`) to force a rescan; otherwise the server short-circuits via `cache_metadata.last_conversation_id`. Response shape is `{ projectChats: ProjectChat[] }` where `ProjectChat` is a discriminated union on `type: "session" | "conversation"`. Both variants carry `projectId` (the canonical project identity) and `projectPath` (compatibility metadata).

**Query parameter names** — mobile builds URLs with these exact strings:
`limit`, `offset`, `sort`, `project`, `refresh`, `msg_limit`, `before_index`, `q`, `path`

**Response field names** — these are deserialized by name in mobile types; casing matters:
- Session: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `source`, `startedAt`, `completedAt`, `lastActivityAt`, `failureReason`, `ptyAttached`
- Session — new optional fields (added during the projects refactor; never required for older clients): `projectId`, `resumedFromConversationId`
- Conversation list item: `id`, `title`, `projectPath`, `messageCount`, `lastActivity`, `firstMessage`, `lastMessage`, `preview`, `model`
- Conversation detail: `meta` object + `messages` array + `message_pagination` object
- Message: `message_index` (snake_case), `role`, `timestamp`, `text`, `content` (array), `tool_use_id` (snake_case)
- Pagination: `hasMore`, `offset`, `total`

**Session status values** — mobile switches on these exact strings; adding a new value is fine, renaming or removing one breaks UI:
`running`, `waiting_input`, `completed`, `failed`, `on_hold`
Note: mobile types also include `idle` as an alias — treat `on_hold` and `idle` as the same status from the mobile perspective.

**WebSocket event types** — mobile registers listeners keyed on these strings:
- Server → client: `session_list`, `session_update`, `terminal_output`, `conversation_event`, `ping`
- Client → server: `{ type: "hold_session", sessionId }`

**HTTP status codes** — mobile maps these to typed errors:
- `401` → `AuthError` (triggers re-auth UI)
- `404` → `NotFoundError` (suppressed for `/output` endpoint — treated as empty)
- `429` → shown to user during pair exchange

**Auth format** — mobile sends `Authorization: Bearer <token>` and constructs WebSocket URLs as `/ws?key=<token>`. Both forms must continue to work.

**API key format** — mobile uses `tb_` prefix detection in pairing logic. Key format `tb_<32-hex-chars>` must be preserved.

### Safe changes

- Adding optional fields to any response object
- Adding new endpoints
- Adding new optional query parameters with sensible defaults
- Adding new WebSocket event types (mobile ignores unknown types)
- Adding new session status values (mobile will display them as-is)

### Risky changes (coordinate with tb-mobile)

- Renaming any field (including camelCase ↔ snake_case)
- Removing any field from a response
- Changing a field's type (e.g., `number` → `string`)
- Renaming or removing an endpoint
- Changing query parameter semantics (not just adding new ones)
- Changing WebSocket event type strings
- Changing pagination cursor behavior in `/api/conversations/{id}`
- Changing the NaCl box format or key exchange protocol in `/api/pair/exchange`

When making a risky change, either: (a) keep the old shape and add the new one alongside it, or (b) open a coordinated PR in tb-mobile at the same time and document the minimum required app version in the commit message.

## Menubar app (vendor/menubar)

`vendor/menubar` is a git submodule pointing at `RonenMars/threadbase-menubar` — the Electron tray app that shows streamer status. It runs out-of-process and only talks to the streamer over `GET /healthz`.

**Coupling to this repo:**
- It reads the streamer's listening port from `~/.threadbase/server.yaml` (`port:` line) at launch. Resolution order: `THREADBASE_PORT` env → `port:` in `server.yaml` → fallback `8766`.
- Polls `http://localhost:<port>/healthz` every 5s and expects the existing `{ ok, version }` response shape.

**Don't break without coordinating a menubar update:**
- Renaming or moving the `port:` field in `server.yaml`
- Removing `/healthz` or changing its response shape
- Changing the default listening port (the menubar fallback `8766` would need to be bumped in lockstep)

**Auto-update interaction:** during an install, the streamer is briefly down — typically a few seconds between `stopService()` (Windows only) / `swapCurrent()` and `restartService()`. The menubar will flicker to "disconnected" then reconnect on the next 5s poll. This is expected and not a bug. If the gap stretches beyond ~10s, something is wrong with the restart step (`launchctl kickstart` failing on macOS, `systemctl --user` not finding the unit on Linux, scheduled task hung on Windows) — check `~/.threadbase/logs/updater.{log,err}` and the platform service status before assuming the menubar itself is at fault.

Parent-repo commits that bump the submodule pointer should use a `chore: bump vendor/menubar (<reason>)` title.

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a new section following the existing format (symptom → cause → fix) and commit it alongside any code fix.
