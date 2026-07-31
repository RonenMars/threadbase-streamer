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
- `db/runtime-store.ts` — `~/.threadbase/runtime.db`, the **authoritative** SQLite file, holding `managed_sessions`. Deliberately a different file from `cache/cache.db` and deliberately not under `cache/`: everything in the cache is rebuildable from `~/.claude`/`~/.codex`, this is not. It must survive "delete the cache and restart" and the integrity monitor's reset-and-rescan, and its open is independent of the cache's — a `better-sqlite3` ABI mismatch used to null `ManagedSessionsRepository` and silently disable *all* session persistence while the server kept running. Own migrations dir (`db/runtime-migrations/*.sql`), own `schema_migrations` table. Opening it copies a pre-split `managed_sessions` out of `cache.db` once, non-destructively.
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
- **Grace/hold**: a WebSocket disconnect arms **nothing** — `handleWsClose` deliberately does not start a kill timer, because a socket closing is not a request to stop the agent (phones sleep, signal drops, Wi-Fi hands off). The *only* caller of `startGraceTimer` is an explicit `{ type: "hold_session", sessionId }` message, which arms `ptyGracePeriodMs` (default 270 000 ms) and then calls `putOnHold()` — e.g. mobile sends this on app backgrounding, so the session keeps running until the timer actually elapses. A `running` session defers the hold and re-arms, up to `GRACE_MAX_DEFERS` (4) consecutive defers, so a turn is never cut mid-response. See [docs/architecture/2026-07-24-durable-session-runtime.md](docs/architecture/2026-07-24-durable-session-runtime.md).
- **Idle reaper**: the resource bound that replaced kill-on-disconnect. Every `IDLE_REAP_SWEEP_MS` (5 min) the server holds any PTY whose *agent* has been silent for `IDLE_REAP_AFTER_MS` (**6 h** — no output chunk, no user input). It measures agent inactivity, not subscriber absence, and never touches a `running` session however long the turn runs. Both constants are code, not config.
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
| `THREADBASE_FEATURE_*` | One var per feature flag (`THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT`, …). Highest-precedence source; see [Feature flags](#feature-flags). Truthy `1/true/yes/on`, falsy `0/false/no/off/""`; unset means "defer to the CLI flag, then server.yaml". |
| `THREADBASE_CONFIG_DIR` | Overrides the config directory (default `~/.threadbase`) that `server.yaml` — including the `api_key` — is read from and written to. Mainly a test hook: it lets `setApiKey`/`loadOrCreateApiKey` target a throwaway dir so `POST /api/auth/rotate` and `set-key` never clobber the real live config. Unset in production. |
| `THREADBASE_RUNTIME_DB` | Overrides the path of the session-registry database (default `runtime.db` inside the config dir). A test hook first: `__tests__/setup/isolate-runtime-db.ts` points every test file at a throwaway file so a suite run never writes sessions into the real `~/.threadbase/runtime.db`. It exists separately from `THREADBASE_CONFIG_DIR` because several auth tests sandbox the config dir by overriding `HOME`, and `THREADBASE_CONFIG_DIR` outranks `homedir()`. Unset in production. |
| `MULTI_AGENT_FLOW` | Routes `POST /api/sessions/start` + `/input` to the multi-agent path instead of PTY. `AGENT_*` tuning vars: see [docs/multi-agent-mode.md](docs/multi-agent-mode.md). |
| `THREADBASE_SKIP_PERMISSION_MODE_PROMPT` | Set to `true` to disable the `serve` first-run interactive permission-mode prompt (see below); falls straight through to `acceptEdits`. |
| `THREADBASE_ALLOW_BROWSER_CORS` | Enables browser CORS (off by default; no web page can make authenticated requests without it). Set to `1`/`true`/`yes`/`on` to allow the localhost dev origins, or to a comma-separated origin list (e.g. `https://app.example.com`) to allow those on top of the dev defaults. Overrides `browser_cors:` in server.yaml when set. Mobile is unaffected (no `Origin` header). |
| `APNS_KEY` | **Contents** of the APNs p8 signing key (PEM), not a path. Enables iOS Live Activity push when set; the feature stays off (one info log, server boots normally) when unset. Never logged. See [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md). |
| `APNS_KEY_ID` | Key id of the p8 in `APNS_KEY`. Required when `APNS_KEY` is set; under launchd it is derived from the `AuthKey_<keyId>.p8` filename. |
| `APNS_TEAM_ID` | Apple Developer team id. Required when `APNS_KEY` is set; no default, so one deployment's Apple account is never baked into the source. |
| `APNS_BUNDLE_ID` | App bundle id; the APNs topic is this plus `.push-type.liveactivity`. Required when `APNS_KEY` is set. |
| `APNS_HOST` | APNs host. Defaults to sandbox (`api.sandbox.push.apple.com`) because the app's `aps-environment` is still `development`; set `api.push.apple.com` for production. |

## iOS Live Activity push

`APNS_KEY` enables direct-to-APNs Live Activity pushes (Lock Screen / Dynamic Island surfaces for running sessions). ActivityKit **cannot** go through Expo's relay — different token type, `.push-type.liveactivity` topic, p8 credential — so this path uses `node:http2` directly and never `expo-server-sdk`.

Three token kinds now arrive from one device and are not interchangeable: `expo` (relay, ordinary notifications), `liveactivity_start` (push-to-start, app-wide), `liveactivity_update` (per-activity, short-lived). `PushRepository.listDeliverable()` is Expo-only — that query is what keeps the ordinary notification fan-out from handing an ActivityKit token to Expo.

The content-state shape is a **contract shared with tb-mobile** (decoded by a Swift `Codable` struct). An ActivityKit decode failure is silent — the surface just stops updating — so changing a field name or type requires a coordinated tb-mobile change. `startedAt` is epoch **milliseconds** and iOS renders its own ticking timer from it: never send a computed elapsed value, and carry the original value through a renewal or the user's timer visibly resets to zero.

`LiveActivityNotifier` is **per-turn, not per-session**: a push fires on the `waiting_input → running` edge (turn starts) and the matching `running → waiting_input` edge (turn — including sub-agents — ends), not on every status transition. A fresh session's first `running` has no prior `waiting_input`, so booting/idling never opens an activity. `sessionName` (derived from the first user message, `src/utils/deriveSessionName.ts`) is included in content-state and mobile should fall back to `projectName` when it's unset.

Full contract, env vars, failure handling: [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md).

## Multi-agent mode

When `MULTI_AGENT_FLOW=true`, session start/input route through a Temporal-orchestrated pipeline; PTY mode is unreachable. Endpoints return structured errors `{error, code}` (codes in `src/agent/errors.ts`); mobile-relevant: **429 `SESSION_BUSY`** (carries `retryAfterMs`) and **413 `SESSION_HISTORY_FULL`** (prompt "start a new conversation"). Full endpoint contract, env vars, and dev setup: [docs/multi-agent-mode.md](docs/multi-agent-mode.md); design rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`, `default_permission_mode`, `browser_cors`, `pty_grace_period_ms`, `claude_flags`, `claude_extra_args`, `feature_flags`) from it, but most runtime knobs come exclusively from CLI flags.

The file is parsed by **single-line regex, not a YAML library** — every value must stay on one line. `claude_flags:` and `feature_flags:` therefore store one line of JSON (`{"permissionMode":"bypassPermissions"}`, `{"codexSystemPrompt":true}`), which keeps colons/quotes/spaces escaped for free; a corrupt line is logged and ignored rather than failing the boot. Setting `port:` in `server.yaml` does nothing — the listening port comes only from `--port` (CLI default `8766`). Any service definition (launchd plist, systemd unit, Task Scheduler action) **must** pass `--port <n>` explicitly — the deploy scripts already do.

`--default-permission-mode <mode>` (or `default_permission_mode:` in `server.yaml`) controls the Claude Code `--permission-mode` used to spawn every PTY session. All six CLI values are accepted: `acceptEdits` (default — auto-approves file edits, still prompts for shell commands), `manual`, `auto`, `plan`, `bypassPermissions`, `dontAsk`.

`bypassPermissions`/`dontAsk` disable the confirmation prompts entirely. They would normally hit a blocking "Bypass Permissions mode" warning menu at boot (`1. No, exit` / `2. Yes, I accept`) that strands the PTY and leaves mobile on an empty screen; `buildSettingsJson()` in `src/claude-flags.ts` suppresses it by adding `skipDangerousModePermissionPrompt` to the `--settings` blob for exactly those modes (probe-verified against Claude Code v2.1.218). The streamer never passes `--dangerously-skip-permissions` — bypass is always requested via `--permission-mode`.

**Security.** Enabling a bypass mode turns every future session on this machine into unattended arbitrary code execution: a leaked API key no longer stops at a human-in-the-loop confirmation. `--add-dir` compounds it by widening the filesystem scope beyond the project. `PUT /api/config/claude-flags` is therefore refused (403) while `--local-no-auth` is active, and every flag change is logged at info level with old→new values.

**There is no spend cap.** `--max-budget-usd` was previously offered here as a runaway bound; it is `(only works with --print)` per `claude --help`, and this server never passes `--print`, so it was a silent no-op — it has been removed from the registry (along with `--fallback-model`, inert for the same reason). Nothing bounds the cost of a bypass-mode session today. Treat the auth boundary and the permission mode as the only real controls, and check any flag you add for a `--print`-only note before trusting it.

If none of the flag/env/yaml sources set a mode, `serve` shows a one-time interactive prompt (`src/lifecycle/prompt.ts`'s `interactivePermissionModePrompt`) and persists the answer to `server.yaml` via `setDefaultPermissionMode()` — but only for a human dev invocation on a real TTY (never under `--prod`/launchd, which must never block on stdin). Set `THREADBASE_SKIP_PERMISSION_MODE_PROMPT=true` to skip it and fall through to `acceptEdits`.

`--pty-grace-period-ms <ms>` (or `pty_grace_period_ms:` in `server.yaml`) sets the delay between an explicit `{ type: "hold_session" }` message and the actual hold (SIGINT + screen disposal, history intact, resumable). Precedence is flag → yaml → default `270000` (4.5 min). Since `handleWsClose` no longer arms a timer, this knob governs the explicit hold path *only*.

**`0` does not mean "never".** It means the explicit hold fires with zero delay — i.e. backgrounding the mobile app kills the session instantly. There is no sentinel for "never hold": to effectively disable the hold, set a delay longer than any session you care about (e.g. `604800000`, 7 days). Stay clear of `2147483647` — that is exactly Node's `TIMEOUT_MAX`, and one increment past it makes `setTimeout` overflow and fire at 1 ms, silently inverting the setting into "hold immediately". Note the 6 h idle reaper still applies regardless of this value.
The value is resolved once at startup, so changing it requires a restart — there is no hot-reload.
For the launchd/Task-Scheduler-supervised prod instance (whose plist/task args are fixed and don't pass this flag), set `pty_grace_period_ms:` in `server.yaml` and run `tb-streamer prod restart`; the `--pty-grace-period-ms` flag is the path for ad-hoc `serve` runs (an ad-hoc `serve` with the flag would otherwise collide with prod on port 8766).

## ServerConfig options (beyond CLI flags)

| Field | Default | Description |
|-------|---------|-------------|
| `ptyGracePeriodMs` | `270000` | Ms between an explicit `hold_session` message and the hold (4.5 minutes). Not armed by WebSocket disconnect. `0` means hold *immediately*, not "never" — there is no never sentinel; use a very large delay instead (see above). Set via `--pty-grace-period-ms` or `pty_grace_period_ms:` in server.yaml. |
| `cacheDir` | `~/.threadbase/cache` | Directory for the SQLite conversation cache |
| `tailSize` | `10` | Tail messages cached per conversation for fast session-list enrichment |
| `directoryScanDebounceMs` | `1000` | Trailing debounce (ms) before a directory change flags the scanner stale (env override: `THREADBASE_DIR_SCAN_DEBOUNCE_MS`) |
| `claudeFlags` | `{}` | Allowlisted Claude CLI flags appended to every spawn. Registry + validation in `src/claude-flags.ts`; persisted as one line of JSON under `claude_flags:` in server.yaml. Set via repeatable `--claude-flag <id=value>` or `PUT /api/config/claude-flags`. Includes `model` and `effort`, which is how the server default for those is changed at runtime — see below. |
| `claudeExtraArgs` | — | Free-text argv appended after `claudeFlags` (and after `--resume`/`--session-id`), so it can override them. Unvalidated escape hatch; persisted under `claude_extra_args:`. Set via `--claude-extra-args`. |
| `featureFlags` | registry defaults | Server feature flags from the CLI (`--feature <id=bool>`). Merged with the env vars and `feature_flags:` in server.yaml — see [Feature flags](#feature-flags). |

## Model & effort

Three claude-flags are **spawn positionals**, not allowlist-appended: `permissionMode`, `model`, `effort`. `buildFlagArgs` deliberately skips them (`SPAWN_POSITIONAL_FLAG_IDS` in `src/claude-flags.ts`) because both PTY spawn paths already pass `--permission-mode`, `--model` and `--effort` explicitly; emitting them twice would put a duplicate flag on the command line. `StreamerServer.spawnFlagOverrides()` is the single place that resolves them, and all three spawn sites (start, resume, adopt) spread it — so `claudeFlags.model` wins over the `--default-model` CLI flag, and likewise for the other two.

Adding a flag id to that skip set without also reading it in `spawnFlagOverrides()` recreates the bug this arrangement fixed: the value round-trips through `GET`/`PUT /api/config/claude-flags` and persists to server.yaml while never reaching argv, so the API looks like it works and silently does nothing. `__tests__/session-settings.test.ts` locks the config → spawn path for all three.

**Server default** — `PUT /api/config/claude-flags` with `{"values":{"model":"opus","effort":"high"}}`. Applies to the next spawn; a live PTY keeps the argv it started with. `--default-model` / `--default-effort` remain the boot fallback beneath it.

**A live session** — `PATCH /api/sessions/:id/model` / `:id/effort`. There is no CLI or IPC channel for retargeting a running session, so these type Claude's interactive `/model <x>` / `/effort <y>` command into the PTY via `sendKeys` (both accept an argument and apply it without opening the picker — verified against Claude Code v2.1.220). Consequences worth knowing:

- The value is a **trust boundary**: it is written as raw bytes into a live terminal, so `MODEL_NAME_RE` and `isEffortLevel` reject anything containing `\r`/`\n`/whitespace rather than escaping it. An unvalidated `\r` would end the slash command and run the remainder as a second, caller-chosen command.
- Answers **202, not 200** — the TUI applies it on its next render, so there is nothing truthful to echo back. Confirm with `GET /api/sessions/:id`, which scrapes the applied value off the status line.
- Guarded: 409 `SESSION_BUSY` mid-turn (the composer isn't accepting a slash command, and `sendKeys` has no such check of its own), 409 `SESSION_IDLE` when the session is known but has no live PTY, 501 `UNSUPPORTED_PROVIDER` for Codex (`/effort` has no Codex equivalent).
- The `SESSION_IDLE` case is a **registry** lookup, not a status check: `putOnHold()` and `handleExit()` both delete the session from the runner's map, so a held session reads as *absent* there rather than as `status: "idle"`. Checking only the runner would 404 a session mobile can still see in its list.
- `sendKeys` flips `waiting_input → running` and broadcasts a `session_update`; the prompt marker returns the status on its own once Claude re-renders.

## Feature flags

Booleans that gate **streamer** behaviour we're not ready to make unconditional. Not to be confused with `claudeFlags`, which are CLI arguments handed to a spawned `claude` process. The registry lives in `src/feature-flags.ts`; each entry declares an `id`, a `description` shipped to clients, a `default`, and its env var.

Resolution is **boot-time only** — changing a flag needs a restart, same as `ptyGracePeriodMs`. Precedence, highest first:

1. `ServerConfig.codexSystemPromptEnabled` — legacy explicit override for that one flag; predates the registry and is kept so embedders/tests that set it directly keep working.
2. `THREADBASE_FEATURE_<ID>` env var. Highest of the real sources so an operator can flip a flag on a supervised instance (launchd/systemd/Task Scheduler) whose argv is fixed.
3. `--feature <id=bool>` on `serve`, repeatable. Strict: an unknown id or a non-boolean value stops the boot with a message.
4. `feature_flags: {"codexSystemPrompt":true}` in server.yaml — one line of JSON, same encoding as `claude_flags`. Unknown ids and non-boolean values are dropped with a warning (never coerced, never fatal): a hand-edited typo must cost the flag, not the boot.
5. The registry `default`.

`resolveFeatureFlags()` returns a **total** map — every registry id present, defaults filled — so callers index it without `?? default` and a newly-added flag can't reach a boolean branch as `undefined` on an older server.yaml.

`GET /api/config/feature-flags` returns `{ registry, values }`. It is **read-only** — there is no PUT, and the absence of a `persisted` field is the signal (contrast `/api/config/claude-flags`). `/api/config` is admin-scoped, so `GET /api/info` carries `featureFlags: true` to let a read-only client discover support without reading values.

Current flags:

| id | Default | Gates |
|----|---------|-------|
| `codexSystemPrompt` | off | Sending the built system prompt to fresh Codex sessions. Off because Codex has no `--system-prompt` flag — the prompt lands in the positional `[PROMPT]` argument, which Codex treats as the user's opening turn rather than a system instruction. |

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
