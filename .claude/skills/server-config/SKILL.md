---
name: server-config
description: tb-streamer server configuration reference: every THREADBASE_* environment variable, ServerConfig fields, CLI flags vs. server.yaml precedence, auto-resume-on-boot, and how model/effort/permission-mode reach a spawned agent. Use when adding, changing, or debugging a server config knob, env var, CLI flag, server.yaml key, or the model/effort a session spawns with.
---

# Server Config

Moved out of the repo root `CLAUDE.md` so it loads on demand rather than in every session.
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
| `THREADBASE_DB_SLOW_QUERY_MS` | Duration at or above which a SQLite statement is logged at warn as `db.slow_query`. Default `35` — measured, see [Query timing] (see the db-query-timing skill). `<= 0` disables slow-query logging. |
| `THREADBASE_FEATURE_*` | One var per feature flag (`THREADBASE_FEATURE_CODEX_SYSTEM_PROMPT`, …). Highest-precedence source; yaml/`--feature` ids are the `FEATURE_FLAGS` keys (`ptyHost`), not these env names. See [Feature flags] (see the feature-flags skill). Truthy `1/true/yes/on`, falsy `0/false/no/off/""`; unset means "defer to the CLI flag, then server.yaml". |
| `THREADBASE_CONFIG_DIR` | Overrides the config directory (default `~/.threadbase`) that `server.yaml` — including the `api_key` — is read from and written to. Mainly a test hook: it lets `setApiKey`/`loadOrCreateApiKey` target a throwaway dir so `POST /api/auth/rotate` and `set-key` never clobber the real live config. Unset in production. |
| `THREADBASE_RUNTIME_DB` | Overrides the path of the session-registry database (default `runtime.db` inside the config dir). A test hook first: `__tests__/setup/isolate-runtime-db.ts` points every test file at a throwaway file so a suite run never writes sessions into the real `~/.threadbase/runtime.db`. It exists separately from `THREADBASE_CONFIG_DIR` because several auth tests sandbox the config dir by overriding `HOME`, and `THREADBASE_CONFIG_DIR` outranks `homedir()`. Unset in production. |
| `MULTI_AGENT_FLOW` | Routes `POST /api/sessions/start` + `/input` to the multi-agent path instead of PTY. `AGENT_*` tuning vars: see [docs/multi-agent-mode.md](docs/multi-agent-mode.md). |
| `THREADBASE_SKIP_PERMISSION_MODE_PROMPT` | Set to `true` to disable the `serve` first-run interactive permission-mode prompt (see below); falls straight through to `acceptEdits`. |
| `THREADBASE_SKIP_AUTO_RESUME_PROMPT` | Set to `true` to disable the `serve` first-run interactive auto-resume prompt (see [Auto-resume on boot] (see below)); resolves to `false` (no auto-resume). |
| `THREADBASE_ALLOW_BROWSER_CORS` | Enables browser CORS (off by default; no web page can make authenticated requests without it). Set to `1`/`true`/`yes`/`on` to allow the localhost dev origins, or to a comma-separated origin list (e.g. `https://app.example.com`) to allow those on top of the dev defaults. Overrides `browser_cors:` in server.yaml when set. Mobile is unaffected (no `Origin` header). |
| `APNS_KEY` | **Contents** of the APNs p8 signing key (PEM), not a path. Required for iOS Live Activity push but no longer sufficient on its own — the `liveActivityPush` feature flag must also be on. Either missing leaves the feature off with one info log and a normal boot. Never logged. See [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md). |
| `APNS_KEY_ID` | Key id of the p8 in `APNS_KEY`. Required when `APNS_KEY` is set; under launchd it is derived from the `AuthKey_<keyId>.p8` filename. |
| `APNS_TEAM_ID` | Apple Developer team id. Required when `APNS_KEY` is set; no default, so one deployment's Apple account is never baked into the source. |
| `APNS_BUNDLE_ID` | App bundle id; the APNs topic is this plus `.push-type.liveactivity`. Required when `APNS_KEY` is set. |
| `APNS_HOST` | APNs host. Defaults to sandbox (`api.sandbox.push.apple.com`) because the app's `aps-environment` is still `development`; set `api.push.apple.com` for production. |
| `THREADBASE_EXPO_ACCESS_TOKEN` | Expo access token for the "your turn" push relay. Only needed if the Expo project has enhanced security enabled; unset is the normal case and sends go unauthenticated. Never logged. See [Waiting-for-input push] (see the push-notifications skill). |

## CLI flags vs. `server.yaml`

`server.yaml` is **not** a complete config file. The CLI reads the API key (and optionally `browse_root`, `public_url`, `allowed_paths`, `default_permission_mode`, `browser_cors`, `pty_grace_period_ms`, `claude_flags`, `claude_extra_args`, `feature_flags`) from it, but most runtime knobs come exclusively from CLI flags.

`--prod` does not change which directory is read. Leave `THREADBASE_CONFIG_DIR` unset so both the launchd / Task Scheduler instance and an ad-hoc `serve` share `~/.threadbase/`. See [docs/guides/prod-dev-lifecycle.md](docs/guides/prod-dev-lifecycle.md).

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
| `featureFlags` | registry defaults | Server feature flags from the CLI (`--feature <id=bool>`). Merged with the env vars and `feature_flags:` in server.yaml — see [Feature flags] (see the feature-flags skill). |

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

