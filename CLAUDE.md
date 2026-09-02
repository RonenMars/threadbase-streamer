# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Optional AI-assistant tooling this repo declares (plugins, MCP servers, and how to install them for Claude Code or Codex): [docs/agents/tooling.md](docs/agents/tooling.md)

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

- `pty-manager.ts` — spawn/resume Claude sessions via node-pty, ring buffer output (64KB cap). Permission gates are detected at paint time from the rendered screen (`detectGateScreen`: gate footer + Yes/No options, throttled to one unsolicited scrape per 300ms) because Claude Code debounces its OSC 777 notify ~6s after painting the gate; the OSC remains the fallback trigger and the close signal. OSC regexes run against the previous chunk's tail + the current chunk, so an escape split across chunk boundaries still fires. Gate options are scraped from the last option block on screen, scanning bottom-up, not the whole window, since prose above the gate can contain a matching numbered list.
- `codex-pty-runner.ts` — same for Codex sessions. Blocking startup gates (directory trust, hooks review) become question cards over the `permission` WS transport; a "remember for all projects" answer persists to `~/.threadbase/gate-answers.json` (`services/questions/codexGateAnswers.ts`) and auto-answers future gates. Usage-limit / rate-limit screens (and the soft "usage limit reset available" tip after a failed submit) are detected the same way and surfaced as permission cards with `failureReason` on the session so mobile stops spinning in `running`. Readiness = `Ready` status-bar marker (quiet alone never settles boot — `Starting` / MCP boot lines keep the input queue armed). An 8s flat fallback settles only once the screen is idle (not busy, and compose `›`/`>` or Ready is visible; re-arms while MCP is still loading; covers a truncated Ready bar). Mid-session, `running → waiting_input` after Working then Ready; if Working never appears within 2s after submit (no Ready required), recovers as `submit-stale` so grace/hold is not stuck. Submit waits for PTY quiescence before `\r` (same redraw-race fix as Claude).
- `session-store.ts` — in-memory registry of managed (PTY) + discovered (process) sessions. All session state mutations go through it.
- `conversation-cache.ts` — SQLite cache of conversation metadata, message tails, projects, and cache_metadata; updated incrementally by `ConversationWatcher` (chokidar). Backs `/api/conversations`, `/api/sessions`, and `/project-chats`. Runs SQLite migrations on open (`db/sqlite-migrate.ts` + `db/migrations/*.sql`, tracked in `schema_migrations`).
- `services/conversations/conversationWatcher.ts` — chokidar-backed JSONL tail + directory watcher. Emits per-line events (cache + WS broadcast) and per-file dirty events (cache invalidation). **`watchDirectory()` costs one OS watch handle per file under the root, not one per directory** — chokidar recurses, and per-file `change` events are what `poke()`'s tail self-heal and the external-tail attach need. So the process holds roughly one open fd per conversation transcript on the box (measured 2026-08-09: 2131 fds against 2133 files, ~88% of all fds on the process). That is the design working, not a leak: it tracks the corpus on disk, not live sessions, and `unwatch()`/`close()` do release. macOS has room (2.0% of a 122 880 per-process ceiling); **Linux is the tight one**, since these are inotify watches against the per-user `max_user_watches` (as low as 8192, shared with every other watcher). Exhaustion arrives as ENOSPC on the watcher's `error` event, logged as `watcher.limit_exhausted`.
- `ws-hub.ts` — WebSocket hub broadcasting terminal_output, session_update, session_list; unicasts terminal_replay on subscribe and session_ready on PTY spawn
- `server.ts` — HTTP server lifecycle; wires `@hono/node-server` + `@hono/node-ws`, constructs `ApiDeps`, delegates request handling to the Hono app (`api/app.ts`)
- `api/routes/` — one file per endpoint group; each factory takes `ApiDeps` and returns a Hono sub-app. Handlers write directly to the Node `ServerResponse` via `c.env.outgoing` and return a sentinel `Response(null, { status: 597 })` (`ALREADY_HANDLED`) to skip Hono response piping. Because of that, `c.res.status` is the sentinel rather than the real status — anything reporting a status (the request log in `api/app.ts`) must read `c.env.outgoing.statusCode` instead, or it prints a code that does not exist.
- `logger.ts` — pino wrapper whose `dest` decides *where* a line goes, independently of level. The default is TTY-aware: `pino` under a supervisor (launchd/systemd/Task Scheduler/Docker, where fd 1 is a file or pipe) and `console` at a human terminal. It used to be `"both"`, which wrote every line twice and — since `console` has no level of its own — printed `debug` calls pino had already filtered, unbounded and unsuppressable. An explicit `dest` still overrides, which is what the CLI's user-facing output (banners, QR, `prod doctor`) passes and must keep passing. `lifecycle/log-cap.ts` caps the supervised logs at boot; both are covered in [docs/troubleshooting.md](docs/troubleshooting.md).
- `services/conversations/isAgentConversation.ts` — detects agent-authored JSONLs by `entrypoint` field (default `sdk-cli`, `claude-vscode`; interactive Claude Code emits `cli` and is never matched). The file probe is a chunked scan (64 KB chunks, 64-byte overlap) that early-exits at the first `"entrypoint":` occurrence — the value is per-conversation and authoritative, so large human JSONLs aren't read in full.
- `utils/canonicalizeProjectPath.ts` — the single source of truth for project-path identity; every consumer must canonicalize before dedupe.
- `utils/canonicalizeFilePath.ts` — the same discipline for **JSONL file paths**, plus the scanner/cache boundary helpers. Two path forms exist and are not interchangeable on Windows: **canonical** (forward slashes — every cache key: `conversation_meta.file_path`, `fileIndex`, watcher keys, `externalTails`) and **native** (what the scanner emits in `ConversationMeta.filePath`, and what chokidar delivers). Both writers of `conversation_meta.file_path` store canonical, so "cache keys are always canonical" is an invariant; the scanner has no such rule. **When the two meet: normalize for the comparison, emit in the consumer's form.** Use `canonicalLivePathSet()` and `joinStatCacheByNativePath()` rather than hand-rolling the conversion — a missed normalization fails *silently* (an empty map, a `false`, a fallback — never an exception) and is invisible on POSIX and therefore to CI, where both forms are identical.
- `db/runtime-store.ts` — `~/.threadbase/runtime.db`, the **authoritative** SQLite file, holding `managed_sessions` and `devices`. Deliberately a different file from `cache/cache.db` and deliberately not under `cache/`: everything in the cache is rebuildable from `~/.claude`/`~/.codex`, this is not. It must survive "delete the cache and restart" and the integrity monitor's reset-and-rescan, and its open is independent of the cache's — a `better-sqlite3` ABI mismatch used to null `ManagedSessionsRepository` and silently disable *all* session persistence while the server kept running. Own migrations dir (`db/runtime-migrations/*.sql`), own `schema_migrations` table. Opening it copies a pre-split `managed_sessions` and `devices` out of `cache.db` once, non-destructively.
  **`devices` moved here from `cache.db` (`migrations/011_create_devices.sql`).** It failed the same test `managed_sessions` fails: a device registry is rebuildable from nothing, so losing it invalidates every device token ever issued — yet it sat in the file `tb-streamer cache clear` deletes and the integrity monitor rebuilds. That is why the narrower per-device credential could not safely be adopted by a client while it lived there. The cache-side table is still created (for rollback and as the one-time copy source) but is no longer read or written after boot; add device columns to the runtime migration, never to `011`.
