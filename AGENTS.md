# AGENTS.md

This file provides guidance to Codex (and other coding agents) when working with code in this repository.

Known deploy/runtime issues and their fixes: [docs/troubleshooting.md](docs/troubleshooting.md)

## Project

`@threadbase/streamer` — PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. TypeScript library + CLI that manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API.

## Commands

- `npm test` — run all tests (vitest)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — dual ESM/CJS build via tsup (outputs to `dist/`)
- `npm run migrate` — apply SQLite schema migrations against `~/.threadbase/cache/cache.db` (override with `--db <path>`). Idempotent.
- `npm run migrate:projects` — backfill the `projects` table + `conversation_meta.project_id` from cached conversations. Idempotent.
- `npm run db:validate` — report missing/duplicate/orphaned `project_id` data; exits non-zero on any issue.
- Single test: `npx vitest run __tests__/session-store.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/api/ + src/index.ts exports) → **CLI wrapper** (cli/). Built as separate tsup entries: `src/index.ts` → `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types; `cli/index.ts` → `dist/cli.cjs` with a shebang.

Modules with non-obvious behavior:

- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap)
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions. All session state mutations go through it.
- `conversation-cache.ts` — SQLite cache of conversation metadata, message tails, projects, and cache_metadata; updated incrementally by `ConversationWatcher` (chokidar). Backs `/api/conversations`, `/api/sessions`, and `/project-chats`. Runs SQLite migrations on open (`db/sqlite-migrate.ts` + `db/migrations/*.sql`, tracked in `schema_migrations`).
- `services/conversations/conversationWatcher.ts` — chokidar-backed JSONL tail + directory watcher. Emits per-line events (cache + WS broadcast) and per-file dirty events (cache invalidation).
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list; unicasts terminal_replay on subscribe and session_ready on PTY spawn
- `server.ts` — HTTP server lifecycle; wires `@hono/node-server` + `@hono/node-ws`, constructs `ApiDeps`, delegates request handling to the Hono app (`api/app.ts`)
- `api/routes/` — one file per endpoint group; each factory takes `ApiDeps` and returns a Hono sub-app. Handlers write directly to the Node `ServerResponse` via `c.env.outgoing` and return a sentinel `Response(null, { status: 597 })` (`ALREADY_HANDLED`) to skip Hono response piping.
- `services/conversations/isAgentConversation.ts` — detects agent-authored JSONLs by `entrypoint` field (default `sdk-cli`, `claude-vscode`; interactive Claude Code emits `cli` and is never matched). The file probe is a chunked scan (64 KB chunks, 64-byte overlap) that early-exits at the first `"entrypoint":` occurrence — the value is per-conversation and authoritative, so large human JSONLs aren't read in full.
- `utils/canonicalizeProjectPath.ts` — the single source of truth for project-path identity; every consumer must canonicalize before dedupe.
- `db/migrations.ts` + `db/pg-migrations/*.sql` — Postgres migration runner. Postgres is dormant (only `session_uploads` + reserved tables); SQLite is the primary persistence layer.
- `schemas/*.schema.ts` — zod validation at HTTP/scanner boundaries

## Session lifecycle

Live statuses (`SessionStatus` in `src/types.ts`): `running`, `waiting_input`, `idle`.

```
running ──(prompt marker ╭ / ❯, or fallback timer)──► waiting_input
   │                                                       │
   └───────────────(user sends input)◄─────────────────────┘

running / waiting_input ──(PTY exit, any code)──────────────► idle
waiting_input / idle ──(hold_session msg → grace timer)─────► idle  (PTY killed, history intact)
waiting_input / idle ──(idle reaper, 6h of agent silence)───► idle  (PTY killed, history intact)
```

