# Multiple Claude accounts — streamer first, mobile second

**Status:** proposal (2026-10-05). Nothing below is implemented.
**Scope:** Claude Code only. Codex (`CODEX_HOME`) and Cursor are out of scope here; the
account abstraction is shaped so they can join later without a schema change.
**Order:** the streamer ships end to end (phases 0–5) before tb-mobile starts (phase 6).
Every streamer phase is additive on the wire, so a phone on today's build keeps working
against a multi-account server.

## Goal

One streamer, several Claude logins, each for a different context: for example a personal
Claude subscription, a work subscription provided by an employer, and possibly others
(a client, a side project). Today the streamer can only drive whichever account `~/.claude`
is logged into, so using the work seat for a work repo and the personal one for a hobby
repo means logging out and back in.

The user picks an account when starting a session, or the streamer picks it from the project
(work repos use the work account by default). Every session and conversation reports which
account it belongs to, resume always goes back to the right account, and history from
every account shows up in one list.

**Keeping the accounts separate is the point.** A work conversation stays under the work
account's directory and never gets copied into the personal one. The streamer never moves a
session between accounts, and never switches accounts automatically, for example when one
reaches its usage limit.

### Non-goals

- Pooling usage across accounts, or automatic failover when one account hits its limit.
- Moving or copying a conversation from one account to another.
- Codex and Cursor accounts (see Scope).

## How Claude Code separates accounts

Claude Code keeps an account's whole state under one directory, by default `~/.claude`
(plus `~/.claude.json`). It reads `CLAUDE_CONFIG_DIR` to move it. That directory holds:

- **Credentials.** On Linux and Windows that is `<dir>/.credentials.json`. On macOS it is a
  Keychain item whose service name is derived from the config dir, so two dirs give two
  separate Keychain entries.
- **Transcripts.** `<dir>/projects/<encoded-cwd>/<uuid>.jsonl`.
- **Settings, trust state, MCP config, todos and statsig caches.**

So **an account is a config directory.** Spawning `claude` with
`CLAUDE_CONFIG_DIR=<account dir>` gives that process the account's login, and its
transcripts land in that account's `projects/` tree. That is the whole mechanism. The rest
of this plan teaches the streamer to stop assuming `~/.claude`.

Phase 0 confirms each of these claims against the installed CLI version before any code
depends on them.

### Alternatives considered

