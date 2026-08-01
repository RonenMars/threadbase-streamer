# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Known deploy/runtime issues and their fixes: [docs/troubleshooting.md](docs/troubleshooting.md)

## Project

`@threadbase-sh/streamer` — PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. TypeScript library + CLI that manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API.

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
- `codex-pty-runner.ts` — same for Codex sessions. Blocking startup gates (directory trust, hooks review) become question cards over the `permission` WS transport; a "remember for all projects" answer persists to `~/.threadbase/gate-answers.json` (`services/questions/codexGateAnswers.ts`) and auto-answers future gates. Readiness = `Ready` status-bar marker, with a 500ms quiet-checker + 8s flat fallback (the marker truncates off the 120-col status bar when branch/diff segments are long).
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions. All session state mutations go through it.
- `conversation-cache.ts` — SQLite cache of conversation metadata, message tails, projects, and cache_metadata; updated incrementally by `ConversationWatcher` (chokidar). Backs `/api/conversations`, `/api/sessions`, and `/project-chats`. Runs SQLite migrations on open (`db/sqlite-migrate.ts` + `db/migrations/*.sql`, tracked in `schema_migrations`).
- `services/conversations/conversationWatcher.ts` — chokidar-backed JSONL tail + directory watcher. Emits per-line events (cache + WS broadcast) and per-file dirty events (cache invalidation).
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list; unicasts terminal_replay on subscribe and session_ready on PTY spawn
- `server.ts` — HTTP server lifecycle; wires `@hono/node-server` + `@hono/node-ws`, constructs `ApiDeps`, delegates request handling to the Hono app (`api/app.ts`)
- `api/routes/` — one file per endpoint group; each factory takes `ApiDeps` and returns a Hono sub-app. Handlers write directly to the Node `ServerResponse` via `c.env.outgoing` and return a sentinel `Response(null, { status: 597 })` (`ALREADY_HANDLED`) to skip Hono response piping.
- `services/conversations/isAgentConversation.ts` — detects agent-authored JSONLs by `entrypoint` field (default `sdk-cli`, `claude-vscode`; interactive Claude Code emits `cli` and is never matched). The file probe is a chunked scan (64 KB chunks, 64-byte overlap) that early-exits at the first `"entrypoint":` occurrence — the value is per-conversation and authoritative, so large human JSONLs aren't read in full.
- `utils/canonicalizeProjectPath.ts` — the single source of truth for project-path identity; every consumer must canonicalize before dedupe.
- `utils/canonicalizeFilePath.ts` — the same discipline for **JSONL file paths**, plus the scanner/cache boundary helpers. Two path forms exist and are not interchangeable on Windows: **canonical** (forward slashes — every cache key: `conversation_meta.file_path`, `fileIndex`, watcher keys, `externalTails`) and **native** (what the scanner emits in `ConversationMeta.filePath`, and what chokidar delivers). Both writers of `conversation_meta.file_path` store canonical, so "cache keys are always canonical" is an invariant; the scanner has no such rule. **When the two meet: normalize for the comparison, emit in the consumer's form.** Use `canonicalLivePathSet()` and `joinStatCacheByNativePath()` rather than hand-rolling the conversion — a missed normalization fails *silently* (an empty map, a `false`, a fallback — never an exception) and is invisible on POSIX and therefore to CI, where both forms are identical.
- `db/migrations.ts` + `db/pg-migrations/*.sql` — Postgres migration runner. Postgres is dormant (only `session_uploads` + reserved tables); SQLite is the primary persistence layer.
- `schemas/*.schema.ts` — zod validation at HTTP/scanner boundaries

## Session lifecycle

Live statuses (`SessionStatus` in `src/types.ts`): `running`, `waiting_input`, `idle`.

```
running ──(prompt marker ╭ / ❯, or fallback timer)──► waiting_input
   │                                                       │
   └───────────────(user sends input)◄─────────────────────┘

running / waiting_input ──(PTY exit, any code)──────────────► idle
running / waiting_input ──(grace timer / hold_session msg)──► idle  (PTY killed, history intact)
```

