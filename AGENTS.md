# Threadbase Streamer — Codex Instructions

Keep this file to repository-specific behavior and safeguards. Use [docs/agents/tooling.md](docs/agents/tooling.md) for optional agent tooling, [docs/troubleshooting.md](docs/troubleshooting.md) for known failures, and the linked guides for procedures.

## Project

`@threadbase/streamer` is a TypeScript library and CLI for PTY session management, WebSocket streaming, and a REST API for Claude Code and Codex conversations.

The layers are core (`src/`), API (`src/api/` plus `src/index.ts`), and CLI (`cli/`). Important invariants:

- Route all session-state mutations through `session-store.ts`.
- SQLite (`conversation-cache.ts`, `db/migrations/`) is primary persistence; Postgres is dormant except for reserved tables and `session_uploads`.
- Canonicalize project paths with `utils/canonicalizeProjectPath.ts` before deduplication.
- Validate HTTP and scanner input at the boundary with `schemas/*.schema.ts`.
- Hono handlers that write through `c.env.outgoing` return `ALREADY_HANDLED` (`Response` status 597) to suppress response piping.

## Commands

- Full verification: `npm run lint && npm test`
- Build: `npm run build`
- Targeted test: `npx vitest run <test-file>`
- Database commands: `npm run migrate`, `npm run migrate:projects`, `npm run db:validate`

Vitest globals are enabled. Every new feature requires tests under `__tests__/`.

## Session and API contracts

- Live statuses are `running`, `waiting_input`, and `idle`. Historical resumable conversations use `on_hold`; mobile treats `idle` and `on_hold` as equivalent.
- A WebSocket disconnect does not arm a hold. Only `hold_session` starts the grace timer; a running turn may defer the hold and must not be cut mid-response. The idle reaper never holds a `running` session.
- Codex resume/fork readiness is authoritative. An active rollout writer returns HTTP 409 with `code: "CONVERSATION_BUSY"` and `reasonCode: "CODEX_SESSION_ACTIVE"`; `force` does not bypass it. Recovery is `POST /api/sessions/:id/fork`. See [docs/compatibility/codex-collision-and-fork.md](docs/compatibility/codex-collision-and-fork.md).
- Under `MULTI_AGENT_FLOW=true`, start/input use the Temporal pipeline and PTY mode is unreachable. Preserve 429 `SESSION_BUSY` with `retryAfterMs` and 413 `SESSION_HISTORY_FULL`. See [docs/multi-agent-mode.md](docs/multi-agent-mode.md).

## Configuration invariants

