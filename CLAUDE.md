# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Optional AI-assistant tooling this repo declares (plugins, MCP servers, and how to install them for Claude Code or Codex): [docs/agents/tooling.md](docs/agents/tooling.md)

Known deploy/runtime issues and their fixes: [docs/troubleshooting.md](docs/troubleshooting.md)

## Project

`@threadbase-sh/streamer` — PTY session management, WebSocket streaming, and REST API server for Claude Code conversations. TypeScript library + CLI that manages live Claude sessions via `node-pty`, broadcasts terminal output over WebSocket, and serves a REST API.

## Commands

Standard scripts (`test`, `lint`, `format`, `check`, `build`) are in `package.json`. Non-obvious ones:
- `npm run migrate` — apply SQLite schema migrations against `~/.threadbase/cache/cache.db` (override with `--db <path>`). Idempotent.
- `npm run migrate:projects` — backfill the `projects` table + `conversation_meta.project_id` from cached conversations. Idempotent.
- `npm run db:validate` — report missing/duplicate/orphaned `project_id` data; exits non-zero on any issue.

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/api/ + src/index.ts exports) → **CLI wrapper** (cli/).

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
- **The transcript watchers race human think time, not the spawn.** Neither provider creates its transcript at spawn: Claude writes `<sessionId>.jsonl` on the user's first turn, and Codex creates `rollout-<ts>-<uuid>.jsonl` on the first turn too — the *filename* encodes session creation, which is what made it look otherwise (verified on Codex CLI 0.147.0: filename and `session_meta.payload.timestamp` read 08:05:49 while line 0's envelope `timestamp` reads the first input at 08:07:15). `TRANSCRIPT_WATCH_DEADLINE_MS` (120 000, code not config) therefore bounds the *wait*, not the *acceptance*: `watchForJsonl` is `fs.watch`-driven and wires the file whenever it arrives, while `watchForCodexRollout` polls at 250 ms and re-arms its deadline on each `promptCount` increase, so an abandoned session still stops polling 120 s after the spawn. A watcher that does give up now logs `session.transcript_watch_expired` — both paths were silent, which is why a missed binding could only be found by log archaeology (gaps from `pty.ready` to the first prompt ran 3.6 s–405.7 s in production). Missing the binding is recoverable for Claude — `locateJsonlPath` rung 4 reconstructs `<uuid>.jsonl` — and **not** for Codex, where no rung can rebuild a rollout path from a placeholder id and the session also loses resume, fork and rehydration.
- **Resume is collision-checked.** `POST /api/sessions/resume` runs a pre-flight busy probe (`services/sessions/conversationBusy.ts`) and answers 409 `CONVERSATION_BUSY` when the conversation looks actively owned elsewhere — JSONL mtime within `RESUME_BUSY_WINDOW_MS` (120 000, override with `THREADBASE_RESUME_BUSY_WINDOW_MS`), a discovered process resuming the same id, or (POSIX only) a discovered process in the same project dir. `{ force: true }` in the body always proceeds. It is a one-directional pre-flight guard: nothing stops an external terminal attaching after the streamer holds the PTY.
- **Codex resume is authoritative, not optimistic.** Codex enforces a single writer per rollout and only reports it after the process starts (`already has an active writer (code -32600)`), so a Codex resume/fork waits for a bounded ready-or-failed outcome (`CODEX_STARTUP_TIMEOUT_MS`, 4 s, env `THREADBASE_CODEX_STARTUP_TIMEOUT_MS`) before answering. A refusal — found either by the pre-spawn open-file probe (`services/sessions/codexRolloutOwner.ts`, bounded `lsof` on the exact rollout, POSIX only) or by the rendered error afterwards — is a `409` whose `code` stays `CONVERSATION_BUSY` with an additive `reasonCode: "CODEX_SESSION_ACTIVE"`. `force` does **not** bypass it: force only ever overrode our own heuristic. Recovery is `POST /api/sessions/:id/fork` (`codex fork`), which starts a second conversation and leaves the owner running. Contract: [docs/compatibility/codex-collision-and-fork.md](docs/compatibility/codex-collision-and-fork.md).
- An instant non-zero exit (<2 s, no output) gets a diagnosed `failureReason` (missing project dir, or Claude binary not found). It reaches the client on the settled session the status bus carries, and is mirrored into `SessionStore` so the session reports `lifecycle: "failed"` rather than "completed".
- **A missing provider CLI is refused before the spawn.** `LiveSessionManager` locates the binary first and answers 503 `PROVIDER_NOT_INSTALLED` (start, resume, adopt and fork all funnel through it). Without that pre-flight the spawn *succeeds* on POSIX — node-pty forks and `execvp` fails inside the child — so the session appears, exits ~12 ms later with code 1 and no output, and a Claude resume has already answered 200 by then. Availability is `locateExecutable()` (stat a resolved path, walk PATH for a bare name), **not** whether `resolveClaudeExe()` threw: it cannot throw, it falls back to the bare command name, and that fallback is load-bearing for a box with no `/usr/bin/which`. Gating on the throw is why `GET /api/providers` reported `available: true` and `GET /api/diagnostics` reported "CLI is installed" for a machine with no CLI at all.
- **Mobile mapping**: historical conversations are returned as resumable shapes with `status: "on_hold"` (`conversationToResumableSession` in `server.ts`); mobile treats `idle` and `on_hold` as the same.
- **A session with no transcript is empty, not missing.** Claude writes `<sessionId>.jsonl` only on the first user turn (measured 0.0 s–86.9 s after `pty.ready`, and never at all if the user opens a session and walks away), so `GET /api/conversations/:id` answers **200 with zero messages** whenever `SessionStore` holds the id and its `promptCount` is 0. It used to 404, which was 62% of every conversation 404 in a three-week production log and is what rendered "Messages failed to load" on a session that was working fine. The guard stays narrow deliberately: a session that *has* sent prompts and still has no transcript is real data loss and still 404s.
- **The conversation 404 self-heal fires only on proof.** `handleGetConversation` used to call `cache.invalidate(id)` on every miss. For a Codex rollout the cache row is the only rung of `locateJsonlPath` that can name the file — `findJsonlPath` reconstructs Claude's `<uuid>.jsonl` layout and cannot match `rollout-<ts>-<uuid>.jsonl` by construction — so one transient miss deleted the row and every later request 404'd on a conversation still on disk, taking `/api/sessions/:id` (whose only fallback is that same row) with it. It now invalidates only when the row names a file that is gone, and it invalidates `lookupId`, not the raw request id, which for Codex is a placeholder. `locateJsonlPath` also consults the scanner's `getMetadataCache()` — the same map the list endpoint serves — so the list and the detail can no longer disagree about whether an id exists.