- **`waiting_input`**: Claude printed a prompt marker (`CLAUDE_PROMPT_MARKERS = ["╭", "❯"]` in `pty-manager.ts`, plus a fallback timeout) — idling for user input.
- **`idle`**: no live PTY. Reached on process exit or via `PTYManager.putOnHold()` (SIGINT + screen disposal). History intact; resume via `POST /api/sessions/resume` with the same `conversationId`.
- **Grace/hold**: when the last WebSocket subscriber disconnects, `server.ts` starts a grace timer (`ptyGracePeriodMs`, default 270 000 ms) that calls `putOnHold()`. A client can hold immediately with `{ type: "hold_session", sessionId }` (same path, zero delay).
- **Resume writes to the SAME JSONL.** Claude `--resume` appends to the existing `<conversationId>.jsonl` and keeps the same `sessionId` field (verified against Claude Code v2.1.215) — it does *not* fork a new UUID file. Older comments claimed the opposite; `watchForJsonl`'s mtime fallback only binds a candidate whose filename stem or first-line `sessionId` matches the session id.
- **Resume is collision-checked.** `POST /api/sessions/resume` runs a pre-flight busy probe (`services/sessions/conversationBusy.ts`) and answers 409 `CONVERSATION_BUSY` when the conversation looks actively owned elsewhere — JSONL mtime within `RESUME_BUSY_WINDOW_MS` (120 000, override with `THREADBASE_RESUME_BUSY_WINDOW_MS`), a discovered process resuming the same id, or (POSIX only) a discovered process in the same project dir. `{ force: true }` in the body always proceeds. It is a one-directional pre-flight guard: nothing stops an external terminal attaching after the streamer holds the PTY.
- An instant non-zero exit (<2 s, no output) gets a diagnosed `failureReason` (missing project dir, or Claude binary not found).
- **Mobile mapping**: historical conversations are returned as resumable shapes with `status: "on_hold"` (`conversationToResumableSession` in `server.ts`); mobile treats `idle` and `on_hold` as the same.

## Environment variables

| Variable | Description |
|----------|-------------|
| `THREADBASE_DATABASE_URL` | PostgreSQL connection URI — enables DB persistence when set (also: `THREADBASE_DATABASE_SSL`, `THREADBASE_DATABASE_POOL_MAX`, `THREADBASE_DATABASE_STATEMENT_TIMEOUT_MS`) |
| `THREADBASE_INSTANCE_ID` | Stable identifier for this server instance (defaults to `os.hostname()`); scopes DB-persisted sessions |
| `THREADBASE_PUBLIC_URL` | Public HTTPS URL for QR pairing (overrides `public_url:` in server.yaml) |
| `THREADBASE_INCLUDE_AGENTS` | Show non-interactive Claude runs (agent SDK, hook invocations) in `/api/conversations` + `/project-chats`. Default off. Toggling triggers a one-time prune-or-rescan on next restart. |
| `THREADBASE_AGENT_ENTRYPOINTS` | JSONL `entrypoint` values treated as agent traffic. Default `sdk-cli,claude-vscode`. |
| `THREADBASE_DIR_SCAN_DEBOUNCE_MS` | Trailing debounce (ms) before a project-directory change flags the scanner stale; collapses an event storm during active sessions into one rescan. Default `1000`. |
| `THREADBASE_CONFIG_DIR` | Overrides the config directory (default `~/.threadbase`) that `server.yaml` — including the `api_key` — is read from and written to. Mainly a test hook: it lets `setApiKey`/`loadOrCreateApiKey` target a throwaway dir so `POST /api/auth/rotate` and `set-key` never clobber the real live config. Unset in production. |
| `MULTI_AGENT_FLOW` | Routes `POST /api/sessions/start` + `/input` to the multi-agent path instead of PTY. `AGENT_*` tuning vars: see [docs/multi-agent-mode.md](docs/multi-agent-mode.md). |
| `THREADBASE_SKIP_PERMISSION_MODE_PROMPT` | Set to `true` to disable the `serve` first-run interactive permission-mode prompt (see below); falls straight through to `acceptEdits`. |
| `THREADBASE_ALLOW_BROWSER_CORS` | Enables browser CORS (off by default; no web page can make authenticated requests without it). Set to `1`/`true`/`yes`/`on` to allow the localhost dev origins, or to a comma-separated origin list (e.g. `https://app.example.com`) to allow those on top of the dev defaults. Overrides `browser_cors:` in server.yaml when set. Mobile is unaffected (no `Origin` header). |

