# Live sessions persistence — implementation plan

**Date:** 2026-07-29
**Branch:** `plan/live-sessions-persistence` (from `integration/missing-prs-2026-07-23`)
**Companion:** [live-sessions-persistence-audit.md](./live-sessions-persistence-audit.md) — read it first; every gap reference `G1`–`G12` below points there.
**Related:** [session-source-visibility-and-control.md](./session-source-visibility-and-control.md) — a separate feature stream (session source detection, stopping and taking over sessions the streamer does not own) that shares this plan's `ownership` / `lifecycle` vocabulary but has its own PRs.

---

## 1. What is and is not feasible

Stated up front, because it determines the whole shape of the plan. The mechanism is measured, not assumed — see audit §4 and `__tests__/pty-parent-exit-hangup.test.ts`.

| | Server restart (today) | Server restart (with Phase 6) | `SIGKILL` streamer | **Machine restart** |
|---|---|---|---|---|
| Agent process survives | ✗ | ✓ | ✗ | ✗ **impossible** |
| Byte-accurate terminal replay | ✗ | ✓ | ✗ | ✗ |
| Conversation continues via provider resume | ✓ | ✓ | ✓ | ✓ |
| Transcript intact | ✓ | ✓ | ✓ | ✓ |

Two consequences that shape everything below:

1. **Conversation-level continuity is the only primitive that works for both restart kinds.** Phases 1–5 build it. They deliver the entire user-visible outcome — "my session is still there, one tap away" — with no new process.
2. **Process-level continuity across a *server* restart is achievable, but only by moving the PTY master fd out of the streamer.** That is Phase 6. It changes nothing about a machine restart, ever.

**Auto-resume on boot is opt-in, off by default** (Phase 7). An earlier revision of this plan ruled it out entirely; it is back as a user choice, persisted in `server.yaml`, defaulting to `false` and never enabled silently. The reason it must stay opt-in is unchanged: unattended respawn at login is arbitrary code execution, and `--permission-mode bypassPermissions` makes that literal. With the setting absent or `false`, behaviour is exactly the one-explicit-tap model Phases 1–5 deliver.

---

## 2. Target behaviour

After a streamer restart **or** a machine reboot, on the next boot:

- Every session the streamer interrupted appears in `GET /api/sessions` with its real metadata — `sessionName`, `projectPath`, `projectName`, `branch`, `promptCount`, `startedAt`, `provider`.
- It carries `status: "idle"`, `ownership: "historical"`, `ptyAttached: false`, `lifecycle: "resumable"`, `statusSource: "shutdown"`.
- Tapping it hits the existing `POST /api/sessions/resume` and gets a live PTY back on the same conversation, appending to the same JSONL.
- `GET /api/sessions/count` is unchanged — recovered sessions do not inflate the live-session badge.
- No new `SessionStatus` value, no renamed field, no changed endpoint. A client that ignores `lifecycle` sees exactly what it sees today for a historical conversation.

With Phase 6 enabled, a *server* restart additionally reconnects to still-live agents with byte-accurate replay, and those sessions report `lifecycle: "attached"` rather than `"resumable"`.

---

## 3. Data model changes

### 3.0 `managed_sessions` moves out of the cache database

Today `ManagedSessionsRepository` is constructed from `this.cache.getDatabase()` (`src/server.ts:1577`), so the durable session registry lives inside `~/.threadbase/cache/cache.db`. That is the wrong home, for three reasons of increasing severity.

**It is not derived data.** Everything else in `cache.db` — `conversation_meta`, tails, the message index, the scanner warm-up cache — is rebuildable from `~/.claude` and `~/.codex` at any time. `managed_sessions` is **authoritative**: nothing on disk can reconstruct `started_at`, `prompt_count`, `session_name`, the Codex rollout binding, or `status_source`. Losing it loses the only copy.

**It is named and treated as disposable.** `reset_rescan`'s `clearAll()` is currently scoped to the three conversation tables and does *not* touch `managed_sessions` — checked, not assumed. But the directory is called `cache/`, the integrity monitor offers a "reset and rescan" action, and "delete the cache and restart" is a completely reasonable thing to tell a user in a support thread. Session state must not be one plausible instruction away from deletion.

**A cache failure currently takes session persistence with it.** This is the decisive one and it is a live defect, not a hypothetical. In `listen()`, the repository is constructed *inside* the `try` block that opens the cache:

```ts
const db = this.cache.getDatabase();
…
this.managedSessionsRepo = new ManagedSessionsRepository(db);   // server.ts:1577
} catch (err) {
  // "ConversationCache failed to open — running WITHOUT cache … (degraded)"
```

The documented, recurring cause of that catch is a `better-sqlite3` ABI mismatch after a Node upgrade — the repo ships a preflight check and a `npm rebuild better-sqlite3` remedy for exactly this. When it fires, the server keeps running in degraded mode and `managedSessionsRepo` stays `null`, so `recordSessionSpawn`, `recordStatus` and `recordShutdownState` all silently no-op. **A conversation-cache problem currently disables session persistence entirely, with no separate signal.**

**The split.** A second SQLite file, `~/.threadbase/runtime.db` — a sibling of `server.yaml`, deliberately *not* under `cache/`:

| | `cache/cache.db` | `runtime.db` |
|---|---|---|
| Contents | conversations, tails, message index, warm-up cache | `managed_sessions` |
| Rebuildable | yes, from disk | **no** |
| Safe to delete | yes | no |
| Backed up by | `services/cache-integrity/backup.ts` | its own path (see below) |
| Opened by | `ConversationCache.open` | `RuntimeStore.open` (new) |

Concretely:

- New `src/db/runtime-store.ts` exporting `RuntimeStore.open(path)`, opening the file and running `runSqliteMigrations(db, runtimeMigrationsDir)` — the existing runner, pointed at a **separate** migrations directory `src/db/runtime-migrations/` with its own `schema_migrations` table inside the new file.
- `010_create_managed_sessions.sql` (and `015` below) move to that directory, renumbered from `001`.
- `ManagedSessionsRepository` takes the runtime handle instead of the cache handle; `ApiDeps` gains `runtimeStore: () => RuntimeStore | null`.
- The two opens become **independent**: a cache failure no longer nulls the registry, and a registry failure no longer breaks `/api/conversations`. Each logs its own error.
- `close()` closes both, and `recordShutdownState()` must run before *either* — today it is ordered against `cache.close()` alone (`src/server.ts:1915`).

**Build note.** `npm run build` copies `src/db/migrations/` and `src/db/pg-migrations/` into `dist/`. The new directory must be added to that copy step, and to the deploy payload — a missing migrations folder in a packaged CLI fails at first boot, not at build time.