- `db/migrations.ts` + `db/pg-migrations/*.sql` — Postgres migration runner. Postgres is dormant (only `session_uploads` + reserved tables); SQLite is the primary persistence layer.
- `schemas/*.schema.ts` — zod validation at HTTP/scanner boundaries

## Query timing

Every SQLite statement is timed. `instrumentDatabase()` (`src/db/query-timing.ts`) wraps `db.prepare` at both `new Database()` sites — `ConversationCache.open` and `RuntimeStore.open` — so the ~90 statements prepared across the cache, the runtime store and the repositories that share those handles are all covered without touching a call site.
`better-sqlite3` is synchronous, so a call's wall time is its cost; measured overhead is +1% on an 8.9 µs call, which is why it is always on rather than behind a flag.

What gets logged, and why so little: the prod log was measured at 261 MB with no rotation, and a single conversation fetch runs dozens of statements.

- **`db.slow_query`** (warn) — a statement at or above `THREADBASE_DB_SLOW_QUERY_MS`. On by default.
- **`db.query`** (debug) — every statement. Off unless `LOG_LEVEL=debug`.
- Both are emitted with dest `"pino"` explicitly. That was written against the old `"both"` default, which also wrote the message through `console.*` so every line landed in the prod file twice; the default is now TTY-aware and already resolves to `"pino"` under a supervisor. The explicit `"pino"` is still correct — it also suppresses the console line at an interactive terminal, which is what these high-frequency lines want.
- Each line carries the statement's **name** (its key in the `stmts` object, applied by `labelStatements`; anything unnamed falls back to `verb:table`), the duration and the row count. Never the SQL text — too verbose — and never the bound parameters, which carry file paths and conversation ids.

**The 35 ms default is measured, not chosen.** Against the live 22 MB `cache.db` (583 conversations, 38 717 index rows), 3 600 read samples across the twelve statements the hot paths run gave p50 0.03 ms / p99 0.87 ms / max 1.83 ms, and 1 200 write samples gave p99 0.09 ms with rare WAL-checkpoint spikes to 4.37 ms. 35 ms is 8× the slowest healthy operation observed, so checkpoint spikes never page anyone, and it is more than the 34 ms *end-to-end* time of the fastest complete conversation fetch measured on this box — a query crossing it cost more on its own than an entire healthy request.
Re-measure before trusting the default on hardware unlike this one.

**Host saturation is the pathology this list was missing, and it is the one that actually occurred.**
On 2026-08-03 the `list` statement reported 104 slow lines at a 118.7 ms median — 136× the documented
p99 — with an index present and used, and `cache.db` at exactly the 22 MB the benchmark was taken at. The
same statement measured **p50 0.38 ms / p99 0.85 ms** against a copy of that cache on an idle machine.
The box was at load 14.7, saturated by tooling around the investigation rather than by the streamer,
which did not appear in the top twelve consumers. Because `better-sqlite3` is synchronous and this timer
measures wall time, a starved process makes every statement look pathological — a true statement about
cost, and not a statement about SQL. **Check the host before the query**: an index that the planner is
already using will not explain a 300× regression.

**At that threshold the warn line may never fire, and that is the intent.** 35 ms is roughly 40× the slowest query ever observed here (p99 0.87 ms, max 1.83 ms), so `db.slow_query` is a tripwire for pathology — a missing index, a lock, a cache grown far past today's 22 MB — not ongoing visibility into query cost. **Silence is not evidence that queries are fast.** It means nothing crossed 40× the observed maximum, which is also what a broken timer, a disabled threshold (`<= 0`) or a statement that throws before recording would look like. To actually see query cost, run with `LOG_LEVEL=debug` and read `db.query`, or lower the threshold for the duration of an investigation.