## Multi-agent mode

When `MULTI_AGENT_FLOW=true`, session start/input route through a Temporal-orchestrated pipeline; PTY mode is unreachable. Endpoints return structured errors `{error, code}` (codes in `src/agent/errors.ts`); mobile-relevant: **429 `SESSION_BUSY`** (carries `retryAfterMs`) and **413 `SESSION_HISTORY_FULL`** (prompt "start a new conversation"). Full endpoint contract, env vars, and dev setup: [docs/multi-agent-mode.md](docs/multi-agent-mode.md); design rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`, `default_permission_mode`, `browser_cors`, `pty_grace_period_ms`) from it, but most runtime knobs come exclusively from CLI flags. Setting `port:` in `server.yaml` does nothing — the listening port comes only from `--port` (CLI default `8766`). Any service definition (launchd plist, systemd unit, Task Scheduler action) **must** pass `--port <n>` explicitly — the deploy scripts already do.

`--default-permission-mode <acceptEdits|manual>` (or `default_permission_mode:` in `server.yaml`) controls the Claude Code `--permission-mode` used to spawn every PTY session — `acceptEdits` (default) auto-approves file edits and still prompts for shell commands; `manual` prompts for everything. `bypassPermissions`/`plan`/`dontAsk`/`auto` are intentionally not offered — `bypassPermissions` renders a blocking "Bypass Permissions mode" TUI warning on every boot that hangs the mobile client (see `src/pty-manager.ts`).

If none of the flag/env/yaml sources set a mode, `serve` shows a one-time interactive prompt (`src/lifecycle/prompt.ts`'s `interactivePermissionModePrompt`) and persists the answer to `server.yaml` via `setDefaultPermissionMode()` — but only for a human dev invocation on a real TTY (never under `--prod`/launchd, which must never block on stdin). Set `THREADBASE_SKIP_PERMISSION_MODE_PROMPT=true` to skip it and fall through to `acceptEdits`.

`--pty-grace-period-ms <ms>` (or `pty_grace_period_ms:` in `server.yaml`) sets the auto-hold delay: how long a PTY stays alive after its last WebSocket subscriber disconnects before `server.ts` holds it (SIGINT + screen disposal, history intact, resumable). Precedence is flag → yaml → default `270000` (4.5 min). `0` disables the automatic timer — the PTY lives until process exit or an explicit `{ type: "hold_session" }` message (that path always holds immediately, regardless of this setting). Any positive integer is a custom delay in ms.
The value is resolved once at startup, so changing it requires a restart — there is no hot-reload.
For the launchd/Task-Scheduler-supervised prod instance (whose plist/task args are fixed and don't pass this flag), set `pty_grace_period_ms:` in `server.yaml` and run `tb-streamer prod restart`; the `--pty-grace-period-ms` flag is the path for ad-hoc `serve` runs (an ad-hoc `serve` with the flag would otherwise collide with prod on port 8766).

## ServerConfig options (beyond CLI flags)

| Field | Default | Description |
|-------|---------|-------------|
| `ptyGracePeriodMs` | `270000` | Ms to keep the PTY alive after all WebSocket subscribers disconnect (4.5 minutes). `0` disables the auto-hold timer entirely — the PTY stays live until process exit or an explicit `hold_session`. Set via `--pty-grace-period-ms` or `pty_grace_period_ms:` in server.yaml. |
| `cacheDir` | `~/.threadbase/cache` | Directory for the SQLite conversation cache |
| `tailSize` | `10` | Tail messages cached per conversation for fast session-list enrichment |
| `directoryScanDebounceMs` | `1000` | Trailing debounce (ms) before a directory change flags the scanner stale (env override: `THREADBASE_DIR_SCAN_DEBOUNCE_MS`) |

## Dependencies

- `@threadbase-sh/scanner` + `@threadbase-sh/agent-types` — published **public npm packages**, wired as normal semver deps. tsup bundles them inline into `dist/` (runtime doesn't need them at install time). Consequences:
  - A fresh checkout just runs `npm install` — no `git submodule update` needed.
  - CI checkouts use `submodules: false` (scanner/agent-types come from npm; only menubar remains a submodule and isn't needed in build/test).
  - Bump by raising the version range here and publishing a new version from `tb-scanner` / `threadbase-agent-types` (each repo publishes via its own semantic-release release workflow).
- `node-pty` — native PTY management (external, not bundled by tsup; dynamically imported for graceful failure)
- `ws`, `better-sqlite3`, `chokidar`, `zod`, `date-fns`, `commander`

**`git pull` does not refresh `node_modules`.** A pull (or branch switch) that changes `package.json`/`package-lock.json` leaves the existing `node_modules` on disk untouched — `npm run build`/`deploy` will silently bundle whatever versions are already installed, not what the new lockfile pins. Check with `npm ls --depth=0` (an `invalid: "<range>" from the root project` line means `node_modules` is stale) and resync with `npm ci` before building/deploying after any dependency-affecting pull.

## Build notes

- **CLI externals**: only `node-pty` is external for the CLI tsup entry. `pg` and everything else must be bundled — the deployed CLI lives in `~/.threadbase/releases/` with no `node_modules`.
- `npm run build` copies both `src/db/migrations/` (SQLite) and `src/db/pg-migrations/` (Postgres) into `dist/`; deploy ships only the SQLite folder. Details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

## Deploy & distribution

- Every deploy installs two global commands wrapping `~/.threadbase/cli.js`: `threadbase-streamer` (entrenched name) and `tb-streamer` (short alias). Shim install is interactive by default; non-interactive via `--install-shim=` / `--path-update=` flags or `TB_INSTALL_SHIM` / `TB_PATH_UPDATE` env vars. Failures are non-fatal.
- **npm**: `npm install -g @threadbase-sh/streamer` installs the CLI from the public npm registry (published on stable releases via semantic-release). The published package ships the prebuilt `dist/` (scanner/agent-types/qrcode-terminal bundled inline); only `node-pty` compiles/prebuilds on install.
- **Homebrew**: `brew install RonenMars/threadbase/tb-streamer` is an alternate end-user install (formula auto-published on stable releases). Mutually exclusive with the `scripts/deploy.sh` install — both bind port 8766. Homebrew services run `serve --prod` under the `homebrew.mxcl.tb-streamer` launchd label; the prod/dev lifecycle (`src/lifecycle/launchd.ts`) resolves the loaded label at runtime, so `tb-streamer prod …` controls a brew-supervised instance too.
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

- **`npm install` before first deploy** — fresh clones fail lint/build with "Cannot find module" otherwise; `prepare` patches `qrcode-terminal` (dev/source installs only) and `postinstall` fixes node-pty prebuild permissions (all installs).
- **Path separators**: use `path.sep` (not `"/"`) for prefix guards on `path.resolve()` output.
- **File timestamps**: `birthtimeMs` is unaffected by `fs.utimes()`; use `mtimeMs` for cross-platform test assertions.
- **Task Scheduler log redirection**: no native stdout/stderr redirection — the task action must use `pwsh.exe` and redirect inside the command string (`>> logfile 2>> errfile`).
- **Task Scheduler env vars**: `[Environment]::SetEnvironmentVariable(..., 'User')` doesn't update the live session; read back from registry and inline the value in the task command string (applies to `THREADBASE_DATABASE_URL`, `THREADBASE_INSTANCE_ID`).
- **Stale port 8766**: kill any node process already bound to 8766 before starting the task — the new task fails silently if the port is taken.
- **Submodule SSH → HTTPS**: machines without SSH keys fail `git submodule update --init`. Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`

