# Roadmap — Threadbase Streamer

Planned features and deferred work. Not blocking. No fixed dates — these get picked up when there is a concrete need or a quiet stretch.

For bugs (work that fixes broken behavior rather than adding new behavior) see [BACKLOG.md](BACKLOG.md).

---

## Feature: migrate `GET /api/search` to the HTTP QUERY method

`GET /api/conversations/{id}/search-target` was migrated from `GET ?q=` to the HTTP QUERY method (RFC 10008 — safe, idempotent, cacheable like GET, but carries the query as a JSON body like POST). `GET /api/search?q=<query>&limit=50` — the separate conversation-search-by-metadata endpoint (`handleSearch` in `src/server.ts`, `src/api/routes/scanner.routes.ts`) — was deliberately left as GET at the time, out of scope for that change. Migrate it the same way for consistency: `q` and `limit` move into a JSON request body (`{ q, limit }`), the route registers via `app.on("QUERY", "/api/search", ...)`, and the response gains an `Accept-Query: application/json` header. Mirror the same validation/error-code shape as `search-target` (415 for a non-JSON `Content-Type`, 422 for an invalid query body).

**Mobile side:** `tb-mobile`'s `useConversationSearch` (`hooks/useConversations.ts`) currently builds `GET /api/search?q=...&limit=50` via `api.get`. It would switch to the `query()` method already added to `services/api-client.ts` for the `search-target` migration — no new client plumbing needed, just wiring the call site.

**Why not now:** RFC 10008 is only weeks old (published 2026-06-15) with no mature runtime/framework support yet. Migrating `search-target` first was a smaller, isolated proof — one endpoint, one caller, no compatibility payoff since the streamer controls both ends. `/api/search` is a higher-traffic, more visible endpoint (every search keystroke in the mobile hub); wait for QUERY to see broader ecosystem adoption (or at least a stable Node/undici release with no rough edges) before touching it. Also needs the mobile PR that ships `query()` (paired with the `search-target` migration) merged first, since this migration reuses that client method rather than reintroducing its own.

---

## Feature: keychain storage for the API key

Today the streamer's API key lives at `~/.threadbase/server.yaml` as plaintext `api_key: tb_<32hex>`, protected only by filesystem perms (`chmod 0600`). The `tb-streamer set-key` command writes through the same path. That matches the de-facto convention for CLI tools (`~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.npmrc`), but a determined local attacker — or a malicious postinstall running as the user — can read the file directly.

**Approach:** move the API key to the OS keychain (macOS Keychain via `keytar`, Windows Credential Manager, libsecret on Linux). The daemon runs as the user, so a user-scoped keychain entry is readable at boot without prompting. `loadOrCreateApiKey`, `setApiKey`, and the pairing flow each need a small adapter. `server.yaml` keeps the non-secret fields (`browse_root`, `public_url`, `cache_dir`, `tail_size`).

**Migration:** on first boot after upgrade, if `api_key:` is still in `server.yaml`, move it to the keychain and rewrite the file without the line. Keep a deprecation read-fallback for one minor version so older `tb-streamer pair` flows that wrote to YAML continue to work, then remove.

**Why not now:** a native keychain dep complicates the `pack-platform.mjs` per-arch bundle (currently only `node-pty` and `better-sqlite3` are externalized). Most CLI tools in this category ship plaintext + 0600 for the same reason. Revisit when a security review flags it, or when the streamer ships keys/secrets that are not recoverable via the pair flow.

**Update (2026-06-26):** the 2026-06-24 security audit (`docs/plans/2026-06-24-security-hardening.md`) confirmed this is the remaining at-rest gap after the H1/H2/M2/M3 hardening shipped in PR #129. `POST /api/auth/rotate` now exists, making migration feasible: rotate once post-upgrade to move from the YAML-backed key to the keychain-backed one without re-pairing all devices.

---

## Feature: Homebrew vs `scripts/deploy.sh` plist conflict-check at startup

The Homebrew tap ships its own launchd plist (`homebrew.mxcl.tb-streamer`) via `brew services`. Users who previously installed through `scripts/deploy.sh` already have `com.threadbase.streamer.plist` (or the newer lifecycle-shim variant) bound to port 8766. Running `brew services start tb-streamer` on top will start a second agent that crashes on `EADDRINUSE` until launchd throttles it.

Shipped today: a caveats note in the formula tells users Homebrew + manual deploy are mutually exclusive. That bites the unlucky user who upgrades from manual → Homebrew without reading.

**Approach:** add a conflict check inside `tb-streamer serve` (or a dedicated `tb-streamer doctor` step) that, on startup, scans `launchctl list` for `com.threadbase.streamer*` labels other than `homebrew.mxcl.tb-streamer`. If found, exit 0 with a log line telling the user to either `launchctl bootout` the legacy agent or uninstall the Homebrew formula. Reuse the Supervisor / marker plumbing from `src/lifecycle/`. Add a matching check on Windows (Task Scheduler `Threadbase` task vs any Homebrew-equivalent — currently N/A but worth scaffolding for symmetry).

---

## Feature: forward `thinkingSignature` in the messages mapper

The scanner exposes `thinkingSignature` per message but the streamer's mapper (`src/server.ts`) does not forward it. Add it next to `thinking` / `thinkingContent`. UI work in [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) is then a small follow-up to show a "redacted reasoning" placeholder when the signature is present but the content is empty.

---

## Feature: forward `sourceToolAssistantUUID`

