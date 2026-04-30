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
- Single test: `npx vitest run __tests__/session-store.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.cjs` with a shebang.

Key modules and their responsibilities:
- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap)
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions
- `process-discovery.ts` — find running claude processes via pgrep/lsof (Unix) or tasklist/wmic (Windows)
- `file-watcher.ts` — tail JSONL files via fs.watch, emit new lines for structured parsing
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list events
- `server.ts` — HTTP server wiring REST endpoints + WebSocket upgrade + auth
- `auth.ts` — bearer token generation/validation with constant-time comparison
- `idle-sweeper.ts` — periodic sweep that puts idle `waiting_input` sessions on hold after a configurable timeout

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

## Dependencies

- `@threadbase/scanner` — scan, parse, search, filter conversation history (used for REST endpoints)
- `node-pty` — native PTY management (external, not bundled by tsup)
- `ws` — WebSocket server
- `commander` — CLI argument parsing

## Build notes

- **CLI externals**: only `node-pty` is external for the CLI tsup entry. `pg` and all other deps must be bundled — the deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`.
- **Migrations at deploy**: deploy scripts copy `dist/migrations/` so the CJS bundle can find them at runtime via `__dirname`.
  - macOS/Linux: symlink makes `__dirname` = `~/.threadbase/releases/` → copy to `~/.threadbase/releases/migrations/`
  - Windows: `cli.js` is a real copy at `~/.threadbase/` so `__dirname` = `~/.threadbase/` → copy to `~/.threadbase/migrations/`

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

**Query parameter names** — mobile builds URLs with these exact strings:
`limit`, `offset`, `sort`, `project`, `refresh`, `msg_limit`, `before_index`, `q`, `path`

**Response field names** — these are deserialized by name in mobile types; casing matters:
- Session: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `source`, `startedAt`, `completedAt`, `lastActivityAt`
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

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a new section following the existing format (symptom → cause → fix) and commit it alongside any code fix.