**Data move.** `managed_sessions` is young and holds only live-ish state, so a one-time copy is optional rather than required. If it is done: on first open of `runtime.db`, if the table is empty and `cache.db` has one, copy the rows and leave the original in place (do not drop it — an older streamer rolled back onto the same machine still reads it). A second boot finds `runtime.db` non-empty and skips the copy. If it is not done, the cost is one boot of lost post-restart visibility.

### 3.1 Schema

One migration, additive.

### `src/db/runtime-migrations/002_add_managed_session_boot_token.sql`

(Numbered `002` because §3.0 moves `010_create_managed_sessions.sql` into the new directory as `001`. If §3.0 has not landed, this stays `015` in the shared directory.)

```sql
-- Which machine boot the pid in this row was recorded during.
--
-- managed_sessions.pid is only meaningful within one boot: pid assignment
-- restarts at boot, so a stored pid recorded under a previous boot no longer
-- identifies anything and probing it can hit an unrelated process that merely
-- inherited that number. When that process's argv happens to contain the
-- recorded cmdline token -- which for a FRESH Codex session is only the
-- project path -- the reconciler wrongly reports `detached` and claims a live
-- process that is not ours. A mismatch here skips the probe entirely.
ALTER TABLE managed_sessions ADD COLUMN boot_token TEXT;
```

Migrations are tracked in `schema_migrations` by `runSqliteMigrations` (`src/db/sqlite-migrate.ts`), so a bare `ALTER TABLE` applies exactly once. Nothing is backfilled: a NULL `boot_token` means "recorded before this column existed", which is treated the same as a mismatch (skip the probe → `resumable`) — the safe direction.

**No other schema change.** Phases 1, 3, 4 and 5 all work against columns that already exist. In particular `status_source = 'shutdown'` is already written by `recordShutdownState` (`src/server.ts:1348`) and is the exact signal for "the streamer stopped this, not the agent" — it was simply never read back.

**Still deliberately not persisted:** the 64 KiB output ring buffer, the xterm screen, `inputHistory`. Their authoritative copy is the provider JSONL; persisting them would turn every PTY chunk into a DB write. Phase 6 keeps them in the host process instead, which is where they can live cheaply.

---

## 4. Phases

Six phases, ten PRs. Each is independently revertible; the ordering constraint is only that **Phase 1 must land before Phase 5's diagnostics**, and **Phase 6a before 6b–6e**.

---

### Phase 0 — Move the registry out of the cache database *(PR 0)*

Implements §3.0. Lands **first**, before anything else reads or writes the registry, so no later phase has to be re-pointed at a different handle.

`src/db/runtime-store.ts` (`RuntimeStore.open`), `src/db/runtime-migrations/` with `001_create_managed_sessions.sql` moved across, `ManagedSessionsRepository` re-pointed, independent open/close/error paths in `listen()` and `close()`, build + deploy copy steps updated, optional one-time row copy.

No behaviour change beyond the decoupling: the same rows, the same reads, the same writes — in a file that a cache reset cannot reach and a cache failure cannot disable.

**Acceptance:** the registry survives deleting `~/.threadbase/cache/` entirely; a forced `ConversationCache.open` failure leaves `/api/conversations` degraded **and session persistence working**, each logging its own error; `npm run build` emits `dist/db/runtime-migrations/`; two consecutive boots do not re-copy rows.

---

### Phase 1 — Rehydrate interrupted sessions *(fixes G1, G2, G8; PR 1)*

The core fix. The registry already knows everything needed; nothing reads it back.

**New: `src/services/sessions/rehydrateSessions.ts`**

Pure functions, no DB — mirroring how `classifySession` is split out of `reconcileSessions` so the decision table is testable without a database.

```ts
export const REHYDRATE_MAX = 25;
export const REHYDRATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Should this registry row come back as a recovered session? */
export function shouldRehydrate(
  row: ManagedSessionRow,
  opts: { now: number; projectExists: (p: string) => boolean },
): boolean;

/** Registry row → an idle, non-attached ManagedSession stub. */
export function rowToStubSession(row: ManagedSessionRow): ManagedSession;
```

`shouldRehydrate` returns false when the project path no longer exists (a deleted worktree can never be resumed — `handleResume` would fail and `classifyResumability` already encodes this rule for conversations), when the row is older than `REHYDRATE_WINDOW_MS`, or when the row ended by the agent's own exit (`status_source IN ('exit','process-exit')` with no `failure_reason`) rather than by us stopping it.

**`ManagedSessionsRepository`** gains one prepared read:

```sql
SELECT * FROM managed_sessions
 WHERE (completed_at IS NULL OR status_source = 'shutdown')
   AND status_updated_at >= @since
 ORDER BY status_updated_at DESC
 LIMIT @limit
```

exposed as `listRecoverable({ sinceMs, limit }): ManagedSessionRow[]`.

**`ManagedSession` / `managedToResponse`** gain one internal marker: `rehydrated?: boolean` on `ManagedSession` (`src/types.ts`), and `managedToResponse` (`src/session-store.ts:199`) emits `ownership: "historical"` + `lifecycle: "resumable"` + `lifecycleSource: "reconcile"` when it is set, instead of the `"managed"` / `completed`-or-`failed` defaults it currently hardcodes.

Reusing the **existing** `historical` ownership value is what keeps this contract-free: the compatibility doc already defines it as "a cached conversation, no process known", which is precisely what a recovered stub is. `rehydrated` itself never reaches the wire.

**`StreamerServer`:**

- `src/server.ts:1581` — `void this.reconcilePreviousSessions()` becomes `void this.reconcilePreviousSessions().then((v) => this.rehydratePreviousSessions(v))`.
- New `private rehydratePreviousSessions(verdicts: ReconcileVerdict[]): void` — reads `listRecoverable`, filters through `shouldRehydrate`, calls `sessionStore.addManaged(rowToStubSession(row))`, and seeds `sessionLifecycles` with the reconciler's verdict when one exists, else `"resumable"`.
- Same method seeds `selfPtyEndedAt` from each row's `completed_at`, so a resume immediately after a restart is not misread by `conversationBusy` as a *foreign* collision (audit §3.2, R3 below).
- `handleSessionsCount` (`src/server.ts:2457`) filters `ownership !== "historical"` so the badge keeps meaning "sessions this streamer is running".

**Why stubs are safe.** They live only in `SessionStore`, never in `LiveSessionManager`. `reapIdleSessions` and `startGraceTimer` both iterate `ptyManager.listSessions()`, so neither can see them. `handleResume`'s `ptyManager.hasSession()` early-return falls through to a real spawn, and `addManaged` is keyed by id so the spawn overwrites the stub.