Scanner extracts `sourceToolAssistantUUID` for cross-entry correlation (tool result → originating tool-use). No concrete consumer use case yet. Add forwarding when a feature needs it (e.g. a "show me the tool-use that produced this result" affordance in the mobile UI).

---

## Feature: full `SystemEntry` type forwarding (`stop_hook_summary`, `bridge_status`)

These are internal Claude Code housekeeping records. The streamer extracts `turn_duration` from this category (already forwarded as `turn_durations`) but not the rest. Forward the full type if/when an analytics or debug consumer wants it.

---

## Feature: per-image metadata (`ImageBlock` type)

The streamer currently forwards a `hasImages` boolean per message, which is sufficient for the badge UI in the mobile client. Forward per-image metadata (media type, size, dimensions) when a feature needs more than a yes/no.

---

## Feature: SHA256 integrity check on downloaded menubar artifacts

The deploy downloads `*-universal.dmg` / `*-x86_64.AppImage` / `*-x64.exe` from GitHub Releases and executes them (NSIS `/S`, mount-and-copy, `chmod +x`) with TLS-only assurance. GitHub allows re-uploading release assets — a compromised release would propagate to every deploy. The streamer's own auto-update path (`src/updater`) already verifies SHA256 against a manifest; the menubar fetch does not.

**Approach:** publish a `checksums.txt` (or `<artifact>.sha256`) alongside the menubar release assets in `RonenMars/threadbase-menubar`'s release workflow. Update `scripts/lib/fetch-menubar.{sh,ps1}` to download the checksum file before the artifact and verify before executing. Mirror the manifest-driven verification used by the streamer updater so both flows share a single integrity story.

**Why not now:** threat model today is low — single-maintainer repo, releases are CI-signed, no external contributors. Revisit when the menubar repo accepts outside PRs that touch the release workflow, or when a security review flags it.

---

## Feature: Windows `prod logs` (Task Scheduler redirection)

`tb-streamer prod logs` works on macOS via launchd's `StandardOutPath` / `StandardErrorPath`. On Windows, `src/lifecycle/task-scheduler.ts:65-69`'s `getLogPaths()` throws a clear message because `launch.cmd` does not currently redirect stdout/stderr to a file — Task Scheduler has no native redirection.

**Approach:** rewrite `launch.cmd` (or the scheduled task action) to invoke `pwsh.exe -Command "node cli.js serve ... *>> $logDir\stdout.log 2>> $logDir\stderr.log"` so the runtime captures output. Then map `getLogPaths()` on the Task Scheduler backend to those paths. Until that's wired, gate the `prod logs` Commander registration on `process.platform === "darwin"` so `tb-streamer prod --help` on Windows doesn't advertise a feature that always fails.

---

## Improvement: normalize Commander boolean option parsing in `prod logs`

`cli/prod.ts:233-240` uses `opts.follow !== false` / `opts.errorsOnly === true` / `opts.clear === true` to coerce Commander's option output to booleans. The pattern works today because the defaults are typed (`--no-follow` → `false`; `--errors-only` default `false`; `--clear` default `false`), but it is brittle: any future refactor that changes the default to `undefined` silently flips the inverted comparison.

**Approach:** introduce a small normaliser at the action callback boundary — `Boolean(opts.follow ?? true)`, `Boolean(opts.errorsOnly)`, `Boolean(opts.clear)` — or rely on Commander's typed defaults and drop the `!== false` / `=== true` idioms. Picked up on next touch of `registerProdCommands`.

---

## Feature: structured prompt cards (permission gates + AskUserQuestion) for Codex sessions

Claude Code live sessions get a native `QuestionCard` UI in `tb-mobile` for permission gates and `AskUserQuestion` menus, detected server-side from the rendered PTY screen (`src/services/questions/*`, orchestrated in `src/pty-manager.ts`). Codex sessions (added in [PR #159](https://github.com/RonenMars/threadbase-streamer/pull/159)) don't get this — `CodexPtyRunner` never emits the `permission`/`question` WebSocket events, so any Codex-side approval or choice prompt only shows as raw terminal text.

**Approach:** see [docs/plans/2026-07-04-codex-structured-prompts-followup.md](plans/2026-07-04-codex-structured-prompts-followup.md) for the full scoping — which existing detector files are reusable vs. Claude-only, and the open questions (Codex's `--ask-for-approval` on-screen shape is unverified) that need a live probe before implementation starts. The mobile-side rendering pipeline is already provider-agnostic; all follow-up work is server-side.

---

## Improvement: split `src/server.ts` along the existing `ApiDeps` seams

`src/server.ts` is ~3300 lines, dominated by the `StreamerServer` god class — the repo's #1 merge-conflict magnet, touched in nearly every PR. The routing migration is half-done: `src/api/routes/*.ts` are thin Hono factories that delegate back into the class via `ApiDeps.handleXxx` bound methods, but the handler **bodies** (~2000 lines) still live inside the class.

**Approach:** see [docs/plans/2026-07-12-server-ts-split.md](plans/2026-07-12-server-ts-split.md) — extract handler bodies into factory-with-context handler modules (`src/api/handlers/`), plus a `ScannerManager` for scanner lifecycle/freshness state and a `session-watchers` module. `ApiDeps` and all HTTP behavior stay identical (tb-mobile compat untouched). Four mechanical-move PRs, each independently mergeable; sequenced after the in-flight reparse-stall guard-rails work lands, since that touches the exact code the first extraction moves.