- `server.yaml` is not complete runtime configuration. `port:` is ignored; services must pass `--port` explicitly (default `8766`).
- Feature flags resolve at boot in this order: `THREADBASE_FEATURE_*` environment variables, `--feature`, `feature_flags` in YAML, registry defaults. YAML and CLI use keys from `FEATURE_FLAGS`, not environment-variable names. See [docs/guides/feature-flags.md](docs/guides/feature-flags.md).
- `permissionMode`, `model`, and `effort` are spawn positionals. If `buildFlagArgs` skips one via `SPAWN_POSITIONAL_FLAG_IDS`, `StreamerServer.spawnFlagOverrides()` must resolve it; otherwise the API becomes a silent no-op.
- `ptyGracePeriodMs: 0` means hold immediately, not never.
- `--no-e2ee` is a `serve` option only: no `server.yaml` key and no environment variable of its own. It folds into the CLI rung, so `THREADBASE_FEATURE_E2EE=1` still wins by the precedence above — that collision is a rollout decision, not a bug to patch locally. It never un-pins a device: a paired device still gets `426` afterwards.
- Encryption and an edge gate do not coexist. A sealed request carries no `Authorization` header, so an interactive Cloudflare Access application in front of the public URL blocks pairing entirely — the request never reaches the origin, and the device blames the server. The `accessProbe` flag (on by default) detects this at boot and warns; never "fix" it by re-adding `Authorization` to sealed requests. See [docs/troubleshooting.md](docs/troubleshooting.md#paired-devices-cannot-pair-or-connect-through-a-hostname-protected-by-access).

## Dependencies and build

- `vendor/scanner`, `vendor/agent-types`, and `vendor/menubar` are git submodules. Initialize submodules before `npm install`; CI checkouts remain recursive. Use HTTPS on machines without GitHub SSH keys.
- `@threadbase/scanner` and `@threadbase/agent-types` are `file:` dependencies built by `postinstall` and bundled into `dist`.
- Do not suppress install scripts unless you manually preserve `prepare` (`patch-package`) and `postinstall` (including the executable `node-pty` spawn helper).
- For the CLI bundle, only `node-pty` is external. `pg` and all other runtime dependencies must be bundled because deployed releases have no `node_modules`.
- Preserve both SQLite and Postgres migration copies in the build. Deployment details live in [docs/guides/deploy-internals.md](docs/guides/deploy-internals.md).

## Deployment and platform safeguards

- Only one streamer may bind port 8766. Prod/dev takeover uses `~/.threadbase/prod-suspended.json`; bump its `shimVersion` when its shape changes. Keep the macOS `launchd-entry.cjs --prod` invocation and Windows `TASK_NAME` aligned with deploy scripts. See [docs/guides/prod-dev-lifecycle.md](docs/guides/prod-dev-lifecycle.md).
- macOS launchd plists must include Homebrew paths in `EnvironmentVariables.PATH`; retain the absolute-path fallback in `resolveClaudeExe()`.
- Auto-update must stop the Windows service before replacing `current`, preserve service-label resolution, defer when active-session state is unknown, and keep `/api/__update` protected by HMAC rather than bearer auth. See [docs/guides/auto-update.md](docs/guides/auto-update.md).
- On Windows, use `path.sep` for resolved-path prefix guards and `mtimeMs` for timestamp tests. Start setup or diagnosis with [docs/guides/windows-setup.md](docs/guides/windows-setup.md).
- Cloudflare Access requires bearer authentication on every external request, including `/healthz`; localhost health checks are unaffected. See [docs/guides/remote-access/cloudflare.md](docs/guides/remote-access/cloudflare.md).

## Compatibility

Streamer/mobile compatibility is advisory, not a change gate. For a wire rename, removal, or changed status/event vocabulary, search the adjacent mobile source and report exact consumers; additive changes need no check. See [docs/compatibility/tb-mobile.md](docs/compatibility/tb-mobile.md).

Do not repurpose these released contracts:

- `Authorization: Bearer <token>` and `/ws?key=<token>`
- Pairing keys shaped as `tb_<32-hex-chars>`
- Status meanings for `running`, `waiting_input`, `completed`, `failed`, `on_hold`, and `idle`
- Menubar dependencies: default port 8766, `server.yaml` port fallback, and `/healthz` returning `{ ok, version }`

## This repository is public — never commit a real identifier

`RonenMars/threadbase-streamer` is a **public** repository. Documentation, skills, tests and fixtures must never carry a real deployment identifier.

Never commit: a real tunnel hostname, a Cloudflare account id, a Zero Trust team domain (`<team>.cloudflareaccess.com`), an API key, a device token, or a private LAN topology beyond what is already published.

Use RFC 2606 reserved names instead — `example.com`, `tb.example.com`, `example.cloudflareaccess.com` — so a reader can tell at a glance that a value is illustrative.

Two failure modes this rule exists for, both of which happened here:

- **A scan for credentials does not catch a hostname.** A previous scrub searched for keys and tokens, came back clean, and left a real tunnel host in twelve files for weeks.
- **A placeholder can assert a falsehood.** Replacing a statement of fact — "the streamer is exposed at `<real host>`" — with an example host makes the sentence read as true when it is not. Rephrase to drop the identifier instead, and keep the operational fact.

Where a real value is genuinely needed to run something, it belongs in untracked local config, never in a tracked file.

## Repository workflows

- GitHub Issues are the worklist. Follow [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md); do not duplicate status into `docs/BACKLOG.md` or `docs/ROADMAP.md`.
- `CHANGELOG.md` is generated; never edit it manually. Milestone merge PRs carry the `milestone` label and add manually written notes under `docs/release-notes/` using `_template.md`.
- When setup, deployment, or runtime exposes an undocumented failure, ask before adding it to `docs/troubleshooting.md`; document symptom, cause, and fix alongside the code change.
- Merging is rebase-then-squash, one PR at a time, only on green CI (full rules: `CLAUDE.md` → "Merging PRs"). Three repo behaviours trip automation: semantic-release pushes a `[skip ci]` release commit to `main` after every merge and protection requires up-to-date branches, so wait for it before the final rebase; GitHub auto-deletes head branches, so check `gh pr view <N> --json state` says `MERGED` before any branch cleanup (deleting the head of a refused merge closes the PR); the push hook in `scripts/git-hooks` rebases and rewrites SHAs, so compare content with `git patch-id`, not SHAs.

## Headless Linux agents

Node 22–24 is supported; use the repository `.nvmrc` when available. Build before running because `npm run dev` only watches the tsup build.

On Linux, run `node dist/cli.cjs serve --prod`; the unsupervised lifecycle path supports only macOS and Windows. Live PTY testing requires a `claude` executable; `docker/claude-code-stub/claude.js` is the reviewer-safe stub. Session start also requires `--browse-root`. Postgres and Temporal are optional and off by default.