**Acceptance:** kill the streamer mid-session, restart it, `GET /api/sessions` lists the session with its name and project, `status: "idle"`, `lifecycle: "resumable"`; `POST /api/sessions/resume` brings it back live; `GET /api/sessions/count` is unchanged; a session whose project directory was deleted is not listed.

---

### Phase 2 — Reboot-safe reconciliation *(fixes G5, G10; PR 2)*

**New: `src/utils/bootToken.ts`**

```ts
/** Stable-within-one-boot machine identity. Computed once per process. */
export function currentBootToken(): string;
```

Linux: read `/proc/sys/kernel/random/boot_id` when readable — exact. Everywhere else: `String(Math.round((Date.now() - os.uptime() * 1000) / 10_000))`, bucketed to 10 s to absorb clock drift within a boot.

The bucket is imprecise on platforms where `os.uptime()` excludes suspend time, which can make the token drift *within* a single boot. That is acceptable because the failure is one-directional: a spurious mismatch downgrades a live session to `resumable`, which costs a byte-stream reattachment that Phase 6 has not shipped yet. A spurious *match* is the dangerous direction, and bucketing cannot produce one across a real reboot.

**`recordSpawn`** writes `boot_token: currentBootToken()`.

**`classifySession`** (`src/services/sessions/reconcileSessions.ts:54`) takes the current token and, before touching `isPidAlive`:

```ts
if (row.boot_token == null || row.boot_token !== currentBootToken) {
  return { sessionId, lifecycle: "resumable", reason: "recorded before this machine boot" };
}
```

This confines `detached` and `orphaned` to the only boot in which they can be true, and removes the `ps` cost for every pre-reboot row.

#### Why a stored marker rather than a derived comparison

The same signal is available with **no column and no migration**: `started_at < (Date.now() - os.uptime() * 1000)` means the session began before this boot. That option was considered and rejected. The two are equivalent in every normal case and diverge only on one:

| Situation | Stored marker (chosen) | Derived comparison |
|---|---|---|
| Ordinary reboot | `resumable` ✓ | `resumable` ✓ |
| Ordinary same-boot row | probe ✓ | probe ✓ |
| Suspend/resume uptime skew | mismatch → `resumable` (safe) | over-reports pre-boot (safe) |
| **Wall clock steps backward** (NTP correction after downtime, manual change, VM snapshot restore) | mismatch → `resumable` (safe) | **computed boot time moves back, an old row looks current, a stale pid is probed → possible false `detached`** |
| Linux | exact via `boot_id`, no clock involved | still clock-derived |

The marker is compared for **equality**, so any disturbance produces a mismatch, and a mismatch always means `resumable` — the harmless direction. The derived form is an **ordering** comparison between two clock readings, so a backwards clock step can flip it the dangerous way: claiming a live process the streamer does not own.

One additive `ALTER TABLE` to permanently remove the only case in this area where the streamer asserts something false about someone else's process is the right trade.

#### Transition window (accepted, one-time)

Every row already in `managed_sessions` when `015` applies has `boot_token = NULL`, which the branch above treats as a mismatch. So on the **first boot after the migration**, every pre-existing non-terminal row classifies `resumable` without a probe — including an agent that genuinely survived a crash minutes earlier and should have been `detached`.

This is accepted rather than mitigated. It happens once, it errs toward the safe verdict, and nothing is lost: the user taps resume, and `conversationBusy`'s pre-flight probe answers `409 CONVERSATION_BUSY` if the process really is still live. No process is signalled either way. Backfilling a token would be worse — it would fabricate a boot identity we cannot actually verify.

**Acceptance:** a registry row carrying a foreign `boot_token` classifies `resumable` without any pid probe, even when a live process exists at that pid with a matching argv token; a row with `boot_token IS NULL` behaves identically; within one boot the existing `detached` / `orphaned` / `resumable` decision table is unchanged (existing tests stay green).

---

### Phase 3 — Codex resume identity *(fixes G6; PR 3)*

Codex has no `--session-id`, so a fresh session is keyed by a local `randomUUID()` placeholder and its real rollout id arrives later as `boundConversationId` (`watchForCodexRollout`, `src/server.ts:4711`).

**`StartSessionOptions`** (`src/types.ts:523`) gains `resumeId?: string`.

**`CodexPtyRunner.doStart`** (`src/codex-pty-runner.ts:251`) spawns `codex resume <options.resumeId ?? sessionId>` while keeping `sessionId` as the map key. `PTYManager` ignores the field — Claude's session id is always resumable as-is.

This is the shape that preserves the mobile invariant: the live session keeps the `id` the client navigated to, so `conversationId === id` still holds; only the argv changes.

**`handleResume`** (`src/server.ts:3653`), when `findJsonlPath` / `findConversationByUuid` both come up empty, consults `managedSessionsRepo.get(sessionId)`. If the row is `codex-cli` with a `bound_conversation_id`, it resolves the project path and history from the bound id and passes it as `resumeId`.

**New: `src/services/sessions/resumeIdentity.ts`** — `resumeIdForRow(row): string | null`, returning `bound_conversation_id` for Codex, `session_id` for Claude, and `null` for a Codex row that never bound. `classifySession` uses it: a dead Codex process with no bound id is `failed` with reason *"Codex session ended before its rollout id was known"* rather than an unusable `resumable`, and `shouldRehydrate` skips it.

**G7 (weak `projectPath` token for unbound Codex) is deliberately not fixed here.** Phase 2 removes the case where it actually caused harm — a cross-reboot false `detached`. Within a single boot the token still proves "a process of ours in this project", which rejects an unrelated recycled pid. Tightening it further would require reading real argv on the session-start hot path, which the existing comment at `src/server.ts:1299` already rejects for latency. Recorded as accepted residual risk.

**Acceptance:** a fresh Codex session, restarted after binding, resumes from the placeholder id and the spawned argv carries the bound rollout id; a fresh Codex session that never bound is classified `failed` with an explanatory reason and is not offered as resumable.

---

### Phase 4 — Honest terminal verdicts + retention *(fixes G3, G4; PR 4)*

**`completed` becomes reachable without new I/O.** `classifySession`'s dead-pid branch currently calls an `endedCleanly` probe that is never supplied (`src/server.ts:1227`), so `?? false` makes every dead session `resumable`. Replace the missing probe with the evidence the registry already holds:

```ts
if (!probe.isPidAlive(row.pid)) {
  if (row.failure_reason != null) return { …, lifecycle: "failed", reason: "process gone, failure recorded" };
  return { …, lifecycle: "resumable", reason: "process gone, resumable from provider history" };
}
```