## Merging PRs — Rebase + Squash, Linear History

Keep `main` a straight line — one commit per PR, no merge commits. Every PR follows the same two operations, in this order:

1. **Rebase onto latest `main`** to sync before merging. `git fetch origin && git rebase origin/main`, resolve conflicts preserving the PR's intent, then `git push --force-with-lease` (never plain `--force`, never force-push `main`). This guarantees no merge commit sneaks in.
2. **Squash-merge** the rebased PR: `gh pr merge <N> --squash --delete-branch`. The squash title must be conventional-commit compliant and carry no AI attribution.

Rules:

- **One PR at a time.** Never sync/merge PRs in parallel — rebase one, wait for its CI to go green, squash-merge it, then move to the next. A just-merged PR advances `main`, so the next PR is usually behind and must be rebased again.
- **Dependency order first.** If PR B is stacked on PR A (GitHub shows A's branch as B's base), merge A before B and rebase B onto the updated `main` afterward.
- **CI gate.** Only squash-merge when required checks are green. If CI is red on a flaky/infra failure, re-run it **once**; if the re-run still fails, stop and report — do not merge red.
- **Stuck cap.** If any single step hangs for more than ~3–4 minutes (CI not progressing, a rebase that won't resolve cleanly), stop and report rather than waiting indefinitely.

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`

Use the Node version in `.nvmrc` for local verification, especially for tests or code paths that load `better-sqlite3`. Running under a newer Homebrew/global Node can pick up native modules compiled for a different `NODE_MODULE_VERSION`, causing ABI errors or failed rebuilds unrelated to the product change.

## Backward compatibility with tb-mobile

`tb-mobile` is a released iOS/Android app that cannot be force-updated — a breaking server change silently breaks any user who hasn't updated. The streamer must stay backward-compatible with older mobile clients.

**Before changing any API response shape, endpoint path, query parameter, status value, or WebSocket event, read [docs/compatibility/tb-mobile.md](docs/compatibility/tb-mobile.md)** — it enumerates every path, field name, and event string mobile depends on.

The hard rules:

- Never rename or remove endpoints, response fields (casing matters), query params, session status strings, or WS event types. Additive changes only (new optional fields, new endpoints, new event types — mobile ignores unknowns).
- Session statuses mobile switches on: `running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle` (alias of `on_hold`). The server currently emits `running`/`waiting_input`/`idle` for live sessions and `on_hold` for resumable conversations; `completed`/`failed` are legacy values older streamers emitted — don't reuse them with new semantics.
- Auth: `Authorization: Bearer <token>` AND `/ws?key=<token>` must both keep working; API key format `tb_<32-hex-chars>` is load-bearing in pairing.
- For a risky change: keep the old shape alongside the new one, or open a coordinated tb-mobile PR and document the minimum required app version in the commit message.

## Menubar app (vendor/menubar)

`vendor/menubar` is a git submodule (`RonenMars/threadbase-menubar`) — an Electron tray app that polls `GET /healthz` every 5s. Don't break without coordinating a menubar update: the `port:` field in `server.yaml` (its port resolution: `THREADBASE_PORT` env → `port:` → fallback `8766`), the `/healthz` `{ ok, version }` shape, or the default port. Submodule bumps use a `chore: bump vendor/menubar (<reason>)` commit. Deploy no longer installs the menubar — `npm run deploy` / `scripts/deploy.sh` touch only the streamer; the menubar is installed separately via the `deploy-menubar` skill (`.claude/skills/deploy-menubar`). Flow details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

- **`git pull` does NOT update the submodule checkout.** Pulling a commit that bumps the `vendor/menubar` pointer only updates the *recorded* SHA in the parent repo's tree — the actual files on disk under `vendor/menubar` stay at the old commit until you run `git submodule update --init --recursive vendor/menubar` (`git submodule status vendor/menubar` shows a leading `+` when the two disagree). The `deploy-menubar` skill builds from the *checked-out* submodule SHA, not the parent repo's recorded pointer — so after a `git pull` that bumps the submodule, a menubar deploy can silently rebuild the old version until the submodule is explicitly updated.
- **Avoid a dirty `vendor/menubar` checkout.** Running `npm install` inside `vendor/menubar` (e.g. via the `deploy-menubar` skill's dependency-install step) can rewrite `vendor/menubar/package-lock.json` with metadata-only npm normalization (e.g. an added `"license"` field), which marks the submodule pointer `<sha>-dirty` in the parent repo even though no real dependency changed. Only run `npm install` there if `package.json` actually changed. If it happens anyway, `cd vendor/menubar && git checkout -- package-lock.json` clears it.

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a section following the existing format (symptom → cause → fix) and commit it alongside any code fix.

## Release notes

Milestone-level release notes live in `docs/release-notes/YYYY-MM-DD-<milestone>.md` — the human story of what shipped; separate from `CHANGELOG.md`, which semantic-release auto-generates (never edit it by hand). When a milestone is ready to merge, add the `milestone` label to the merge PR and write the release notes manually using `docs/release-notes/_template.md` as the skeleton.