**Slow-query lines are not attributed to a request.** Doing that needs `AsyncLocalStorage` or a request id threaded through (`AppEnv.requestId` is declared but never set by anything today), and it would only cover the subset of queries that have a request at all — the watcher, the boot scan and the backfill run outside any. At a 35 ms threshold these lines are rare enough to correlate with the adjacent `http.request` line by timestamp; revisit if they ever stop being rare.

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
- **Codex resume is authoritative, not optimistic.** Codex enforces a single writer per rollout and only reports it after the process starts (`already has an active writer (code -32600)`), so a Codex resume/fork waits for a bounded ready-or-failed outcome (`CODEX_STARTUP_TIMEOUT_MS`, 4 s, env `THREADBASE_CODEX_STARTUP_TIMEOUT_MS`) before answering. A refusal — found either by the pre-spawn open-file probe (`services/sessions/codexRolloutOwner.ts`, bounded `lsof` on the exact rollout, POSIX only) or by the rendered error afterwards — is a `409` whose `code` stays `CONVERSATION_BUSY` with an additive `reasonCode: "CODEX_SESSION_ACTIVE"`. `force` does **not** bypass it: force only ever overrode our own heuristic. Recovery is `POST /api/sessions/:id/fork` (`codex fork`), which starts a second conversation and leaves the owner running. Contract: [docs/compatibility/codex-collision-and-fork.md](docs/compatibility/codex-collision-and-fork.md).
- An instant non-zero exit (<2 s, no output) gets a diagnosed `failureReason` (missing project dir, or Claude binary not found). It reaches the client on the settled session the status bus carries, and is mirrored into `SessionStore` so the session reports `lifecycle: "failed"` rather than "completed".
- **A missing provider CLI is refused before the spawn.** `LiveSessionManager` locates the binary first and answers 503 `PROVIDER_NOT_INSTALLED` (start, resume, adopt and fork all funnel through it). Without that pre-flight the spawn *succeeds* on POSIX — node-pty forks and `execvp` fails inside the child — so the session appears, exits ~12 ms later with code 1 and no output, and a Claude resume has already answered 200 by then. Availability is `locateExecutable()` (stat a resolved path, walk PATH for a bare name), **not** whether `resolveClaudeExe()` threw: it cannot throw, it falls back to the bare command name, and that fallback is load-bearing for a box with no `/usr/bin/which`. Gating on the throw is why `GET /api/providers` reported `available: true` and `GET /api/diagnostics` reported "CLI is installed" for a machine with no CLI at all.
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
| `THREADBASE_CODEX_STARTUP_TIMEOUT_MS` | Ms a Codex resume/fork waits for an authoritative ready-or-failed outcome before falling back to the async "spawned, still booting" answer. Default `4000`. |
| `THREADBASE_DB_SLOW_QUERY_MS` | Duration at or above which a SQLite statement is logged at warn as `db.slow_query`. Default `35` — measured, see [Query timing](#query-timing). `<= 0` disables slow-query logging. |
| `THREADBASE_FEATURE_*` | One var per feature flag (`THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT`, …). Highest-precedence source; yaml/`--feature` ids are the `FEATURE_FLAGS` keys (`ptyHost`), not these env names. See [Feature flags](#feature-flags). Truthy `1/true/yes/on`, falsy `0/false/no/off/""`; unset means "defer to the CLI flag, then server.yaml". |
| `THREADBASE_CONFIG_DIR` | Overrides the config directory (default `~/.threadbase`) that `server.yaml` — including the `api_key` — is read from and written to. Mainly a test hook: it lets `setApiKey`/`loadOrCreateApiKey` target a throwaway dir so `POST /api/auth/rotate` and `set-key` never clobber the real live config. Unset in production. |
| `THREADBASE_RUNTIME_DB` | Overrides the path of the session-registry database (default `runtime.db` inside the config dir). A test hook first: `__tests__/setup/isolate-runtime-db.ts` points every test file at a throwaway file so a suite run never writes sessions into the real `~/.threadbase/runtime.db`. It exists separately from `THREADBASE_CONFIG_DIR` because several auth tests sandbox the config dir by overriding `HOME`, and `THREADBASE_CONFIG_DIR` outranks `homedir()`. Unset in production. |
| `MULTI_AGENT_FLOW` | Routes `POST /api/sessions/start` + `/input` to the multi-agent path instead of PTY. `AGENT_*` tuning vars: see [docs/multi-agent-mode.md](docs/multi-agent-mode.md). |
| `THREADBASE_SKIP_PERMISSION_MODE_PROMPT` | Set to `true` to disable the `serve` first-run interactive permission-mode prompt (see below); falls straight through to `acceptEdits`. |
| `THREADBASE_SKIP_AUTO_RESUME_PROMPT` | Set to `true` to disable the `serve` first-run interactive auto-resume prompt (see [Auto-resume on boot](#auto-resume-on-boot)); resolves to `false` (no auto-resume). |
| `THREADBASE_ALLOW_BROWSER_CORS` | Enables browser CORS (off by default; no web page can make authenticated requests without it). Set to `1`/`true`/`yes`/`on` to allow the localhost dev origins, or to a comma-separated origin list (e.g. `https://app.example.com`) to allow those on top of the dev defaults. Overrides `browser_cors:` in server.yaml when set. Mobile is unaffected (no `Origin` header). |
| `APNS_KEY` | **Contents** of the APNs p8 signing key (PEM), not a path. Required for iOS Live Activity push but no longer sufficient on its own — the `liveActivityPush` feature flag must also be on. Either missing leaves the feature off with one info log and a normal boot. Never logged. See [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md). |
| `APNS_KEY_ID` | Key id of the p8 in `APNS_KEY`. Required when `APNS_KEY` is set; under launchd it is derived from the `AuthKey_<keyId>.p8` filename. |
| `APNS_TEAM_ID` | Apple Developer team id. Required when `APNS_KEY` is set; no default, so one deployment's Apple account is never baked into the source. |
| `APNS_BUNDLE_ID` | App bundle id; the APNs topic is this plus `.push-type.liveactivity`. Required when `APNS_KEY` is set. |
| `APNS_HOST` | APNs host. Defaults to sandbox (`api.sandbox.push.apple.com`) because the app's `aps-environment` is still `development`; set `api.push.apple.com` for production. |
| `THREADBASE_EXPO_ACCESS_TOKEN` | Expo access token for the "your turn" push relay. Only needed if the Expo project has enhanced security enabled; unset is the normal case and sends go unauthenticated. Never logged. See [Waiting-for-input push](#waiting-for-input-push). |

## Waiting-for-input push

The one notification the away-from-desk workflow depends on: the agent finished its turn and it is the user's move. `WaitingInputNotifier` + `ExpoPushSender` (`src/services/push/`) send it through Expo's relay with a plain `POST https://exp.host/--/api/v2/push/send` — **no Apple credential**, one code path for iOS and Android.

That transport choice is structural, not a preference. An APNs `.p8` signs only topics for bundle ids its developer team owns, so a self-hosted streamer can never push to the published app; Expo holds the app's APNs and FCM credentials, so any streamer can. Self-hosting is the primary deployment, which is why ordinary notifications go through Expo and only Live Activities go direct to APNs.

- **Trigger** — the same `onStatusChange` funnel Live Activities use, on the `running → waiting_input` edge of a turn the user opened (`waiting_input → running`). Boot/resume ready opens no turn and notifies nothing, and a second ready detector firing for one turn finds the turn already closed.
- **Suppressed while watched** — no push when a WebSocket client is subscribed to that session. Mobile subscribes while the session screen is open and the socket dies on backgrounding, so this is the "the user is already looking" signal.
- **Payload** — `title: projectName`, `body: "Waiting for your input"`, `data: { sessionId, serverId }` (mobile routes the tap from those two). Deliberately **no `lastOutput` and no `sessionName`**: raw terminal output and a prompt-derived title are exactly what the privacy policy says notifications exclude — see [docs/guides/waiting-input-push.md](docs/guides/waiting-input-push.md) before adding a field.
- **Dead tokens** — an Expo ticket of `DeviceNotRegistered` revokes the token, mirroring how `LiveActivitySender` expires a dead APNs one. Every other error only counts toward the failure streak. Tickets are per-token in one batched response, so one dead device never silences the rest.

## iOS Live Activity push

Gated by the `liveActivityPush` [feature flag](#feature-flags), **off by default** — `APNS_KEY` alone no longer brings this up, and a box with credentials configured logs `live_activity.disabled` at boot until the flag is set.

`APNS_KEY` enables direct-to-APNs Live Activity pushes (Lock Screen / Dynamic Island surfaces for running sessions). ActivityKit **cannot** go through Expo's relay — different token type, `.push-type.liveactivity` topic, p8 credential — so this path uses `node:http2` directly and never `expo-server-sdk`.

Three token kinds now arrive from one device and are not interchangeable: `expo` (relay, ordinary notifications), `liveactivity_start` (push-to-start, app-wide), `liveactivity_update` (per-activity, short-lived). `PushRepository.listDeliverable()` is Expo-only — that query is what keeps the ordinary notification fan-out from handing an ActivityKit token to Expo.

The content-state shape is a **contract shared with tb-mobile** (decoded by a Swift `Codable` struct). An ActivityKit decode failure is silent — the surface just stops updating — so changing a field name or type requires a coordinated tb-mobile change. `startedAt` is epoch **milliseconds** and iOS renders its own ticking timer from it: never send a computed elapsed value, and carry the original value through a renewal or the user's timer visibly resets to zero.

`LiveActivityNotifier` is **per-turn, not per-session**: a push fires on the `waiting_input → running` edge (turn starts) and the matching `running → waiting_input` edge (turn — including sub-agents — ends), not on every status transition. A fresh session's first `running` has no prior `waiting_input`, so booting/idling never opens an activity. `sessionName` (derived from the first user message, `src/utils/deriveSessionName.ts`) is included in content-state and mobile should fall back to `projectName` when it's unset.

Capability is reported to clients on `GET /api/info` and `GET /api/push/health` as an additive `push` object (`liveActivity`, `notifications`, `liveActivityReason`), built by `describePushCapability()` in `src/api/routes/misc.routes.ts`. `liveActivity` comes from the server's own wiring state (`liveActivityNotifier !== null`) rather than a re-read of the environment, because credentials alone do not enable it — the sender is only built when the push token store opened too. `available` on `/api/push/health` deliberately still means "the token store opened", not "credentials are present": released mobile builds render it verbatim as "Push store is available / unavailable (registration cannot persist)", so retargeting it would make every credential-less server tell users their registrations do not persist.

Full contract, env vars, failure handling: [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md).

## Multi-agent mode

When `MULTI_AGENT_FLOW=true`, session start/input route through a Temporal-orchestrated pipeline; PTY mode is unreachable. Endpoints return structured errors `{error, code}` (codes in `src/agent/errors.ts`); mobile-relevant: **429 `SESSION_BUSY`** (carries `retryAfterMs`) and **413 `SESSION_HISTORY_FULL`** (prompt "start a new conversation"). Full endpoint contract, env vars, and dev setup: [docs/multi-agent-mode.md](docs/multi-agent-mode.md); design rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`, `default_permission_mode`, `browser_cors`, `pty_grace_period_ms`, `claude_flags`, `claude_extra_args`, `feature_flags`) from it, but most runtime knobs come exclusively from CLI flags.

The file is parsed by **single-line regex, not a YAML library** — every value must stay on one line. `claude_flags:` and `feature_flags:` therefore store one line of JSON (`{"permissionMode":"bypassPermissions"}`, `{"ptyHost":true}`), which keeps colons/quotes/spaces escaped for free; a corrupt line is logged and ignored rather than failing the boot. `feature_flags:` keys are the `FEATURE_FLAGS` object keys, not env names. Setting `port:` in `server.yaml` does nothing — the listening port comes only from `--port` (CLI default `8766`). Any service definition (launchd plist, systemd unit, Task Scheduler action) **must** pass `--port <n>` explicitly — the deploy scripts already do.

`--default-permission-mode <mode>` (or `default_permission_mode:` in `server.yaml`) controls the Claude Code `--permission-mode` used to spawn every PTY session. All six CLI values are accepted: `acceptEdits` (default — auto-approves file edits, still prompts for shell commands), `manual`, `auto`, `plan`, `bypassPermissions`, `dontAsk`.

`bypassPermissions`/`dontAsk` disable the confirmation prompts entirely. They would normally hit a blocking "Bypass Permissions mode" warning menu at boot (`1. No, exit` / `2. Yes, I accept`) that strands the PTY and leaves mobile on an empty screen; `buildSettingsJson()` in `src/claude-flags.ts` suppresses it by adding `skipDangerousModePermissionPrompt` to the `--settings` blob for exactly those modes (probe-verified against Claude Code v2.1.218). The streamer never passes `--dangerously-skip-permissions` — bypass is always requested via `--permission-mode`.

**Security.** Enabling a bypass mode turns every future session on this machine into unattended arbitrary code execution: a leaked API key no longer stops at a human-in-the-loop confirmation. `--add-dir` compounds it by widening the filesystem scope beyond the project. `PUT /api/config/claude-flags` is therefore refused (403) while `--local-no-auth` is active, and every flag change is logged at info level with old→new values.

**There is no spend cap.** `--max-budget-usd` was previously offered here as a runaway bound; it is `(only works with --print)` per `claude --help`, and this server never passes `--print`, so it was a silent no-op — it has been removed from the registry (along with `--fallback-model`, inert for the same reason). Nothing bounds the cost of a bypass-mode session today. Treat the auth boundary and the permission mode as the only real controls, and check any flag you add for a `--print`-only note before trusting it.

If none of the flag/env/yaml sources set a mode, `serve` shows a one-time interactive prompt (`src/lifecycle/prompt.ts`'s `interactivePermissionModePrompt`) and persists the answer to `server.yaml` via `setDefaultPermissionMode()` — but only for a human dev invocation on a real TTY (never under `--prod`/launchd, which must never block on stdin). Set `THREADBASE_SKIP_PERMISSION_MODE_PROMPT=true` to skip it and fall through to `acceptEdits`.

## Auto-resume on boot

`auto_resume_on_boot:` in `server.yaml` decides whether sessions a previous run was interrupted mid-flight are **re-started automatically at boot**, or listed for the user to tap. Default `false`. It is the only setting that lets the streamer start an agent nobody asked for in that moment — combined with a bypass permission mode, that is unattended arbitrary code execution — so it is never enabled implicitly.

**The loader is tri-state and that is load-bearing.** `loadAutoResumeOnBoot()` returns `true` / `false` / `undefined`, where `undefined` means the key is *absent* — the user has never been asked — which is what triggers the one-time prompt. A recorded `false` is a real answer and is never re-asked. A malformed value (`yes`, `1`, `TRUE`) reads as `undefined` rather than being coerced, so a typo costs a re-prompt instead of silently enabling unattended starts.

**It is not a feature flag.** Feature flags gate behaviour *we* are unsure about; this is a user preference with a persisted answer, which is the `default_permission_mode` shape.

Where the question is asked, and why not the installer: `npm install -g` has no reliable TTY (`postinstall` output is often hidden or discarded) and Homebrew formulae must be non-interactive by policy. So the prompt lives on the **first interactive `serve`**, beside `interactivePermissionModePrompt` — a path all three install methods reach. `scripts/deploy.sh` additionally asks at install time (`cmd_ask_auto_resume`), since it can, writing the answer before first boot so `serve` finds the key present and stays silent.

All three clauses must hold for `serve` to ask: the key is absent, `THREADBASE_SKIP_AUTO_RESUME_PROMPT !== "true"`, and it is a human TTY invocation (never `--prod`/launchd). Non-TTY, skipped, declined, or any failure all resolve to `false` — there is no path where silence enables it. **Both** answers are persisted, which is what makes the prompt self-terminating: asked at most once per machine.

A `--prod`-only machine never sees a TTY, so the key would stay absent forever and the operator would have no way to learn the setting exists. One boot-time info line covers that, emitted only when the key is absent *and* the prompt did not run.

The `sessionRehydration` feature flag only controls whether historical stubs appear in the session list; turning it off does not disable `auto_resume_on_boot`.
Set `auto_resume_on_boot: false` to prevent unattended agent starts at boot.

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

Booleans that gate **streamer** behaviour we're not ready to make unconditional. Not to be confused with `claudeFlags`, which are CLI arguments handed to a spawned `claude` process. The registry lives in `src/feature-flags.ts` as the `FEATURE_FLAGS` object, keyed by flag name. Each value has a `description` shipped to clients, a `default`, and an `env` var. The yaml / `--feature` id **is that object key** (`ptyHost`), not the env name (`THREADBASE_FEATURE_PTY_HOST`). Snake_case and env names in `feature_flags:` are dropped as unknown.

Resolution is **boot-time only** — changing a flag needs a restart, same as `ptyGracePeriodMs`. Precedence, highest first:

1. `ServerConfig.codexSystemPromptEnabled` — legacy explicit override for that one flag; predates the registry and is kept so embedders/tests that set it directly keep working.
2. `THREADBASE_FEATURE_<ID>` env var. Highest of the real sources so an operator can flip a flag on a supervised instance (launchd/systemd/Task Scheduler) whose argv is fixed.
3. `--feature <id=bool>` on `serve`, repeatable. Strict: an unknown id or a non-boolean value stops the boot with a message listing the `FEATURE_FLAGS` keys.
4. `feature_flags: {"ptyHost":true}` in server.yaml — one line of JSON, same encoding as `claude_flags`, keys matching `FEATURE_FLAGS`. Unknown ids and non-boolean values are dropped with a warning (never coerced, never fatal): a hand-edited typo must cost the flag, not the boot.
5. The registry `default`.

`resolveFeatureFlags()` returns `{ values, sources }`, both **total** — every registry id present, defaults filled — so callers index them without `?? default` and a newly-added flag can't reach a boolean branch as `undefined` on an older server.yaml.

`sources[id]` names the rung that decided each flag (`"override" | "env" | "cli" | "yaml" | "default"`). It exists because the resolved boolean alone cannot answer "why is this on?", which is the only question anyone asks of a surprising flag. The legacy `codexSystemPromptEnabled` override is a real rung inside the resolver rather than a mutation applied to the finished map afterwards — the old shape meant the resolver was not actually the single source of truth, and an override was invisible to any reporting.

**Flag ids are `keyof typeof FEATURE_FLAGS`.** `FEATURE_FLAGS.ptyHsot` and `flags.ptyHsot` are compile errors rather than `undefined` read as falsy — a typo in a consumer used to silently disable the feature it was meant to gate. `FeatureFlagValues` (what a config source supplies) is deliberately **partial**; `ResolvedFeatureFlags` (what the resolver returns) is total. `findFeatureFlag()` is only for untrusted yaml/CLI strings; in-process code uses `FEATURE_FLAGS.ptyHost` or `getFeatureFlag("ptyHost")`.

Operator-facing id/env split: [docs/guides/feature-flags.md](docs/guides/feature-flags.md).

**Boot log.** Every flag, every boot, as `id=value(source)` under `event: "config.feature_flags"`. It previously printed only the ids differing from their defaults under the heading "Feature flags active" — which stated the opposite of the truth for a flag defaulting ON (disabling `sessionRehydration` listed it as *active*), and went silent on a stock boot, so the log could never say what a process was actually running with.

**A flag that gates nothing is caught by a test.** `__tests__/feature-flags.test.ts` scans `src/` and `cli/` for each registry id and fails if one appears nowhere. Without it a flag can be declared, validated, persisted to server.yaml and served over HTTP while affecting nothing — every layer reporting success. That exact bug shipped once in `claude-flags` (see [Model & effort](#model--effort)).

For the launchd/Task-Scheduler-supervised prod instance (whose plist/task args are fixed and never pass `--feature`), set `THREADBASE_FEATURE_<ID>` in the plist's `EnvironmentVariables` block or `feature_flags:` in `server.yaml`, then run `tb-streamer prod restart`; the `--feature <id=bool>` flag is the path for ad-hoc `serve` runs.

`GET /api/config/feature-flags` returns `{ registry, values, sources }`. It is **read-only** — there is no PUT, and the absence of a `persisted` field is the signal (contrast `/api/config/claude-flags`). `sources` is additive (older clients ignore it) and exists so "why is this flag on?" is answerable over HTTP instead of needing shell access to read the environment, the argv and server.yaml by hand. `/api/config` is admin-scoped, so `GET /api/info` carries `featureFlags: true` to let a read-only client discover support without reading values.

Current flags:

| id | Default | Gates |
|----|---------|-------|
| `codexSystemPrompt` | off | Sending the built system prompt to fresh Codex sessions. Off because Codex has no `--system-prompt` flag — the prompt lands in the positional `[PROMPT]` argument, which Codex treats as the user's opening turn rather than a system instruction. |
| `sessionRehydration` | **on** | Seeding the session list at boot from the durable registry, so sessions a previous run was interrupted mid-flight come back in `GET /api/sessions` as `ownership: "historical"` / `lifecycle: "resumable"` stubs instead of vanishing. On because it is the fix for the restart case, not an experiment — but it changes what `GET /api/sessions` contains for every client, so it ships with a kill switch rather than unconditionally. `GET /api/sessions/count` is unaffected: recovered stubs are filtered out of it. Turning this flag off does not disable `auto_resume_on_boot`; only `auto_resume_on_boot: false` prevents unattended starts. |
| `liveActivityPush` | off | Live Activity surfaces for running sessions, **both halves**. The streamer half gates `initLiveActivityPush()`, so an `APNS_KEY` that is present but unwanted is ignored rather than honoured — the boot log says so at `live_activity.disabled` instead of going quiet. tb-mobile reads this flag over `GET /api/config/feature-flags` and skips its own local ActivityKit path (and the Android ongoing-notification equivalent) when it is off, which is the point: the client half alone draws a Lock Screen card that only updates while the app is foregrounded, then freezes on backgrounding and expires silently after ~8h. A server too old to serve the endpoint reads as off — it is also too old to have been asked. Turn it on only where a push-to-start token is actually registered. |
| `e2ee` | off | Application-layer encryption between a paired device and this server, independent of TLS, so a tunnel or a LAN observer on the path carries ciphertext. **The handshake it gates now exists**: pairing (`POST /api/pair/exchange`), the transport handshake (`POST /api/e2ee/open`), the sealed WebSocket record layer and the sealed REST envelope all shipped across v1.71.0–v1.73.0. `supported` in `GET /api/info` stays a build constant, deliberately not the flag: it means "this build speaks the envelope", so reporting the flag would let an operator who switches it on advertise a handshake this build cannot perform. A client reads `enabled`, never `supported` alone; absent means an older server and resolves to today's plaintext path. Off by default and negotiated per device forever — tb-mobile is released and cannot be force-updated, so a server that demanded encryption would break every older install the day its streamer updated. A device that has completed a handshake is pinned (`e2ee_required`) and is refused in the clear with `426` thereafter; `--no-e2ee` turns encryption off for one run without un-pinning anyone. Design: [specs/end-to-end-encryption/design.md](specs/end-to-end-encryption/design.md) §6; nonce and context rules: `NONCE-DESIGN.md`. |
| `accessProbe` | **on** | One HTTP request at boot, when `e2ee` is on and a public URL is set, asking that public URL what an unauthenticated device would get. If a Cloudflare Access login answers, it warns (`access.gate_detected`, console **and** JSON) and names the remedies. On by default because the failure is otherwise silent: a sealed request carries no `Authorization` header, so an interactive Access application refuses it at the edge and the device blames the server for a handshake the server never saw. Never blocks the boot, never retries, silent when the URL is merely unreachable. Optional `access_service_token:` in server.yaml makes it also report whether that token satisfies the gate. See [docs/guides/feature-flags.md](docs/guides/feature-flags.md). |
| `ptyHost` | off | Keeping live PTYs in a separate host process so a streamer restart can reconnect without restarting the agents. Startup replaces a host with an incompatible protocol, heartbeats keep the streamer lease current, and an empty host exits after its known-empty registry state and all leases expire. `tb-streamer prod doctor` reports host liveness, protocol version, and session count when the flag is enabled. Host-surviving sessions remain attached and replay from the preserved terminal screen; after a machine reboot the host is gone too, so registry rehydration remains the fallback. Windows smoke has observed a detached host preserving real ConPTY output after its launcher exits and reconnecting over a named pipe. The flag remains off by default because a real Claude or Codex `tb-streamer prod restart` through Task Scheduler is not exercised yet. |

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
- `npm run build` copies `src/db/migrations/` (SQLite cache), `src/db/runtime-migrations/` (SQLite session registry) and `src/db/pg-migrations/` (Postgres) into `dist/`. Deploy ships the first two unconditionally and `pg-migrations/` only when it exists (`scripts/deploy.sh`) — both SQLite folders are required at runtime, and a missing `runtime-migrations/` disables session persistence silently while the server keeps serving. Details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

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

**Setting up a Windows dev/deploy machine from scratch (or troubleshooting a broken one)? Start with [docs/guides/windows-setup.md](docs/guides/windows-setup.md).** It covers, in order: the Node-version pitfall, the `npm install` native-module fork-in-the-road (VS Build Tools vs. `--ignore-scripts`), the nested `@threadbase-sh/scanner` `better-sqlite3` gap, why a worktree's `.git` file breaks if copied/synced to another machine, and `deploy.ps1` usage — each with a link to the matching `docs/troubleshooting.md` entry.

- **`npm install` before first deploy** — fresh clones fail lint/build with "Cannot find module" otherwise; `prepare` patches `qrcode-terminal` (dev/source installs only) and `postinstall` fixes node-pty prebuild permissions (all installs).
- **Path separators**: use `path.sep` (not `"/"`) for prefix guards on `path.resolve()` output.
- **File timestamps**: `birthtimeMs` is unaffected by `fs.utimes()`; use `mtimeMs` for cross-platform test assertions.
- **Task Scheduler log redirection**: no native stdout/stderr redirection, and the action runs `wscript.exe` → `launch.vbs` (hidden window), so the redirection lives inside `launch.cmd` as cmd `>>`/`2>>` into `~/.threadbase/logs/{stdout,stderr}.log`. Those targets and `Supervisor.getLogPaths()` both come from `logPaths()` in `src/lifecycle/constants.ts` — a launcher written without the redirection sends every line to a hidden console nothing captures, which is what made `prod logs` unwireable. `Repair-LaunchCmd` in `scripts/deploy.ps1` rewrites any `launch.cmd` lacking `>>`.
- **Task Scheduler env vars**: `[Environment]::SetEnvironmentVariable(..., 'User')` doesn't update the live session; read back from registry and inline the value in the task command string (applies to `THREADBASE_DATABASE_URL`, `THREADBASE_INSTANCE_ID`).
- **Stale port 8766**: kill any node process already bound to 8766 before starting the task — the new task fails silently if the port is taken.
- **Submodule SSH → HTTPS**: machines without SSH keys fail `git submodule update --init`. Fix once: `git config --global url."https://github.com/".insteadOf "git@github.com:"`.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.) and branch names (`feat/`, `fix/`, `chore/`)
- Every new feature must have tests in `__tests__/`
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`
- **Docs-only changes get `[skip-ci]` appended to the commit/PR title** — e.g. `docs(troubleshooting): record the menubar EPERM fix [skip-ci]`. Documentation cannot break the build, so the full matrix (Gate, Setup, Lint, Build, Test ×3, both Smoke jobs) buys nothing and just queues real PRs behind it. Put the suffix in the title, not the body. This is safe with required status checks because `ci.yml`'s smoke job deliberately has **no job-level `if:`** — under `[skip-ci]` it still runs, skips its steps, and reports **success** rather than "skipped", and a *skipped* required check would leave the PR permanently unmergeable. Applies only when the change touches nothing but docs; docs plus code, workflow YAML, fixtures, schemas or migrations all still need the matrix.

## Issue tracker

**Format and labels: [threadbase/docs/issue-tracker.md](https://github.com/RonenMars/threadbase/blob/main/docs/issue-tracker.md).** That file lives in the `threadbase` umbrella repo and is canonical for **every** component repo — never keep a local copy of these rules, invent a variant, or add a label to only one side.

Read it before filing, labelling, or re-prioritising anything. The shape:

- Title is `P<N>: <what is wrong or what should exist>`, and the prefix must match the priority label — they are two representations of one fact, so re-prioritising means editing both.
- Exactly one priority (`P0`–`P3`), exactly one type (`bug`, `enhancement`, `documentation`, `question`, `tech-debt`), any number of areas (`ci`, `e2e`, `performance`, `security`, `observability`, `platform`, `native`, `provider`, `ux`).
- A `## Verified state` section citing a `file.ts:123`, a PR number, or a quoted log line, with the date it was checked. An assertion with no evidence costs the next reader a re-investigation.

**GitHub is the worklist for open work; the docs are not.** `docs/BACKLOG.md` and `docs/ROADMAP.md` carry diagnosis and plans, never status. Duplicating an item's status into a doc is exactly what produced the drift catalogued in [docs/2026-08-10-open-items-register.md](docs/2026-08-10-open-items-register.md), where eight merged PRs still read as "🔄 In flight".

Cross-repo work is filed in **both** repos, each describing its own half, linked by URL — never one issue spanning both, or one side tracks work it cannot close.

The conventions file carries three `gh` queries that verify compliance; both repos return empty on all three.

## Merging PRs — Rebase + Squash, Linear History

Keep `main` a straight line — one commit per PR, no merge commits. Every PR follows the same two operations, in this order:

1. **Rebase onto latest `main`** to sync before merging. `git fetch origin && git rebase origin/main`, resolve conflicts preserving the PR's intent, then `git push --force-with-lease` (never plain `--force`, never force-push `main`). This guarantees no merge commit sneaks in.
2. **Squash-merge** the rebased PR: `gh pr merge <N> --squash --delete-branch`. The squash title must be conventional-commit compliant and carry no AI attribution.

Rules:

- **One PR at a time.** Never sync/merge PRs in parallel — rebase one, wait for its CI to go green, squash-merge it, then move to the next. A just-merged PR advances `main`, so the next PR is usually behind and must be rebased again.
- **Dependency order first.** If PR B is stacked on PR A (GitHub shows A's branch as B's base), merge A before B and rebase B onto the updated `main` afterward.
- **CI gate.** Only squash-merge when required checks are green. If CI is red on a flaky/infra failure, re-run it **once**; if the re-run still fails, stop and report — do not merge red.
- **Stuck cap.** If any single step hangs for more than ~3–4 minutes (CI not progressing, a rebase that won't resolve cleanly), stop and report rather than waiting indefinitely.
- **Wait for the release commit before the final rebase.** semantic-release pushes `chore(release): x.y.z [skip ci]` to `main` one to three minutes after every squash-merge, and branch protection requires an up-to-date branch — so a PR rebased the moment the previous one merges goes `BEHIND` again and burns a second CI cycle. Poll `origin/main` until the release commit is there, then rebase → CI → merge.
- **Check `MERGED` before any branch delete.** GitHub auto-deletes head branches on merge, so `--delete-branch` and `git push origin --delete` report an error afterwards; that is harmless. What is not harmless is chaining a delete after a *refused* `gh pr merge`: deleting the head branch closes the still-open PR. Gate cleanup on `gh pr view <N> --json state` returning `MERGED`. Recovery if it happens: re-push the branch from the worktree, `gh pr reopen <N>`, rebase, CI, merge.
- **Pushes can rewrite SHAs.** `core.hooksPath=scripts/git-hooks` rebases the branch onto `origin/main` on push, so the commits you just pushed may come back with different SHAs. Verify content with `git diff <base> <head> | git patch-id --stable`, not by SHA. A branch stacked on another PR needs `git rebase --onto origin/main <old-base-sha>` once that base has squash-merged; a plain rebase may not drop the stale base commit.

## Testing

Tests mock `node-pty` and shell commands. Integration tests spin up the HTTP server on random ports. Run the full verification before committing: `npm run lint && npm test`

Use the Node version in `.nvmrc` for local verification, especially for tests or code paths that load `better-sqlite3`. Running under a newer Homebrew/global Node can pick up native modules compiled for a different `NODE_MODULE_VERSION`, causing ABI errors or failed rebuilds unrelated to the product change.

## Backward compatibility with tb-mobile

**Compatibility is advisory, not a gate.** [docs/compatibility/tb-mobile.md](docs/compatibility/tb-mobile.md) maps the paths, fields and events mobile touches, but it is a reference for orientation, not a gate — it is hand-maintained and rots between updates, which is what used to turn every wire change into a negotiation. Nothing in this section blocks a change: it decides what you *report*.

**The client source is the compatibility doc.** It cannot go stale, and it answers the only question that matters — does anything actually use this? When a change renames or removes something on the wire, grep the checkout next door:

```bash
rg -n "<identifier>" ../tb-mobile/{services,hooks,stores,components,types}
```

Report what you find — file and line, and whether the call site is in a shipped build or only on `main` — and then carry on. A hit is information for the user to act on, never a reason to revise or abandon the change.

**Tier the check by what the change does**, so the common case costs nothing:

- **Additive** (new optional field, new endpoint, new event type) — no check. Mobile ignores what it doesn't know.
- **Rename, removal, or a changed status/event vocabulary** — grep, report, proceed.

**What a grep cannot tell you.** These are contractual because builds are already on users' devices, not because a file says so:

- Released builds cannot be force-updated. A user on an old app meets whatever the server does today.
- Auth: `Authorization: Bearer <token>` and `/ws?key=<token>` are both live paths, and the `tb_<32-hex-chars>` key format is load-bearing in pairing.
- Statuses mobile switches on: `running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle` (alias of `on_hold`). The server emits `running`/`waiting_input`/`idle` for live sessions and `on_hold` for resumable conversations; `completed`/`failed` are legacy values older streamers emitted — don't reuse them with new semantics.

The durable half of this lives in tb-mobile, not here: the client parses defensively and degrades rather than throwing, so a server that moved ahead costs a degraded screen instead of a crash. See the "Server contract — degrade, don't break" section in tb-mobile's `CLAUDE.md`.

## Menubar app (vendor/menubar)

`vendor/menubar` is a git submodule (`RonenMars/threadbase-menubar`) — an Electron tray app that polls `GET /healthz` every 5s. Don't break without coordinating a menubar update: the `port:` field in `server.yaml` (its port resolution: `THREADBASE_PORT` env → `port:` → fallback `8766`), the `/healthz` `{ ok, version }` shape, or the default port. Submodule bumps use a `chore: bump vendor/menubar (<reason>)` commit. Deploy no longer installs the menubar — `npm run deploy` / `scripts/deploy.sh` touch only the streamer; the menubar is installed separately via the `deploy-menubar` skill (`.claude/skills/deploy-menubar`). Flow details: [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

- **`git pull` does NOT update the submodule checkout.** Pulling a commit that bumps the `vendor/menubar` pointer only updates the *recorded* SHA in the parent repo's tree — the actual files on disk under `vendor/menubar` stay at the old commit until you run `git submodule update --init --recursive vendor/menubar` (`git submodule status vendor/menubar` shows a leading `+` when the two disagree). The `deploy-menubar` skill builds from the *checked-out* submodule SHA, not the parent repo's recorded pointer — so after a `git pull` that bumps the submodule, a menubar deploy can silently rebuild the old version until the submodule is explicitly updated.
- **Avoid a dirty `vendor/menubar` checkout.** Running `npm install` inside `vendor/menubar` (e.g. via the `deploy-menubar` skill's dependency-install step) can rewrite `vendor/menubar/package-lock.json` with metadata-only npm normalization (e.g. an added `"license"` field), which marks the submodule pointer `<sha>-dirty` in the parent repo even though no real dependency changed. Only run `npm install` there if `package.json` actually changed. If it happens anyway, `cd vendor/menubar && git checkout -- package-lock.json` clears it.

## Contributing to docs

If you hit an undocumented issue during setup, deploy, or runtime — ask the user: "This doesn't seem to be covered in `docs/troubleshooting.md`. Would you like me to add it?" Then add a section following the existing format (symptom → cause → fix) and commit it alongside any code fix.

## Release notes

Milestone-level release notes live in `docs/release-notes/YYYY-MM-DD-<milestone>.md` — the human story of what shipped; separate from `CHANGELOG.md`, which semantic-release auto-generates (never edit it by hand). When a milestone is ready to merge, add the `milestone` label to the merge PR and write the release notes manually using `docs/release-notes/_template.md` as the skeleton.