A JSONL-parsing cleanliness probe is **deliberately not built**: for a process that vanished without recording an exit, cleanliness is genuinely unknowable, and `resumable` is the honest answer. The `endedCleanly` hook stays in `ReconcileProbe` for a future provider that can answer it.

**Retention.** `ManagedSessionsRepository` gains:

- `pruneTerminal(olderThanMs: number): number` — `DELETE FROM managed_sessions WHERE completed_at IS NOT NULL AND completed_at < ?`. Called once at boot after reconciliation, default 30 days.
- `listNonTerminal()` gains a `LIMIT` (default 200) and the caller **logs when it truncates** — a silently capped probe set reads as "we checked everything" when it did not.

**Acceptance:** a boot against a registry holding 500 terminal rows older than 30 days prunes them and logs the count; `listNonTerminal` never returns more than the cap and logs when it clips; a dead session with a recorded `failure_reason` classifies `failed`, not `resumable`.

---

### Phase 5 — Observability and the interrupted-turn signal *(fixes G11, partially G12; PR 5)*

**`GET /api/diagnostics/sessions`** — a sub-route in `src/api/routes/diagnostics.routes.ts`, admin-scoped like the rest of `/api/diagnostics`, returning per row: `session_id`, `provider`, `status`, `status_source`, `boot_token` match, the reconcile verdict + reason, the rehydration decision + reason, and whether the project path still exists. Paths pass through the existing `redactPath` / `redactValue` helpers so the payload stays paste-into-a-bug-report safe.

Requires `managedSessionsRepo: () => ManagedSessionsRepository | null` on `ApiDeps` (`src/api/types/api-deps.ts`), following the existing `() => Repo | null` pattern used by every other repository there.

**Log events** (all structured, matching existing conventions):

| Event | When |
|---|---|
| `sessions.rehydrated` | boot, with counts by decision |
| `sessions.rehydrate_skipped` | per row, with reason (`project_missing`, `too_old`, `agent_exited`, `codex_unbound`) |
| `registry.pruned` | retention delete, with count |
| `registry.probe_truncated` | `listNonTerminal` hit its cap |
| `sessions.boot_token_mismatch` | probe skipped as pre-reboot |

**Interrupted-turn signal.** A stub's `status` is `idle`, which erases whether the session was mid-answer when we stopped it. Add one **additive optional** field to `SessionResponse`: `interruptedStatus?: "running" | "waiting_input"`, populated from the registry row's `status` only when `status_source = 'shutdown'`. Old clients ignore it; a new client can say *"interrupted mid-response"* instead of *"idle"*.

This needs a tb-mobile follow-up to be useful and a line in `docs/compatibility/tb-mobile.md` under *Session — new optional fields*. It is harmless if mobile never adopts it.

**G12 (in-flight gates) is not solved here.** A resumed session re-enters an unknown gate state, and the live detectors in `detectLivePrompts` / `detectScreenState` re-derive it from the rendered screen within one quiet-check cycle. Persisting `pendingQuestions` would mean persisting a `toolUseId` the *new* process has never issued, which is worse than re-detecting. Documented, not built.

**Acceptance:** `GET /api/diagnostics/sessions` returns a redacted row per registry entry with its verdict and rehydration reason; a boot with rehydration active emits exactly one `sessions.rehydrated` with counts; a session interrupted mid-turn reports `interruptedStatus: "running"`.

---

### Phase 6 — `pty-host`: true continuity across a server restart *(PRs 6–10)*