## Multi-agent mode

When `MULTI_AGENT_FLOW=true`, session start/input route through a Temporal-orchestrated pipeline; PTY mode is unreachable. Endpoints return structured errors `{error, code}` (codes in `src/agent/errors.ts`); mobile-relevant: **429 `SESSION_BUSY`** (carries `retryAfterMs`) and **413 `SESSION_HISTORY_FULL`** (prompt "start a new conversation"). Full endpoint contract, env vars, and dev setup: [docs/multi-agent-mode.md](docs/multi-agent-mode.md); design rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## Dependencies

- `@threadbase-sh/scanner` + `@threadbase-sh/agent-types` — published **public npm packages**, wired as normal semver deps. tsup bundles them inline into `dist/` (runtime doesn't need them at install time). Consequences:
  - A fresh checkout just runs `npm install` — no `git submodule update` needed.
  - CI checkouts use `submodules: false` (scanner/agent-types come from npm; only menubar remains a submodule and isn't needed in build/test).
  - Bump by raising the version range here and publishing a new version from `tb-scanner` / `threadbase-agent-types` (each repo publishes via its own semantic-release release workflow).
- `node-pty` — native PTY management (external, not bundled by tsup; dynamically imported for graceful failure)

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

The streamer is exposed publicly through a Cloudflare named tunnel → `http://127.0.0.1:8766`, behind Cloudflare Access: **every external request needs `Authorization: Bearer <api_key>`, even `/healthz`** (localhost healthchecks are unaffected). Deployment-specific config (`config-system.yml`, service restart) and general tunnel setup: [docs/guides/remote-access/cloudflare.md](docs/guides/remote-access/cloudflare.md).

## This repository is public — never commit a real identifier

`RonenMars/threadbase-streamer` is a **public** repository. Documentation, skills, tests and fixtures must never carry a real deployment identifier.

Never commit: a real tunnel hostname, a Cloudflare account id, a Zero Trust team domain (`<team>.cloudflareaccess.com`), an API key, a device token, or a private LAN topology beyond what is already published.

Use RFC 2606 reserved names instead — `example.com`, `tb.example.com`, `example.cloudflareaccess.com` — so a reader can tell at a glance that a value is illustrative.

Two failure modes this rule exists for, both of which happened here:

- **A scan for credentials does not catch a hostname.** A previous scrub searched for keys and tokens, came back clean, and left a real tunnel host in twelve files for weeks.
- **A placeholder can assert a falsehood.** Replacing a statement of fact — "the streamer is exposed at `<real host>`" — with an example host makes the sentence read as true when it is not. Rephrase to drop the identifier instead, and keep the operational fact.

Where a real value is genuinely needed to run something, it belongs in untracked local config, never in a tracked file.

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

What enforces this (the `main protection` / `release tags` rulesets, and why the admin bypass is load-bearing): the `merge-prs` skill.

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

## Issue status updates

Any change traceable to an existing issue ends with a status update on that issue — code, docs, tests, config, a revert, or a deletion all count. The issue is the record; a commit message, a PR body, or a chat reply is not a substitute.

- **Completed** — close the issue, with a comment naming what landed and where (PR or commit).
- **Partly completed** — leave it open and comment with what is done, what remains, and anything the remainder now depends on.
- **Not done** — leave it open and comment with why: blocked, superseded, out of scope, or a precondition that has to change first.

Never close an issue that was not actually finished, and never leave finished work with the issue still open. If one change resolves several issues, update each of them.

## Reference skills

Subsystem reference that used to live here, now loaded on demand (`.claude/skills/`):

| Skill | Covers |
|---|---|
| `server-config` | Environment variables, ServerConfig, CLI flags vs. server.yaml, auto-resume on boot, model & effort |
| `feature-flags` | The `FEATURE_FLAGS` registry, resolution precedence, current flags |
| `db-query-timing` | `db.slow_query` / `db.query`, the 35 ms threshold, host-saturation pathology |
| `push-notifications` | Waiting-for-input Expo push, iOS Live Activity APNs path |
| `windows-platform` | Task Scheduler, path separators, Windows-only gotchas |
| `merge-prs` | The `main protection` / `release tags` rulesets and their bypass rationale |