| Option | Why not (as the primary model) |
|---|---|
| One config dir, per-account `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) injected at spawn | All transcripts land in one `projects/` tree, so nothing records which account ran a conversation, and resume cannot tell which token to use. Long-lived tokens also become a secret the streamer has to store. It could be offered later as an *auth method* for an account that still has its own dir. |
| Per-account `ANTHROPIC_API_KEY` | That is API billing, not a subscription login. It has the same attribution problem. The existing global `CLAUDE_API_KEY` → `ANTHROPIC_API_KEY` mapping stays as is for Fly. |
| Separate OS users or `HOME` per account | Heavy-handed: it breaks the PATH, `.gitconfig` and SSH keys that sessions rely on. `CLAUDE_CONFIG_DIR` changes only what Claude reads. |
| One streamer per account | Each instance needs its own port, its own pairing and its own phone entry, which is the exact thing this feature is meant to remove. |

## What exists today (verified 2026-10-05)

- `ScanProfile { id, label, configDir, enabled, emoji }` already exists
  (`src/scanner-manager.ts:96`), along with `ServerConfig.scanProfiles` (`src/types.ts:688`).
  `ScannerManager.projectsDirs()` (`src/scanner-manager.ts:302`) derives scan roots from
  enabled profiles, and the scanner package already accepts `profiles`. **No CLI flag or
  `server.yaml` key populates it.** It is reachable only programmatically, which makes it
  the natural seed for accounts.
- `GET /api/profiles` is a stub that returns `[]` (`src/api/routes/misc.routes.ts:464`). It
  is mapped to `history:read` (`src/services/security/capabilities.ts`).
- `buildSpawnEnv()` (`src/pty-manager.ts:176`) copies `process.env` and is used by both
  spawn sites (`:368` new, `:458` resume). It is the single injection point for
  `CLAUDE_CONFIG_DIR`.
- These sites hard-code `~/.claude`, ignore profiles and ignore an inherited
  `CLAUDE_CONFIG_DIR`:
  - `src/session-watchers.ts:168`: `watchForJsonl`, which binds a live session to its JSONL.
  - `src/handlers/handleListProjects.ts:66`
  - `src/services/conversations/shouldRefreshProjectsFromHdd.ts:8` (default dir)
  - `src/scanner-manager.ts:307` (no-profiles fallback)
  - `src/api/routes/diagnostics.routes.ts:129`
  - `src/docker/seed-claude-config.ts` (seeds `$HOME/.claude.json`)

  Even with a single account, a streamer launched with `CLAUDE_CONFIG_DIR` set spawns
  Claude into that dir but watches `~/.claude`. Fixing this is phase 1 and is worth doing
  on its own.
- `managed_sessions` (`runtime.db`) has `provider` but no account column.
  `conversation_meta` (`cache.db`, last migration `027`) has no account column either.

## Design

### Account model

```ts
type ClaudeAccount = {
  id: string;            // slug, stable, e.g. "personal", "work"; also the URL/API key
  label: string;         // display name
  emoji?: string;        // matches ScanProfile, for the phone's badge
  configDir: string;     // absolute; the CLAUDE_CONFIG_DIR value
  isDefault: boolean;    // exactly one
  projectPaths: string[]; // path prefixes that default to this account, e.g. ["~/work/"]
  enabled: boolean;      // disabled = not spawnable, history still listed (read-only)
  createdAt: number;
};
```

- **Implicit default account.** With no accounts configured, there is exactly one account,
  `id: "default"`, and `configDir = process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`. Single-account
  installs keep today's behaviour byte for byte, and no code path has to branch on whether
  multi-account mode is on.
- **For the default account, spawn does not set `CLAUDE_CONFIG_DIR`.** The variable is only
  injected for non-default accounts, or when the streamer itself inherited it. This avoids
  surprising a user whose `~/.claude.json` lives at the home root, which is the Claude CLI's
  legacy layout when the variable is unset.
- **Storage: `runtime.db`, new table `claude_accounts`** (`db/runtime-migrations/006_*.sql`).
  It goes there for the same reason `devices` moved: the account list cannot be rebuilt from
  disk, and it must survive `cache clear` and the integrity monitor's reset. `server.yaml`
  gets an optional `claudeAccounts:` list that is **upserted on boot**, so a declarative or
  Docker setup works. The database is authoritative for anything created at runtime (CLI or
  REST).
- **`scanProfiles` becomes derived.** It is built from enabled *and* disabled accounts,
  because disabled accounts still show history. The existing `projectsDirs()` path then
  covers discovery with no new scanner work. A `ScanProfile` passed programmatically keeps
  working, read as accounts with no persistence.
- **Validation.** `configDir` must be absolute, must not be nested inside another account's
  dir, and must be unique after `canonicalizeProjectPath`-style normalization. Two accounts
  pointing at the same dir would double-list every conversation.

### Attribution

- **Conversation → account** is derived from the file path: the longest account `configDir`
  that prefixes the canonical JSONL path wins. It is computed in one helper,
  `accountForFilePath()` in `utils/`, and follows the canonical/native rules in
  `canonicalizeFilePath.ts`. Every `conversation_meta` row stores it as `account_id`
  (cache migration `028`, rebuildable, backfilled on rescan).
- **Managed session → account** is recorded at spawn in `managed_sessions.account_id`
  (runtime migration `007`, nullable; null reads as `default`). The value is fixed for the
  session's life.
- **Resume picks the account from the conversation**, never from the request. A resume body
  that names a different `accountId` is answered **409 `ACCOUNT_MISMATCH`**. Claude's
  `--resume` only finds the transcript under its own `CLAUDE_CONFIG_DIR`, so silently
  honouring the request would start an empty session. A conversation never changes
  account (see Non-goals).
- **Discovered (external) processes.** On Linux, read `CLAUDE_CONFIG_DIR` from
  `/proc/<pid>/environ`. On macOS, use `ps eww`, best effort. Otherwise attribute by the
  JSONL the process is writing, once bound, and fall back to `default`.

### Choosing the account for a new session

When `POST /api/sessions` names no account, the first match wins:

1. `accountId` in the request.
2. **A project rule.** Each account has an optional `projectPaths: string[]` list of
   path prefixes, for example `~/work/` for the work account. Matching uses
   `canonicalizeProjectPath`, and the longest prefix wins.
3. The account used most recently for this project (`projects` + `managed_sessions`).
4. The server's default account.

The response's `accountId` says which one was used, and `accountSource`
(`request` / `project_rule` / `last_used` / `default`) says why. That lets the phone show
"Work (from project rule)" instead of a choice that looks unexplained.

### Spawn

`buildSpawnEnv(account)` sets `CLAUDE_CONFIG_DIR` for a non-default account. It also
**strips an inherited `CLAUDE_CONFIG_DIR`** when spawning the default account, unless that
inherited value *is* the default account's dir. The global `CLAUDE_API_KEY` →
`ANTHROPIC_API_KEY` mapping overrides every account's OAuth login, so when more than one
account is configured and `CLAUDE_API_KEY` is set, boot logs a `accounts.api_key_overrides`
warning and `GET /api/diagnostics` reports it.

`LiveSessionManager` already routes start, resume, adopt and fork through one
pre-flight. That pre-flight gains an account check, run after the provider-installed check:

| Condition | Answer |
|---|---|
| unknown `accountId` | 400 `UNKNOWN_ACCOUNT` |
| account disabled | 409 `ACCOUNT_DISABLED` |
| account has no credentials (phase 2 probe) | 503 `ACCOUNT_NOT_AUTHENTICATED` |

Without the auth check, a logged-out account spawns Claude straight into its login screen.
Over the PTY that looks like a session stuck in `running`.

### Watchers and resource cost

`watchForJsonl` takes the session's account dir instead of `homedir()`. The chokidar
directory watcher already iterates over `projectsDirs()`.

**Each account's `projects/` tree costs one watch handle per transcript** (see
`conversationWatcher.ts` in CLAUDE.md). On Linux that comes out of `max_user_watches`, so
adding accounts multiplies the exposure. Phase 1 adds the per-root file count to the
`watcher.*` boot log, and `prod doctor` warns when the projected total crosses half of
`max_user_watches`.

### Wire contract (all additive)

- `GET /api/info`: `accounts: { schemaVersion: 1 }` capability. Absent means an older
  server, so the client hides every account affordance.
- `GET /api/accounts` (`history:read`): returns
  `[{ id, label, emoji, isDefault, enabled, auth: { status, checkedAt, email? }, usage?: { limitedUntil? } }]`.
  `configDir` is **not** returned to `history:read` devices, because it is a local path.
- `POST /api/accounts`, `PATCH /api/accounts/:id` and `DELETE /api/accounts/:id`
  (`admin`). Delete refuses while a live session uses the account. It never touches the
  directory on disk.
- `GET /api/profiles`: stop returning `[]` and return the accounts in `ScanProfile` shape,
  since the route exists and is already capability-mapped. Before changing it, grep
  tb-mobile for `/api/profiles` and report what calls it.
- `POST /api/sessions` (start): optional `accountId`; absent means the default account.
  Resume and fork: optional `accountId`, which must match (see Attribution).
- Session objects (REST, `session_update`, `session_list`) and conversation list items gain
  `accountId`. `GET /api/conversations` and `/api/sessions` accept `?accountId=` as a
  filter.
- `ROUTE_CAPABILITIES` gains `/api/accounts`. The route-coverage test fails until it does.
- Device records (`/api/devices`, `admin`) gain an optional `allowedAccountIds` field
  (Decision 1).
- The push payload and the Live Activity content-state gain an optional `accountLabel`,
  which is only set when more than one account is enabled (Decision 3).

### Feature flag

`multiAccount` in `FEATURE_FLAGS` (`THREADBASE_FEATURE_MULTI_ACCOUNT`), default **off**
until phase 3 lands. With the flag off, the account table is still read so that attribution
columns fill in, but only `default` is spawnable, and `/api/accounts` returns just the
default account. The phase 1 refactor is not flag-gated: it fixes a real bug.

## Phases

### Phase 0: verify the CLI's behaviour (spike, no product code)

Against the pinned Claude Code version, on macOS and Linux, record results in this doc:

1. `CLAUDE_CONFIG_DIR=X claude`: confirm that transcripts go to `X/projects`, that
   `.claude.json` moves to `X/.claude.json`, that credentials are isolated (on macOS, the
   Keychain service name per dir), and that two accounts can run concurrently.
2. `--resume <uuid>` under a dir that does *not* hold the transcript: confirm whether it
   fails loudly or silently starts fresh. This only changes how the 409 is worded in the
   docs: `ACCOUNT_MISMATCH` is refused either way (Decision 4).
3. Find a non-interactive "am I logged in" probe (for example `claude auth status`, if the
   version has one, or credential-file/Keychain presence) and find how the login screen
   renders in a PTY, so the runner can detect it.
4. What the usage-limit screen looks like for Claude in the PTY, for phase 4.

**Exit:** each claim in "How Claude Code separates accounts" is confirmed or corrected.

### Phase 1: one resolver for "where is Claude's config" (no behaviour change)

- Add `src/claude-accounts/resolve.ts` with `defaultClaudeConfigDir()`,
  `accountForFilePath()` and `projectsDirFor(account)`.
- Replace every hard-coded `~/.claude` site listed above with those helpers. This fixes the
  inherited-`CLAUDE_CONFIG_DIR` mismatch for single-account installs.
- `buildSpawnEnv` takes an optional account. Callers pass the default account.
- Tests: a streamer booted with `CLAUDE_CONFIG_DIR` pointing at a temp dir watches, binds
  and lists from that dir. Add an `accountForFilePath` table test with both Windows and
  POSIX paths.

### Phase 2: account registry and auth probe

- Runtime migration `006_create_claude_accounts.sql`, a `ClaudeAccountsRepository`, the
  `server.yaml` `claudeAccounts:` upsert on boot, and derived `scanProfiles`.
- CLI: `tb-streamer accounts list | add <id> --label … [--dir …] | remove <id> | default <id> | login <id>`.
  `add` defaults `--dir` to `~/.threadbase/claude-accounts/<id>` and creates it with mode
  0700. `login` runs `claude` with the account's `CLAUDE_CONFIG_DIR` in the user's own
  terminal, so they complete `/login` interactively. The streamer never handles the OAuth
  exchange or the credential itself.
- `accounts add --copy-settings-from <id>` (opt-in, per Decision 2) copies `settings.json`,
  the user-level `CLAUDE.md`, `commands/` and `agents/`, and prints each path it copied.
  It never copies credentials, `.claude.json` or `projects/`. It warns when `settings.json`
  has an `env` block or MCP servers that carry tokens or headers.
- Auth probe from phase 0, cached per account and refreshed on boot, on `GET /api/accounts`
  when older than 60 s, and after a spawn lands on the login screen.
- `GET /api/accounts` (read-only), `GET /api/profiles` populated, and the `/api/info`
  capability.
- Tests: migration, the repository, yaml upsert idempotence, nested or duplicate dir
  rejection, and capability mapping.

### Phase 3: spawn, attribute and resume per account

- `accountId` on start, resume and fork, plus the pre-flight table above.
- `managed_sessions.account_id` (runtime `007`) and `conversation_meta.account_id`
  (cache `028`) with backfill.
- Attribute discovered processes.
- `accountId` on every session and conversation shape, and the `?accountId=` filters.
- Auto-resume on boot (`session-registry-boot.ts`) resumes into the recorded account.
- Account selection for new sessions: request, then project rule, then last used, then
  default, with `accountSource` in the response.
- Login-screen detection in `pty-manager`: surface it as `failureReason` /
  `failureCode: "account_not_authenticated"` so the phone stops spinning. This mirrors
  Codex's usage-limit card.
- Flip `multiAccount` default on once this phase is green.
- Tests: two temp accounts. A session started in each writes its JSONL to its own tree;
  the list shows both with the correct `accountId`; resume goes to the right dir; a
  mismatching resume returns 409; a disabled account returns 409; an unauthenticated
  account returns 503.

### Phase 3b: per-device account visibility

Per Decision 1. This lands after phase 3 and before mobile's account settings (phase 6
item 7).

- Runtime migration: `devices.allowed_account_ids` (JSON text, nullable). Null means the
  device sees every account, so existing devices are unaffected.
- Enforce it on the server in the places the `?accountId=` filter already applies:
  conversation and session lists, search, `/api/accounts`, and session control.
  Controlling a session whose account is hidden from the device returns **404**, not 403,
  so the device cannot learn that the session exists.
- WebSocket: filter `session_list`, `session_update` and `terminal_output` per subscriber,
  and refuse to subscribe a device to a session of a hidden account. This per-subscriber
  filtering is the costly part of this phase.
- The shared API key is not a device, so it always sees every account. The guide must say
  so. Only per-device tokens get this boundary.
- Tests: a device limited to one account cannot list, search, subscribe to or control the
  other account's sessions, and an unrestricted device sees both.

### Phase 4: usage-limit visibility per account

- Detect Claude's usage-limit screen (phase 0 item 4). Set `failureReason` /
  `failureCode: "usage_limit"` on the session so the phone stops spinning in `running`, and
  record `usage.limitedUntil` on that account so `GET /api/accounts` and the new-session
  picker can show it ("Work: limit resets 14:00").
- Report only. The streamer does not offer to continue the conversation on another account
  (see Non-goals).

### Phase 5: management over the API

- `POST`, `PATCH` and `DELETE /api/accounts` (`admin`).
- **Remote login is deferred** (Decision 5): it is not built until someone needs it. The
  sketch, for when it is: spawn a dedicated "login session" (`CLAUDE_CONFIG_DIR=<dir>
  claude`, showing `/login`) as an ordinary PTY session flagged `kind: "account_login"`, so
  the phone drives the OAuth paste-code flow through the existing terminal stream, and end
  it when the auth probe flips to `authenticated`. It needs a security review
  (`docs/security/`) and must refuse when e2ee is off on a non-local connection.
- Docs: `docs/guides/multiple-claude-accounts.md`, a `server-config` skill update, and
  `docs/api-reference.md`.

### Phase 6: tb-mobile (after the streamer ships phases 0–3; phases 4–5 enable more screens)

File this as a separate tb-mobile issue that links back here, per the cross-repo rule.

1. **Capability gate.** Show any account UI only when `/api/info` carries `accounts`. On an
   older streamer the app behaves exactly as today.
2. **New-session sheet.** An account picker, shown only when more than one account is
   enabled. It preselects whatever the server would choose (project rule, last used, then
   default) and shows why. Accounts that are unauthenticated or at their usage limit are
   visible but disabled, with the reason. Choosing an account that overrides a project rule
   asks for confirmation first (Decision 6).
3. **Badges.** An account emoji or label on session rows, conversation rows and the session
   header. Hide it when only one account exists.
4. **Filter.** An account chip on the history and sessions lists, which maps to
   `?accountId=`.
5. **Errors.** Map `UNKNOWN_ACCOUNT`, `ACCOUNT_DISABLED`, `ACCOUNT_NOT_AUTHENTICATED` and
   `ACCOUNT_MISMATCH` to readable copy, and parse them defensively, following the "degrade,
   don't break" contract.
6. **Usage limit (phase 4).** Show which account hit its limit and when it resets, on the
   session and in the account list.
7. **Account settings (phase 5).** List accounts with their auth status, add, rename and
   disable them, and edit their project rules. Device management also lets the user choose
   which accounts each device sees (phase 3b). There is no in-app login while remote login
   is deferred: an unauthenticated account shows "Log in on the computer with
   `tb-streamer accounts login <id>`".
8. **Notifications.** Render `accountLabel` as a short prefix in the subtitle
   (`Work · my-repo`) when it is present.

## Decisions (2026-10-08)

1. **Per-device account visibility: yes, enforced on the server, built in phase 3b.** Each
   device has an optional allowlist of account ids. Empty means every account. The list is
   enforced in REST, search and WebSocket, because hiding accounts only in the phone UI is
   not a boundary: the device token can still call the API. The shared API key is not a
   device, so it is not covered.
2. **Copying settings: opt-in, minimal, never secrets.** `--copy-settings-from` copies
   `settings.json`, the user-level `CLAUDE.md`, `commands/` and `agents/`. It never copies
   credentials, `.claude.json` or `projects/`, and it warns about `env` blocks and MCP
   servers that carry tokens. It is not the default, because copying a work MCP config into
   a personal account is exactly the cross-over this feature exists to prevent.
3. **Account label in notifications: only when more than one account is enabled.** It is a
   short subtitle prefix (`Work · my-repo`) and nothing more on the lock screen. The server
   sends an optional `accountLabel`, and mobile decides how to render it.
4. **Resuming under a different account: always 409 `ACCOUNT_MISMATCH`**, whatever phase 0
   finds. Refusing up front gives the phone a clear error and keeps the rule that a
   conversation never changes account.
5. **Remote login from the phone: deferred.** Each account is logged in once at the
   computer with `tb-streamer accounts login`, and logins last a long time. Sending an OAuth
   flow through the tunnel is the riskiest piece for the least benefit. If it is ever
   built, it requires e2ee and a security review.
6. **A project rule beats the last-used account, and overriding it needs confirmation.**
   This stops one mistaken tap from making a personal account the "last used" for a work
   project.

## Risks and open questions

- **CLI behaviour drift.** `CLAUDE_CONFIG_DIR` semantics are the CLI's, not ours. Pin the
  phase 0 findings to a version, and add a smoke test that spawns with a temp dir and
  asserts that the transcript lands there.
- **Data boundary between accounts.** A work account's transcripts may fall under the
  employer's policies. The combined history list is display only: nothing copies, moves or
  forks a transcript across account directories. If a later request wants a cross-account
  copy, it needs its own design and an explicit user action. Hiding an account from some
  devices is phase 3b (Decision 1).
- **Shared project settings.** `.claude/` *inside a repo* (project settings, `CLAUDE.md`)
  is unaffected and shared across accounts. That is intended.
- **MCP servers and user settings live per account.** A new account starts with no MCP
  config unless the user opts in to copying settings (Decision 2).
- **Inotify budget on Linux.** See "Watchers and resource cost" above.
- **Push and Live Activity payload.** Adding `accountLabel` (Decision 3) has to follow the
  payload contract in the `push-notifications` skill, which is shared with tb-mobile.

## Done means

- Streamer: phases 0–3 merged, with a two-account integration test green on all three CI
  OSes, and the guide published.
- Streamer, before the mobile account-settings screen: phase 3b merged.
- Mobile: phase 6 items 1–5 shipped against a phase 3 streamer, with an old-streamer
  regression check showing no account UI and no errors.