The only way to keep an agent alive through a streamer restart is for the PTY master fd to be held by a process that is not being restarted. This is alternative D from [the architecture doc](../architecture/2026-07-24-durable-session-runtime.md#d-dedicated-pty-daemon-separate-supervised-process), now sequenced.

Gated behind a `ptyHost` feature flag (`src/feature-flags.ts`), **default off**. Boot-time resolution means flipping it back is a restart, same as every other startup-resolved setting.

**It changes nothing about a machine restart.** After a reboot the host is gone too, and Phases 1–5 are still what recovers the session.

#### PR 6 — 6a: protocol + runner seam

Define the line protocol (`spawn`, `write`, `keys`, `resize`, `subscribe`, `replay`, `input-history`, `cancel`, `kill`, `status`, plus `output` / `status-change` / `exit` events) and add `RemoteSessionRunner implements SessionRunner` (`src/types.ts:550`). No behaviour change: `LiveSessionManager` still constructs in-process runners. Ships as pure additive code with unit tests against an in-memory transport.

#### PR 7 — 6b: the host process

`tb-streamer pty-host --socket <path>` subcommand in `cli/index.ts`. The streamer spawns it via `spawn(process.execPath, [...], { detached: true, stdio: "ignore" })` + `unref()`, so it is neither in the streamer's process group nor holding its stdio.

The host owns everything the audit lists as lost: node-pty, the 64 KiB ring buffer, the xterm screen, `inputHistory`, `pendingReady`, `queuedInputs`, and the prompt/gate detectors. The idle reaper must run **inside the host**, or an abandoned host keeps PTYs forever.

Socket: `~/.threadbase/run/pty-host-<instanceId>.sock` (POSIX) / `\\.\pipe\threadbase-pty-host-<instanceId>` (Windows).

#### PR 8 — 6c: reconnect on boot

The streamer reconnects by socket path at startup, re-adopts live sessions, and reports `lifecycle: "attached"` with `lifecycleSource: "reconcile"` — the first time that value is reachable after a restart (audit G10). `terminal_replay` is served from the host's screen, restoring byte-accurate replay for this path only.

Rehydration (Phase 1) becomes the fallback for whatever the host could not keep. The two must agree: a session the host still owns must never also appear as a `historical` stub.

#### PR 9 — 6d: supervision

Version handshake (a host built from a different streamer version is killed and respawned rather than driven), heartbeat, orphan-host reaping when no registry row references it, and a `tb-streamer prod doctor` check that reports host liveness and version.

#### PR 10 — 6e: Windows / ConPTY qualification

`SETSID` and controlling-terminal hangup are POSIX semantics; ConPTY teardown differs. Assert **observed** behaviour on Windows rather than assuming parity, and document whichever way it resolves — including "the host buys nothing on Windows", if that is the answer.

**Acceptance (phase):** with `ptyHost` on, `tb-streamer prod restart` mid-turn leaves the agent running; the restarted streamer reconnects, reports `lifecycle: "attached"`, and replays the pre-restart bytes; with the flag off, behaviour is byte-identical to Phase 5; a machine reboot still lands on the Phase 1 recovery path.

---

### Phase 7 — Opt-in auto-resume on boot *(PRs 11–12)*

Only phase in which the streamer starts an agent nobody asked for in that moment. Off unless the user has said yes.

#### 7a — the setting *(PR 11)*

`server.yaml` gains one line, read by the same single-line-regex loader as every other key (`src/auth.ts`):

```yaml
auto_resume_on_boot: false
```

- `loadAutoResumeOnBoot(): boolean | undefined` in `src/auth.ts`, matching `/^auto_resume_on_boot:\s*(true|false)\s*$/m`. **Tri-state on purpose**: `undefined` means "the user has never been asked", which is what drives the prompt in 7b. It is not the same as `false`.
- `setAutoResumeOnBoot(v: boolean)` via the existing `setConfigValue` helper, alongside `setDefaultPermissionMode`.
- `ServerConfig.autoResumeOnBoot?: boolean`, resolved at boot like every other startup setting. Precedence: explicit `ServerConfig` → `server.yaml` → **`false`**.
- Not a feature flag. Feature flags gate behaviour *we* are unsure about; this is a user preference with a persisted answer, which is the `default_permission_mode` shape, not the `codexSystemPrompt` shape.

**Ride-along: `default_model` and `default_effort` get the same treatment.**

They have no home in `server.yaml` today, so the only way to pin them per-server is `claude_extra_args` — and that is load-bearing config sitting in a slot documented as an unvalidated escape hatch. It silently reverts:

```ts
// src/server.ts:2153 — setClaudeFlagsConfig()
setClaudeExtraArgs(extraArgs);   // called UNCONDITIONALLY
```

```ts
// src/auth.ts:156 — setConfigValue()
if (value === undefined) { /* the line is removed from server.yaml */ }
```

So a `PUT /api/config/claude-flags` that omits `extraArgs` passes `undefined`, the `claude_extra_args:` line is **deleted**, and the next spawn quietly falls back to `--model sonnet --effort low`. There is a forensic trail (`config.claude_flags_updated` logs `previousExtraArgs`) but no user-visible signal — verified in code, not inferred.

The fix is `loadDefaultModel()` / `loadDefaultEffort()` in `src/auth.ts`, mirroring `loadDefaultPermissionMode()` (`src/auth.ts:120-131`) exactly, with the fallback wired where `opts.defaultModel` / `opts.defaultEffort` are read in `cli/index.ts`. Roughly 20 lines, and it: survives any claude-flags write (different key), survives redeploy (`deploy.sh` regenerates the plist, not `server.yaml`), sits beside `default_permission_mode` where it is discoverable, and returns `claude_extra_args` to being an escape hatch.

It rides **PR 11** rather than getting its own, because PR 11 is already building precisely this — a `server.yaml` loader beside `default_permission_mode` — and a parallel mechanism for the same shape would be worse than one shared one. Unlike `auto_resume_on_boot` these need **no prompt**: absent simply means "fall through to the CLI default", so the loaders are plain optional reads.

#### 7b — the first-run question *(PR 11)*

**Where this goes, and why not the installer.** The request was to ask during install. Two of the three install paths cannot reliably ask:

| Install path | Interactive? |
|---|---|
| `npm install -g @threadbase-sh/streamer` | No — `postinstall` frequently runs without a TTY, and npm may hide or discard its output |
| `brew install …` | No — formula installation must be non-interactive by policy |
| `scripts/deploy.sh` (cloned repo) | **Yes** — already prompts for shim install and PATH update |

So the question lives where the codebase already puts exactly this kind of question: **the first interactive `serve` run**, next to `interactivePermissionModePrompt` (`src/lifecycle/prompt.ts`). That path is reached by all three install methods, which the installer is not. `scripts/deploy.sh` additionally asks during install, since it *can* — writing the answer before first boot so `serve` finds the key present and stays silent.

**Trigger: the `auto_resume_on_boot` key is absent from `server.yaml`.**

**Persisting the answer is what makes this safe, and it is the whole mechanism.** Both answers write the key — `yes` writes `true`, `no` writes `false`. The next boot finds it present and never asks again. The prompt is therefore self-terminating: **asked at most once per machine, ever.**

An earlier revision triggered on the *file* being absent instead, to avoid interrupting existing installs. That was dropped for two reasons:

1. **It could not work as written.** `loadOrCreateApiKey()` creates `server.yaml` at `cli/index.ts:196`, before the prompt at `:226`. By prompt time the file always exists, so an `existsSync(configFile())` check there is dead code. Making it work required snapshotting existence before the api-key call and threading the boolean forward — machinery that keying on the value does not need at all.
2. **It left every existing install silently defaulted** to `false` with no way to discover the setting. Since answering `no` writes the key anyway, the file-absent trigger bought nothing that persistence does not already provide.

Full condition — every clause must hold:

| # | Clause |
|---|---|
| 1 | `loadAutoResumeOnBoot() === undefined` — the key is absent. Present-and-`false` is a real answer and is never re-asked |
| 2 | `THREADBASE_SKIP_AUTO_RESUME_PROMPT !== "true"` |
| 3 | A real TTY, human `serve` invocation — **never** under `--prod`, launchd, systemd or Task Scheduler. A supervised service must never block on stdin |

Non-TTY, skipped, declined, or any failure all resolve to `false`. **There is no path where silence enables it.**

**One remaining gap: a `--prod`-only machine never sees a TTY**, so the key stays absent and the operator has no way to learn the setting exists. Covered by a single boot-time info line, emitted only when the key is absent and the prompt did not run:

```
auto_resume_on_boot is not set; interrupted sessions will wait for you to resume them.
Set `auto_resume_on_boot: true` in ~/.threadbase/server.yaml to resume them automatically.
```

One line, at info level, on a path that already logs several startup lines.

```
Resume interrupted sessions automatically when the streamer starts?
  [n] No — show them in the list and let me tap to resume (default)
  [y] Yes — re-attach them automatically on boot

Note: yes means agents can start without you present, including after a reboot.
Choice [y/N]:
```

#### 7c — the resume flow *(PR 12)*

Runs after Phase 1's rehydration, reusing its row set. A row is eligible only if **all** hold:

1. `status_source = 'shutdown'` — we stopped it; an agent that exited on its own is finished.
2. `status` was `running` or `waiting_input` at shutdown.
3. `status_updated_at` within `AUTO_RESUME_WINDOW_MS` (15 minutes) — a restart, not last week.
4. The project directory still exists.
5. Provider resume identity is available (`resumeIdForRow`, Phase 3).

Then: extract the spawn path `handleResume` uses into a shared `resumeSession()` so both callers hit the same collision probe, and drive it with a concurrency cap of **2**, a stagger between spawns, and a hard ceiling of `AUTO_RESUME_MAX` (5) per boot. Anything beyond the ceiling is left for the user and **logged**, never silently dropped.

`force` is **never** passed. `conversationBusy`'s pre-flight still applies, so a conversation an external terminal has already picked up is skipped with a logged reason rather than fought over.

**Acceptance:** with the key absent, the first interactive `serve` asks once; answering `no` writes `auto_resume_on_boot: false` and a second run does not re-ask; answering `yes` writes `true`; an install whose `server.yaml` predates the feature is asked once on its next interactive run; under `--prod` it never asks, resolves `false`, and emits the discoverability line; with `false`, no session is auto-resumed and Phase 1 behaviour is unchanged; with `true`, eligible sessions resume within the cap, ineligible ones are logged with a reason, a busy conversation is skipped rather than forced, and the ceiling overflow is reported.

---

## 5. tb-mobile compatibility strategy

The governing constraint, from audit §6: **no new `SessionStatus` value**. `VALID_STATUSES` (`src/server.ts:5074`) rejects unknown values in `?status=` and `SessionStore.paginate` drops sessions outside the requested set, so a new status string makes recovered sessions *vanish* from already-shipped clients — including the updater's own `countActiveSessions` probe.

| Need | Mechanism | Contract impact |
|---|---|---|
| "this session was interrupted, not finished" | existing `lifecycle: "resumable"` + `statusSource: "shutdown"` | none — both already on `SessionResponse` |
| "no process behind this" | existing `ownership: "historical"` | none — already documented |
| "not streamable" | existing `ptyAttached: false` | none |
| "was mid-answer" | **new optional** `interruptedStatus` (Phase 5) | additive; needs a `docs/compatibility/tb-mobile.md` entry |
| Codex placeholder resume | `resumeId` is **internal** to `StartSessionOptions`; the wire keeps `id` and `boundConversationId` | none — `conversationId === id` preserved |

Everything else — endpoint paths, field casing, WS event strings, `Authorization: Bearer` + `/ws?key=`, `tb_<32-hex>` key format — is untouched. `__tests__/contracts/mobile-contracts.test.ts` is the gate.

---

### 5.1 tb-mobile readiness — verified, not assumed

Checked against `~/dev/ai-tools/tb-mobile` on 2026-07-30.

**Already compatible.** `types/api.ts:66` declares `ownership?: 'managed' | 'external' | 'historical'` and documents `historical` as *"a resumable shape reconstructed from disk"* — which is exactly what a Phase 1 stub is. Mobile renders and resumes recovered sessions with **no changes at all**. `lifecycle`, `statusSource` and `interruptedStatus` are absent from mobile's types and are simply ignored, which is the intended additive behaviour.

**One real gap, one clause to fix it.** `utils/terminalSession.ts:19-31`:

```ts
export function isTerminalSession(session: TerminalSessionShape): boolean {
  const { ptyAttached, status, promptCount, lastOutput } = session
  if (status === 'completed' || status === 'failed') return true
  return (
    ptyAttached === false &&
    (status === 'idle' || status === 'on_hold') &&
    (promptCount ?? 0) === 0 &&      // ← a recovered stub fails here
    !lastOutput
  )
}
```

A recovered stub carries a real `promptCount` (that is the point — it is why the row is worth showing), so `isTerminalSession` returns false.

**Corrected 2026-07-31, verified against the running streamer.** An earlier version of this paragraph claimed mobile then "waits on the WebSocket for output that will never arrive… the result is a spinner". That does not happen. The stream subscription is gated on `ptyAttached === true` *before* `isTerminalSession` is consulted (`app/session/[id].tsx:562`):

```ts
const isLiveForStream =
  session?.ptyAttached === true &&
  (session?.status === 'waiting_input' || session?.status === 'running') &&
  !(session != null && isTerminalSession(session))
```

A stub reports `ptyAttached: false`, so the first clause already fails and no stream is opened. The real symptom is narrower: the session falls through to the `noAttachEmptyPlaceholder && status === 'idle'` branch (`app/session/[id].tsx:1014`) and renders **"Running elsewhere"** — a false claim about a session nobody is running. A wrong label, not a hang.

Recovered sessions therefore render *and resume* on already-shipped clients: a stub matches the redirect at `app/session/[id].tsx:579` (`ptyAttached === false && status === 'idle' && hasConversation && id is a UUID`), so mobile sends it to `/conversation/{id}` — which resolves `200` with real history and `resumable: true`, and whose screen implements the full `POST /api/sessions/resume` flow including the soft-409 collision dialog. Verified against all five recovered sessions on the deployed instance. M1's residual value is the pre-redirect frame and the case where a stub has no `conversationId` (no redirect fires).

Historical *conversations* avoid this today only because they arrive through the `ProjectChat` discriminated union's `type: "conversation"` branch. A **session-shaped** historical row is a genuinely new case that this plan introduces.

Fix: treat `ownership === 'historical'` as terminal regardless of `promptCount`.

**Mobile work, total:**

| PR | Scope | Blocking? |
|---|---|---|
| M1 | `isTerminalSession` accepts `ownership === 'historical'` | **No** — corrective, not gating. Originally marked blocking on the spinner claim corrected above; streamer PR 1 was never gated on mobile |
| M2 | Adopt `interruptedStatus` to label "interrupted mid-response" | No — cosmetic, only if Phase 5 ships the field |

There is no separate tb-mobile plan document, and the streamer plan is deliberately shaped so one is not required. M1 is a one-clause change, not a feature.

---

## 6. Migration and rollback

**Migration.** One additive `ALTER TABLE` (`015`), applied once via `schema_migrations`. No backfill, no data rewrite, no table altered other than `managed_sessions`. An older streamer running against a newer database is unaffected: `ManagedSessionRow` reads named fields, so an extra column is inert.

**Rollback, per phase:**

| Phase | Revert cost |
|---|---|
| 1 | Single commit. Stubs are read-only additions to an in-memory map; reverting restores today's empty-list behaviour. |
| 2 | Single commit. The column can stay; `classifySession` reverts to probing unconditionally. |
| 3 | Single commit. `resumeId` defaults to `sessionId`, so reverting restores today's argv exactly. |
| 4 | Single commit. Retention is delete-only against already-terminal rows; nothing live is touched. |
| 5 | Single commit. Diagnostics route and one optional field. |
| 6 | Flag off → in-process runners, byte-identical to Phase 5. Full revert is PRs 10→6 in reverse. |

**Ordering constraints:** Phase 5's diagnostics reads Phase 1's rehydration decisions. Phase 6a precedes 6b–6e. Phases 2, 3, 4 are mutually independent and can land in any order after Phase 1.

---

## 7. Rollout

| Flag | Default | Gates |
|---|---|---|
| `sessionRehydration` (flag) | **on** | Phase 1's recovered-session stubs in `/api/sessions`. Shipped on, with a kill switch, because it changes what the list contains. |
| `ptyHost` (flag) | **off** | Phase 6. Off until Windows behaviour is qualified (6e). |
| `auto_resume_on_boot` (**server.yaml**, not a flag) | **false** | Phase 7. A user preference with a persisted answer, so it belongs beside `default_permission_mode` rather than in the feature-flag registry. Absent means "never asked" and triggers the one-time prompt (7b). |

Both go in the existing registry (`src/feature-flags.ts`), get an env var (`THREADBASE_FEATURE_SESSION_REHYDRATION`, `THREADBASE_FEATURE_PTY_HOST`), and resolve at boot like every other flag. Phases 2–5 are pure correctness fixes and need no flag.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Recovered stubs flood the session list on a machine with months of history | `REHYDRATE_MAX` = 25, `REHYDRATE_WINDOW_MS` = 7 days, skip rows whose project directory is gone; log what was dropped |
| R2 | `/api/sessions/count` inflated by stubs, breaking the mobile badge and the updater's active-session probe | Stubs are `ownership: "historical"`; `handleSessionsCount` filters them out. The updater queries `?status=running,waiting_input`, which stubs (`idle`) never match |
| R3 | Spurious `409 CONVERSATION_BUSY` on the first resume after a restart, because `selfPtyEndedAt` was lost | Phase 1 seeds `selfPtyEndedAt` from each row's `completed_at` |
| R4 | A stub masks a genuinely live external process for the same conversation (`SessionStore.list` prefers `managed` over `discovered`) | Accepted and tested: the reconciler verdict carries the truth (`detached`), and `ptyAttached: false` is correct either way |
| R5 | `boot_token` drifts within one boot on platforms where `os.uptime()` excludes suspend | One-directional failure: a mismatch downgrades to `resumable`, never claims a live process. Linux uses the exact `boot_id` |
| R6 | Codex `resumeId` binds the wrong rollout | Reuses `watchForCodexRollout`'s existing cwd + creation-timestamp guards; covered by `__tests__/codex-resume.test.ts` |
| R7 | Phase 6: an orphaned host keeps PTYs alive forever | Idle reaper runs inside the host; PR 9 adds heartbeat + orphan reaping keyed on registry references |
| R8 | Phase 6: version skew between streamer and a host from an older release | Version handshake; mismatched host is killed and respawned rather than driven |
| R9 | Phase 6 turns one process into two to install, supervise and diagnose | Default off, `prod doctor` coverage, and the flag reverts ownership with a restart |
| R10 | Registry write volume | Unchanged — writes already happen per transition. Phases 1–5 add one indexed read at boot plus one delete |
| R11 | Auto-resume starts agents unattended at login, with `bypassPermissions` in force | Off by default; every non-answer resolves to `false`; the prompt names the consequence explicitly (7b) |
| R12 | Auto-resume storms on a machine with many interrupted sessions | 15-minute window, concurrency cap 2, ceiling of 5 per boot, overflow logged not dropped (7c) |
| R13 | Auto-resume fights an external terminal for a conversation | Reuses `conversationBusy`; `force` is never passed; skips are logged (7c) |
| R14 | The first-run prompt blocks a supervised service on stdin | TTY-only, never under `--prod`/launchd/systemd/Task Scheduler; `THREADBASE_SKIP_AUTO_RESUME_PROMPT` escape hatch (7b) |
| R17 | The prompt fails to persist a `no`, so it re-asks every interactive run | Both answers write the key; asserted by test (7b) |
| R18 | A `--prod`-only machine never sees a TTY, so the operator never learns the setting exists | One boot-time info log when the key is absent and the prompt did not run (7b) |
| R15 | The `runtime.db` split leaves migrations uncopied in a packaged CLI, failing at first boot rather than at build | Add `src/db/runtime-migrations/` to the build copy step and the deploy payload; asserted by test (§3.0) |
| R16 | An older streamer rolled back onto the same machine reads the now-stale `managed_sessions` in `cache.db` | The one-time copy leaves the original table in place rather than dropping it (§3.0) |

---

## 9. Test plan

Run `npm run lint && npm test` under the `.nvmrc` Node version (`better-sqlite3` ABI).

### Modify

| File | Coverage added |
|---|---|
| `__tests__/reconcile-sessions.test.ts` | boot-token mismatch skips the probe; NULL token treated as mismatch; `failure_reason` → `failed`; Codex row with no `bound_conversation_id` → `failed`; existing same-boot decision table unchanged |
| `__tests__/managed-sessions-repository.test.ts` | `listRecoverable` window/limit/ordering; `boot_token` round-trip; `pruneTerminal` count and that it never deletes a non-terminal row; `listNonTerminal` cap |
| `__tests__/session-registry-persistence.test.ts` | a shutdown write stays *recoverable* (the regression that Phase 1 exists to prevent) |
| `__tests__/codex-resume.test.ts` | resume by placeholder id spawns `codex resume <boundId>`; the returned session keeps `id === placeholder` |
| `__tests__/codex-pty-runner.test.ts` | `resumeId` reaches argv; absent `resumeId` is byte-identical to today |
| `__tests__/db/migrations.test.ts` | `015` applies once and is idempotent across two runs |
| `__tests__/server.test.ts` | `/api/sessions` includes recovered stubs; `/api/sessions/count` excludes them; `?status=` filtering unaffected |
| `__tests__/diagnostics.test.ts` | `/api/diagnostics/sessions` shape, admin scoping, path redaction |
| `__tests__/feature-flags.test.ts` | `sessionRehydration` (default on) and `ptyHost` (default off) resolve through the full precedence chain |
| `__tests__/contracts/mobile-contracts.test.ts` | no new `SessionStatus` value; `interruptedStatus` is optional |
| `__tests__/session-store.test.ts` | `rehydrated` → `ownership: "historical"` + `lifecycle: "resumable"` in `managedToResponse` |

### Add

| File | Covers |
|---|---|
| `__tests__/session-rehydration.test.ts` | `shouldRehydrate` decision table (project missing, too old, agent-exited, Codex unbound); `rowToStubSession` field mapping; cap and ordering; stub invisible to `reapIdleSessions` and `startGraceTimer`; resume overwrites the stub; `selfPtyEndedAt` seeding |
| `__tests__/boot-token.test.ts` | stability within a process; Linux `boot_id` path; bucketing tolerance |
| `__tests__/runtime-store.test.ts` | §3.0 — `RuntimeStore.open` runs its own migrations into its own `schema_migrations`; registry survives deleting `cache.db`; a forced cache-open failure leaves persistence working; one-time row copy is idempotent across two boots and does not drop the source table |
| `__tests__/auto-resume-config.test.ts` | `loadAutoResumeOnBoot` tri-state (absent vs `false`); `setAutoResumeOnBoot` round-trip through `server.yaml`; precedence `ServerConfig` → yaml → `false`. Also `loadDefaultModel` / `loadDefaultEffort`: absent falls through to the CLI default, and **a `PUT /api/config/claude-flags` that omits `extraArgs` no longer changes the resolved model or effort** — the silent-revert regression |
| `__tests__/auto-resume-prompt.test.ts` | **answering `no` writes `auto_resume_on_boot: false`, and a second run does not re-ask** — the property the whole trigger rests on; `yes` writes `true`; asked when the key is absent regardless of whether the file already existed; never under `--prod` or a non-TTY; `THREADBASE_SKIP_AUTO_RESUME_PROMPT` honoured; every non-answer resolves `false`; the discoverability log fires only when the key is absent and the prompt did not run; `THREADBASE_CONFIG_DIR` redirection honoured |
| `__tests__/auto-resume-on-boot.test.ts` | eligibility rules 1–5; concurrency cap and per-boot ceiling with overflow logged; `force` never passed; busy conversation skipped with a reason; `false` reproduces Phase 1 behaviour exactly |
| `__tests__/resume-identity.test.ts` | `resumeIdForRow` across both providers, bound and unbound |
| `__tests__/pty-host-protocol.test.ts` | PR 6 — protocol round-trip over an in-memory transport |
| `__tests__/pty-host-survival.test.ts` | PRs 7–8 — host outlives the streamer; reconnect adopts the session; replay is byte-accurate. Sibling of `pty-parent-exit-hangup.test.ts` |

### The nightly restart is a free validation harness

This machine already runs the exact failure this plan addresses, on a schedule. `~/Library/LaunchAgents/com.ronen.threadbase-nightly-restart.plist`:

```
ProgramArguments = /bin/launchctl kickstart -k gui/501/com.ronen.threadbase
StartCalendarInterval = { Hour = 4, Minute = 0 }
```

`-k` kills before restarting, so **every live PTY dies at 04:00 daily** and the streamer comes back with an empty `SessionStore`. Three consequences worth having written down:

- **Phase 1 rehydration gets exercised every night against real state**, with real `session_name`, `prompt_count` and project paths — not a synthesized fixture. After PR 1 lands, "were yesterday's sessions listed this morning?" is a daily regression check that costs nothing to run.
- **Phase 7 auto-resume has concrete daily value here**, not just theoretical value after a crash: 04:00 restart plus `auto_resume_on_boot: true` is the difference between finding your sessions gone and finding them waiting.
- **`pty_grace_period_ms` beyond about a day is unreachable on this machine.** A 7-day hold value can never be exercised past one night, which is worth knowing before tuning it or writing a test that assumes it.

The job's purpose is undocumented (memory, leaked handles, log rotation are all plausible), so **do not remove or reschedule it to make testing easier** — treat it as a fixed property of the environment and let Phase 7 make it survivable.

### Do not weaken

`__tests__/pty-parent-exit-hangup.test.ts` pins the `SIGHUP`-on-master-fd-close behaviour that the entire feasibility argument rests on. If a node-pty upgrade changes it, this must fail loudly rather than be relaxed.

---

## 10. PR checklist

- [ ] **PR 0** — Phase 0: `RuntimeStore`, `src/db/runtime-migrations/`, registry re-pointed off the cache handle, independent open/close/error paths, build + deploy copy steps, optional one-time row copy
- [ ] **PR 1** — Phase 1: `rehydrateSessions.ts`, `listRecoverable`, `rehydrated` marker, boot wiring, `handleSessionsCount` filter, `selfPtyEndedAt` seeding, `sessionRehydration` flag
- [ ] **PR 2** — Phase 2: migration `015`, `bootToken.ts`, `recordSpawn` writes the token, `classifySession` skips pre-reboot probes
- [ ] **PR 3** — Phase 3: `resumeId` on `StartSessionOptions`, `CodexPtyRunner` argv, `resumeIdentity.ts`, `handleResume` registry fallback
- [ ] **PR 4** — Phase 4: `failure_reason` → `failed`, `pruneTerminal`, `listNonTerminal` cap + truncation log
- [ ] **PR 5** — Phase 5: `/api/diagnostics/sessions`, log events, `interruptedStatus`, compatibility-doc entry
- [ ] **PR 6** — Phase 6a: pty-host protocol + `RemoteSessionRunner`
- [ ] **PR 7** — Phase 6b: `pty-host` subcommand, detached spawn, socket/pipe transport, in-host idle reaper
- [ ] **PR 8** — Phase 6c: boot reconnect, `lifecycle: "attached"` across restart, byte-accurate replay
- [ ] **PR 9** — Phase 6d: version handshake, heartbeat, orphan reaping, `prod doctor` check
- [ ] **PR 10** — Phase 6e: Windows / ConPTY qualification, `ptyHost` default decision
- [x] **PR M1** *(tb-mobile, independent of PR 1)* — `isTerminalSession` treats `ownership === 'historical'` as terminal (see §5.1). Landed as tb-mobile `16987b0c` on 2026-07-31. Not a gate on any streamer PR.
- [ ] **PR 11** — Phase 7a/7b: `auto_resume_on_boot` in `server.yaml`, loader + writer, `ServerConfig` field, first-run TTY prompt, `scripts/deploy.sh` install-time question, skip env var. ~~**Ride-along:** `loadDefaultModel()` / `loadDefaultEffort()` in `src/auth.ts` + `cli/index.ts`, closing the `claude_extra_args` silent revert (7a)~~ — **dropped:** #306 made `model` and `effort` first-class claude-flags with their own persisted key, so PR 11 no longer needs to carry them (see `docs/2026-07-30-session-review-consolidation.md` §8)
- [ ] **PR 12** — Phase 7c: shared `resumeSession()`, eligibility rules, caps and ceiling, logged skips
- [ ] **PR M2** *(tb-mobile, optional, after PR 5)* — adopt `interruptedStatus` for the "interrupted mid-response" label

Each PR: conventional-commit title, tests in the same PR, `npm run lint && npm test` green, and — for anything touching `SessionResponse` — a `docs/compatibility/tb-mobile.md` update in the same commit.