- **`waiting_input`**: Claude printed a prompt marker (`CLAUDE_PROMPT_MARKERS = ["╭", "❯"]` in `pty-manager.ts`, plus a fallback timeout) — idling for user input.
- **`idle`**: no live PTY. Reached on process exit or via `PTYManager.putOnHold()` (SIGINT + screen disposal). History intact; resume via `POST /api/sessions/resume` with the same `conversationId`.
- **Grace/hold**: a WebSocket disconnect arms nothing. The only caller of `startGraceTimer` is an explicit `{ type: "hold_session", sessionId }`, which waits `ptyGracePeriodMs` (default 270 000 ms) and then calls `putOnHold()`; a `running` session defers up to `GRACE_MAX_DEFERS` (4) so a turn is never cut mid-response.
- **Idle reaper**: holds any PTY whose agent has been silent for `IDLE_REAP_AFTER_MS` (6 h), swept every 5 min. Never touches a `running` session. This is the resource bound that replaced kill-on-disconnect.
- **Codex resume is authoritative, not optimistic.** Codex enforces a single writer per rollout and only reports it after the process starts (`already has an active writer (code -32600)`), so a Codex resume/fork waits for a bounded ready-or-failed outcome (`CODEX_STARTUP_TIMEOUT_MS`, 4 s, env `THREADBASE_CODEX_STARTUP_TIMEOUT_MS`) before answering. A refusal — found either by the pre-spawn open-file probe (`services/sessions/codexRolloutOwner.ts`, bounded `lsof` on the exact rollout, POSIX only) or by the rendered error afterwards — is a `409` whose `code` stays `CONVERSATION_BUSY` with an additive `reasonCode: "CODEX_SESSION_ACTIVE"`. `force` does **not** bypass it: force only ever overrode our own heuristic. Recovery is `POST /api/sessions/:id/fork` (`codex fork`), which starts a second conversation and leaves the owner running. Contract: [docs/compatibility/codex-collision-and-fork.md](docs/compatibility/codex-collision-and-fork.md).
- An instant non-zero exit (<2 s, no output) gets a diagnosed `failureReason` (missing project dir, or Claude binary not found).
- **Mobile mapping**: historical conversations are returned as resumable shapes with `status: "on_hold"` (`conversationToResumableSession` in `server.ts`); mobile treats `idle` and `on_hold` as the same.

## Environment variables

| Variable | Description |
|----------|-------------|
| `THREADBASE_DATABASE_URL` | PostgreSQL connection URI — enables DB persistence when set (also: `THREADBASE_DATABASE_SSL`, `THREADBASE_DATABASE_POOL_MAX`, `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS`) |
| `THREADBASE_INSTANCE_ID` | Stable identifier for this server instance (defaults to `os.hostname()`); scopes DB-persisted sessions |
| `THREADBASE_PUBLIC_URL` | Public HTTPS URL for QR pairing (overrides `public_url:` in server.yaml) |
| `THREADBASE_FILTER_AGENT_CONVERSATIONS` | Hide non-interactive Claude runs from `/api/conversations` + `/project-chats`. Default on. Toggling triggers a one-time prune-or-rescan on next restart. |
| `THREADBASE_AGENT_ENTRYPOINTS` | JSONL `entrypoint` values treated as agent traffic. Default `sdk-cli,claude-vscode`. |
| `MULTI_AGENT_FLOW` | Routes `POST /api/sessions/start` + `/input` to the multi-agent path instead of PTY. `AGENT_*` tuning vars: see [docs/multi-agent-mode.md](docs/multi-agent-mode.md). |
| `THREADBASE_FEATURE_*` | One var per server feature flag (`THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT`, …). Highest-precedence source; registry in `src/feature-flags.ts`. Resolved at boot only. |

## Multi-agent mode

When `MULTI_AGENT_FLOW=true`, session start/input route through a Temporal-orchestrated pipeline; PTY mode is unreachable. Endpoints return structured errors `{error, code}` (codes in `src/agent/errors.ts`); mobile-relevant: **429 `SESSION_BUSY`** (carries `retryAfterMs`) and **413 `SESSION_HISTORY_FULL`** (prompt "start a new conversation"). Full endpoint contract, env vars, and dev setup: [docs/multi-agent-mode.md](docs/multi-agent-mode.md); design rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`, `feature_flags`) from it, but most runtime knobs come exclusively from CLI flags.

Setting `port:` in `server.yaml` does nothing — the listening port comes only from `--port` (CLI default `8766`). Any service definition (launchd plist, systemd unit, Task Scheduler action) **must** pass `--port <n>` explicitly — the deploy scripts already do.

Feature flags (`src/feature-flags.ts`) resolve at boot from env → `--feature <id=bool>` → `feature_flags:` (one line of JSON) → registry default, and are readable at `GET /api/config/feature-flags`. Full detail in CLAUDE.md.

`permissionMode`, `model` and `effort` are claude-flags that the spawn paths pass as explicit positionals, so `buildFlagArgs` skips them (`SPAWN_POSITIONAL_FLAG_IDS`) and `StreamerServer.spawnFlagOverrides()` resolves them instead — flag value over `--default-*` CLI fallback. Skipping an id without reading it there makes the API a silent no-op. Server default is `PUT /api/config/claude-flags`; a live session is retargeted by `PATCH /api/sessions/:id/model` / `:id/effort`, which type Claude's `/model` / `/effort` slash command into the PTY (202, validated as a trust boundary — the value becomes raw terminal bytes). Full detail in CLAUDE.md.

## ServerConfig options (beyond CLI flags)

| Field | Default | Description |
|-------|---------|-------------|
| `ptyGracePeriodMs` | `270000` | Ms between an explicit `hold_session` message and the hold (4.5 minutes). Not armed by WebSocket disconnect; `0` means hold immediately, not "never" |
| `cacheDir` | `~/.threadbase/cache` | Directory for the SQLite conversation cache |
| `tailSize` | `10` | Tail messages cached per conversation for fast session-list enrichment |

## Dependencies

- `@threadbase/scanner` + `@threadbase/agent-types` — **git submodules** at `vendor/scanner` / `vendor/agent-types`, wired as `file:` deps. Not on npm; built from source by `postinstall`, then bundled inline into `dist/` by tsup (runtime doesn't need `vendor/`). Consequences:
  - First checkout must run `git submodule update --init` **before** `npm install` (use HTTPS; SSH fails on Windows without keys).
  - CI checkouts need `submodules: recursive` (already set in `ci.yml` + `release.yml`).
  - Bump with a `chore: bump vendor/<name> (<reason>)` commit that moves the submodule pointer.
- `node-pty` — native PTY management (external, not bundled by tsup; dynamically imported for graceful failure)
- `ws`, `better-sqlite3`, `chokidar`, `zod`, `date-fns`, `commander`

## Build notes

- **CLI externals**: only `node-pty` is external for the CLI tsup entry. `pg` and everything else must be bundled — the deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`.
- `npm run build` copies both `src/db/migrations/` (SQLite) and `src/db/pg-migrations/` (Postgres) into `dist/`; deploy ships only the SQLite folder. Details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

## Deploy & distribution

- Every deploy installs two global commands wrapping `~/.threadbase/cli.js`: `threadbase-streamer` (entrenched name) and `tb-streamer` (short alias). Shim install is interactive by default; non-interactive via `--install-shim=` / `--path-update=` flags or `TB_INSTALL_SHIM` / `TB_PATH_UPDATE` env vars. Failures are non-fatal.
- **Homebrew**: `brew install RonenMars/threadbase/tb-streamer` is an alternate end-user install (formula auto-published on stable releases). Mutually exclusive with the `scripts/deploy.sh` install — both bind port 8766. Homebrew services don't pass `--prod`.
- Full shim/Homebrew/menubar install detail: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).
- **Fly.io** (demo + prod cloud): `npm run deploy:fly` (demo, default), `npm run deploy:fly -- --prod` (prod), `npm run deploy:fly -- --prod --demo` (both). Secrets managed via `npm run fly:secrets`. Full guide: [docs/guides/fly.md](docs/guides/fly.md).

## Cloudflare Tunnel

The streamer is exposed publicly at `https://tb-pc.rbv1000.win` → `http://127.0.0.1:8766`, behind Cloudflare Access: **every external request needs `Authorization: Bearer <api_key>`, even `/healthz`** (localhost healthchecks are unaffected). Deployment-specific config (`config-system.yml`, service restart) and general tunnel setup: [docs/guides/remote-access/cloudflare.md](docs/guides/remote-access/cloudflare.md).

## Auto-update

Full guide: [docs/guides/auto-update.md](docs/guides/auto-update.md) (triggers: manual `update` command, scheduled job, HMAC webhook — all opt-in via `~/.threadbase/update.yaml`). Sample config: [docs/update.yaml.example](docs/update.yaml.example). To walk a user through enabling it, use the `setup-auto-updater` skill.

Things that will bite if you forget:

- On Windows, `swapCurrent()` is preceded by `stopService()` because open handles inside `current/dist/cli.cjs` block the file replace. Tests in `__tests__/install.test.ts` lock the order in — keep them green.
- Service-label resolution in `src/updater/restart.ts` falls through `serviceLabel` option → env var (`LAUNCHD_LABEL` / `THREADBASE_SYSTEMD_UNIT` / `THREADBASE_TASK_NAME`) → default matching `scripts/deploy.{sh,ps1}`. Custom labels need the matching env var or the updater restarts the wrong service.
- Active-session defer has three outcomes: reachable+count>0 → defer, reachable+error → defer (state unknown is unsafe), unreachable → proceed. Don't simplify back to "any error returns 0".
- The auth middleware skips both Bearer and `?key=` for `POST /api/__update` (HMAC instead). Don't add other entries to `PUBLIC_POST_PATHS` without an equivalent gate.

## macOS-specific notes

- **launchd plist must set `PATH` via `EnvironmentVariables`**: launchd services inherit only `/usr/bin:/bin:/usr/sbin:/sbin`. Without `/opt/homebrew/bin` (Apple Silicon) / `/usr/local/bin` (Intel) in the plist, `node-pty`'s `execvp("claude", …)` fails with `ENOENT` — every session start becomes an instant-exit zombie with `status=idle`, blank terminal, no `failureReason`. The deploy script's plist generator and self-heal both write the block; see [docs/troubleshooting.md](docs/troubleshooting.md).
- **`resolveClaudeExe()` falls back to absolute Homebrew/local paths on macOS** (`src/platform.ts`) — defense-in-depth so a stale plist alone can't break the streamer.

## Prod/dev coordination

Only one streamer can bind port 8766. The supervised "prod" instance (launchd on macOS, Task Scheduler on Windows) and an ad-hoc "dev" instance coordinate via a marker file at `~/.threadbase/prod-suspended.json` (dev writes it when taking over the port; `--replace-prod` / `--forget` flags on `serve`). Manage prod with `tb-streamer prod start|stop|status|restart|doctor [--fix]|logs`.

Don't break without coordination: the marker shape is versioned (`shimVersion` — bump on change); the plist `ProgramArguments` must run `launchd-entry.cjs … --prod`; the Windows `TASK_NAME` constant in `src/lifecycle/constants.ts` must match `deploy.ps1`. Full component/flag/decision-table reference: [docs/guides/prod-dev-lifecycle.md](docs/guides/prod-dev-lifecycle.md).

## Windows-specific notes

- **`npm install` before first deploy** — fresh clones fail lint/build with "Cannot find module" otherwise; `postinstall` also patches `qrcode-terminal` and node-pty prebuild permissions.
- **Path separators**: use `path.sep` (not `"/"`) for prefix guards on `path.resolve()` output.
- **File timestamps**: `birthtimeMs` is unaffected by `fs.utimes()`; use `mtimeMs` for cross-platform test assertions.
- **Task Scheduler log redirection**: no native stdout/stderr redirection — the task action must use `pwsh.exe` and redirect inside the command string (`>> logfile 2>> errfile`).
- **Task Scheduler env vars**: `[Environment]::SetEnvironmentVariable(..., 'User')` doesn't update the live session; read back from registry and inline the value in the task command string (applies to `THREADBASE_DATABASE_URL`, `THREADBASE_INSTANCE_ID`).
- **Stale port 8766**: kill any node process already bound to 8766 before starting the task — the new task fails silently if the port is taken.
- **Submodule SSH → HTTPS**: machines without SSH keys fail `git submodule update --init`. Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.
- **Integration deploys**: use `npm run deploy:windows:force`; it now skips the advisory npm-version lookup as well as lint/tests, so an unreachable registry cannot delay the local build. If its 15-second healthcheck times out, verify `/healthz`, the `Threadbase` task result, and `~/.threadbase/version.txt` before treating the deploy as failed; details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md#windows-local-deploys) and [docs/troubleshooting.md](docs/troubleshooting.md#deployps1-reports-healthcheck-failed-but-the-server-actually-started-fine-windows).

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`

## Issue tracker

**Format and labels: [threadbase/docs/issue-tracker.md](https://github.com/RonenMars/threadbase/blob/main/docs/issue-tracker.md).** Lives in the `threadbase` umbrella repo and is canonical for **every** component repo — do not keep a local copy or invent a variant.

Read it before filing, labelling, or re-prioritising an issue. In short: title is `P<N>: <what is wrong>`, and every issue carries exactly one priority label (`P0`–`P3`) plus exactly one type (`bug`, `enhancement`, `documentation`, `question`, `tech-debt`) and any number of area labels.

GitHub is the worklist for open work. `docs/BACKLOG.md` and `docs/ROADMAP.md` are not — they hold diagnosis and plans, and duplicating an item's *status* into them is what caused the drift that [docs/2026-08-10-open-items-register.md](docs/2026-08-10-open-items-register.md) exists to record.

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`

## Backward compatibility with tb-mobile

`tb-mobile` is a released iOS/Android app that cannot be force-updated — a breaking server change silently breaks any user who hasn't updated. The streamer must stay backward-compatible with older mobile clients.

**Before changing any API response shape, endpoint path, query parameter, status value, or WebSocket event, read [docs/compatibility/tb-mobile.md](docs/compatibility/tb-mobile.md)** — it enumerates every path, field name, and event string mobile depends on.

The hard rules:

- Never rename or remove endpoints, response fields (casing matters), query params, session status strings, or WS event types. Additive changes only (new optional fields, new endpoints, new event types — mobile ignores unknowns).
- Session statuses mobile switches on: `running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle` (alias of `on_hold`). The server currently emits `running`/`waiting_input`/`idle` for live sessions and `on_hold` for resumable conversations; `completed`/`failed` are legacy values older streamers emitted — don't reuse them with new semantics.
- Auth: `Authorization: Bearer <token>` AND `/ws?key=<token>` must both keep working; API key format `tb_<32-hex-chars>` is load-bearing in pairing.
- For a risky change: keep the old shape alongside the new one, or open a coordinated tb-mobile PR and document the minimum required app version in the commit message.

## Menubar app (vendor/menubar)

`vendor/menubar` is a git submodule (`RonenMars/threadbase-menubar`) — an Electron tray app that polls `GET /healthz` every 5s. Don't break without coordinating a menubar update: the `port:` field in `server.yaml` (its port resolution: `THREADBASE_PORT` env → `port:` → fallback `8766`), the `/healthz` `{ ok, version }` shape, or the default port. Submodule bumps use a `chore: bump vendor/menubar (<reason>)` commit. Deploy fetches a prebuilt release matching the submodule SHA and only builds locally as fallback — flow details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a section following the existing format (symptom → cause → fix) and commit it alongside any code fix.

## Release notes

Milestone-level release notes live in `docs/release-notes/YYYY-MM-DD-<milestone>.md` — the human story of what shipped; separate from `CHANGELOG.md`, which semantic-release auto-generates (never edit it by hand). When a milestone is ready to merge, add the `milestone` label to the merge PR and write the release notes manually using `docs/release-notes/_template.md` as the skeleton.

## Cursor Cloud specific instructions

The Cloud VM runs Node 22 (in `engines: >=20 <25`; a required CI check), even though `.nvmrc` pins v24.15.0. `better-sqlite3` and `node-pty` compile natively against the running Node at install time — the startup update script (`npm install`) handles that. Standard lint/test/build/run commands are in `README.md` and `package.json` scripts; don't duplicate them here. Build before running: you execute the built `dist/cli.cjs`, and `npm run dev` is only the tsup watcher (it does not start a server).

Non-obvious gotchas when running the server here (Linux):

- **`serve` needs `--prod` on Linux.** A plain `node dist/cli.cjs serve` crashes with `lifecycle: unsupported platform linux` — the dev/prod-coordination path (`detectProdActive` → `getSupervisor` in `src/lifecycle/platform.ts`) only supports darwin/win32. Passing `--prod` marks the run as supervised, skips that path and the first-run TTY prompts, and installs plain shutdown handlers. (Without `--prod`, an interactive TTY also blocks on permission-mode / auto-resume prompts; `THREADBASE_SKIP_PERMISSION_MODE_PROMPT=true` + `THREADBASE_SKIP_AUTO_RESUME_PROMPT=true` suppress those, but `--prod` already avoids them.)
- **Live sessions need a `claude` binary.** `POST /api/sessions/start` spawns `claude` in a PTY (resolved via `which`, then `~/.local/bin/claude`); with none present, sessions instant-exit to `idle`. The repo ships a reviewer-safe stub at `docker/claude-code-stub/claude.js` that prints the welcome box + `❯` ready marker and echoes scripted replies (no Anthropic calls). To exercise the full PTY + WebSocket flow, install it as an executable `~/.local/bin/claude` (`cp docker/claude-code-stub/claude.js ~/.local/bin/claude && chmod +x`).
- **`POST /api/sessions/start` requires `--browse-root <dir>`** and a body `{ "path": "<dir-relative-to-browse-root>" }`; otherwise it returns 403 `BROWSE_ROOT_NOT_SET`. Send prompts to a session with `POST /api/sessions/:id/input` `{ "input": "…" }`.
- End-to-end smoke: `node dist/cli.cjs serve --prod --local-no-auth --browse-root <dir> --no-pair-qr` (with the stub on PATH), then `curl /healthz`, start a session, POST input, and read `/api/sessions/:id/output` or subscribe over `ws://localhost:8766/ws` with `{ "type": "subscribe_session", "sessionId": "…" }` to see `terminal_replay` + live `terminal_output`.
- Persistence (SQLite cache + runtime DB under `~/.threadbase/`) is auto-created; no external DB needed. Postgres (`THREADBASE_DATABASE_URL`) and Temporal/multi-agent mode (`MULTI_AGENT_FLOW`) are optional and off by default.
