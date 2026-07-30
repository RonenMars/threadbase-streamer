# Live sessions persistence — implementation kick-off

**Date:** 2026-07-30
**For:** the implementation sequence in [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md). **Start at PR 0.**

---

## Documents in this worktree

| File | What it is |
|---|---|
| [live-sessions-persistence-audit.md](./live-sessions-persistence-audit.md) | What survives a restart today, and the gaps `G1`–`G12` |
| [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md) | Phases 0–7, twelve PRs. The plan of record |
| this file | How to start, and the paste-ready prompts for PR 0 and PR 1 |
| [session-source-visibility-and-control.md](./session-source-visibility-and-control.md) | **Separate feature stream** — session source, stop and overtake. Own PRs. See the collision note below |
| [codex-source-visibility-investigation-prompt.md](./codex-source-visibility-investigation-prompt.md) | Research prompt for the Codex equivalent of that spec |

---

## Branching

The planning documents live on `plan/live-sessions-persistence` and are **not** a prerequisite for the code. Each implementation PR branches from the current integration branch, in its own worktree:

```bash
/opt/homebrew/bin/git worktree add -b feat/runtime-db-split \
  ~/dev/ai-tools/tb-streamer-worktrees/feat-runtime-db-split \
  integration/missing-prs-2026-07-23
```

**Why not branch off `plan/live-sessions-persistence`:** the docs there are still uncommitted, so a branch cut from that worktree would carry them into the implementation diff. Basing on the integration branch keeps each PR a code-only change that merges in either order relative to the docs PR. If the docs land first, rebase onto the updated integration branch — one PR at a time, rebase, squash-merge.

Every subsequent PR gets its own worktree off the *then-current* integration branch, never off its predecessor, unless the plan explicitly stacks them (only Phase 6a → 6b–6e).

---

## Order matters: PR 0 first

**PR 0 (Phase 0) moves `managed_sessions` out of `cache.db` into its own `runtime.db`.** Every later phase reads or writes that registry, so it has to move before they are written — otherwise PR 1's `listRecoverable`, PR 2's `boot_token` migration and PR 4's retention all get authored against the cache handle and then re-pointed.

It is also the only PR that fixes a live defect rather than adding behaviour: today `ManagedSessionsRepository` is constructed inside the `try` block that opens the conversation cache, so a `better-sqlite3` ABI mismatch — the documented, recurring failure this repo ships a preflight and a `npm rebuild` remedy for — silently disables **all** session persistence while the server keeps running. Plan §3.0 has the detail.

---

## Paste-ready prompt for PR 0

```
Implement PR 0 of the live-sessions-persistence plan.

Worktree: create your own, do not work in the repo root:
  /opt/homebrew/bin/git worktree add -b feat/runtime-db-split \
    ~/dev/ai-tools/tb-streamer-worktrees/feat-runtime-db-split \
    integration/missing-prs-2026-07-23

Read first, from the plan worktree at
~/dev/ai-tools/tb-streamer-worktrees/plan-live-sessions-persistence:
  docs/plans/live-sessions-persistence-plan.md   (section 3.0 and Phase 0)
  docs/plans/live-sessions-persistence-audit.md  (section 3, state inventory)

Scope — PR 0 only. No rehydration, no boot_token, no behaviour change.
  1. src/db/runtime-store.ts — RuntimeStore.open(path): opens the file and runs
     runSqliteMigrations(db, runtimeMigrationsDir). Reuse the existing runner;
     it gets its own schema_migrations table inside the new file.
  2. src/db/runtime-migrations/001_create_managed_sessions.sql — moved from
     src/db/migrations/010_create_managed_sessions.sql, renumbered. Keep the
     header comment; it explains why the byte stream is deliberately not stored.
  3. ManagedSessionsRepository takes the runtime handle, not cache.getDatabase().
  4. server.ts: open the runtime store INDEPENDENTLY of the cache, in its own
     try/catch with its own error log. A cache failure must no longer null the
     registry, and a registry failure must not break /api/conversations.
  5. close(): close both. recordShutdownState() must still run before either —
     it is currently ordered against cache.close() alone (server.ts:1915).
  6. ApiDeps gains runtimeStore: () => RuntimeStore | null, following the
     existing () => Repo | null pattern.
  7. Build + deploy: add src/db/runtime-migrations/ to the copy step alongside
     src/db/migrations/ and src/db/pg-migrations/. A missing migrations folder
     in a packaged CLI fails at a user's first boot, not at build time.
  8. Optional one-time row copy on first open of runtime.db: if its table is
     empty and cache.db has one, copy the rows and LEAVE THE ORIGINAL in place
     (an older streamer rolled back onto the same machine still reads it).

Path: ~/.threadbase/runtime.db — sibling of server.yaml, deliberately NOT under
cache/. Honour THREADBASE_CONFIG_DIR the way the rest of the config does.

Hard constraints:
  - No wire change. No new endpoint, field, or status value. This PR is
    invisible to any client.
  - The registry must survive `rm -rf ~/.threadbase/cache`.

Tests in the same PR: new __tests__/runtime-store.test.ts covering its own
migrations table, survival of a deleted cache.db, a forced cache-open failure
leaving persistence working, and an idempotent non-destructive row copy across
two boots. Plus the existing managed-sessions-repository and
session-registry-persistence tests re-pointed at the new handle.

Done = every Phase 0 acceptance criterion in the plan passes, and
`npm run lint && npm test` is green under the .nvmrc Node version.

Show me the staged diff and the proposed commit message before committing.
```

---

## Paste-ready prompt for PR 1 *(after PR 0 has merged)*

```
Implement PR 1 of the live-sessions-persistence plan.

Worktree: create your own, do not work in the repo root:
  /opt/homebrew/bin/git worktree add -b feat/session-rehydration \
    ~/dev/ai-tools/tb-streamer-worktrees/feat-session-rehydration \
    integration/missing-prs-2026-07-23

PR 0 must already be merged — this PR reads the registry through RuntimeStore.

Read first, in order, from the plan worktree at
~/dev/ai-tools/tb-streamer-worktrees/plan-live-sessions-persistence:
  docs/plans/live-sessions-persistence-audit.md   (gaps G1, G2, G8)
  docs/plans/live-sessions-persistence-plan.md    (Phase 1, section 4)
  docs/compatibility/tb-mobile.md

Scope — PR 1 only. Do not start Phase 2 or later.
  1. src/services/sessions/rehydrateSessions.ts — pure shouldRehydrate() and
     rowToStubSession(). No DB import; mirror how classifySession is split out
     of reconcileSessions.ts so the decision table is unit-testable.
  2. ManagedSessionsRepository.listRecoverable({ sinceMs, limit }) — one
     prepared statement, SQL exactly as in the plan.
  3. ManagedSession.rehydrated?: boolean (src/types.ts, internal — never on the
     wire). managedToResponse (src/session-store.ts:199) emits
     ownership:"historical" + lifecycle:"resumable" + lifecycleSource:"reconcile"
     when it is set.
  4. StreamerServer.rehydratePreviousSessions(verdicts), chained off the
     existing reconcile at src/server.ts:1581. Also seeds selfPtyEndedAt from
     each row's completed_at.
  5. handleSessionsCount (src/server.ts:2457) filters ownership !== "historical".
  6. sessionRehydration feature flag in src/feature-flags.ts, default ON.

Hard constraints:
  - NO new SessionStatus value. VALID_STATUSES (server.ts:5074) plus
    SessionStore.paginate's filter would make recovered sessions vanish from
    already-shipped mobile clients.
  - Stubs live only in SessionStore, never in LiveSessionManager. Prove it with
    a test that reapIdleSessions and startGraceTimer cannot see them.
  - Additive only. __tests__/contracts/mobile-contracts.test.ts stays green.

Tests in the same PR: new __tests__/session-rehydration.test.ts, plus the
modifications listed in plan section 9 for session-registry-persistence,
server, session-store, managed-sessions-repository and feature-flags.

Done = every Phase 1 acceptance criterion in plan section 4 passes, and
`npm run lint && npm test` is green under the .nvmrc Node version.

Show me the staged diff and the proposed commit message before committing.
```

---

## Acceptance checklists

**PR 0**

- [ ] The registry survives `rm -rf ~/.threadbase/cache`
- [ ] A forced `ConversationCache.open` failure leaves `/api/conversations` degraded **and session persistence working**, each logging its own error
- [ ] `npm run build` emits `dist/db/runtime-migrations/`, and the deploy payload contains it
- [ ] Two consecutive boots do not re-copy rows; the source table is not dropped
- [ ] `recordShutdownState()` still runs before either database closes
- [ ] No wire change — `__tests__/contracts/*` untouched and green

**PR 1**

- [ ] Kill the streamer mid-session, restart → `GET /api/sessions` lists it with `sessionName`, project and `promptCount`, `status: "idle"`, `ownership: "historical"`, `lifecycle: "resumable"`, `ptyAttached: false`
- [ ] `POST /api/sessions/resume` brings back a live PTY on the same conversation; the stub is replaced, not duplicated
- [ ] `GET /api/sessions/count` is unchanged by recovered sessions
- [ ] A session whose project directory was deleted is not listed
- [ ] A session older than `REHYDRATE_WINDOW_MS` is not listed; no more than `REHYDRATE_MAX` are listed, and the dropped count is logged
- [ ] `reapIdleSessions()` and `startGraceTimer()` cannot observe a stub (test-asserted)
- [ ] The first resume after a restart does not answer `409 CONVERSATION_BUSY`
- [ ] `sessionRehydration=false` reproduces today's behaviour exactly

Both: `npm run lint && npm test` green under `.nvmrc` Node.

---

## Collision warning — the session-source spec

[session-source-visibility-and-control.md](./session-source-visibility-and-control.md) is a separate stream with its own PRs, and the two overlap in three places. Whoever runs second rebases and reconciles:

| Shared surface | Persistence plan | Source spec |
|---|---|---|
| `parseSessionListQuery` (`server.ts:5081`) | untouched | adds `?ownership=`, `?source=`, `?remoteControlled=` |
| `managedToResponse` (`session-store.ts:199`) | emits `ownership: "historical"` for stubs | emits `source` and `remoteControlled` |
| Migration numbering | `runtime-migrations/002` (or `015` if PR 0 has not landed) | `016` on the cache DB |

**Check `src/db/migrations/` and `src/db/runtime-migrations/` at implementation time** rather than trusting either document's number — whichever spec lands second takes the next free one.

---

## Model and effort

| Work | Model | Effort |
|---|---|---|
| PR 0 (DB split) | Opus 5 | `high` |
| PR 1, 2, 3 | Opus 5 | `high` |
| PR 4, 5 | Sonnet 5 | `medium` |
| PR 6 (protocol design) | Opus 5 | `high` |
| PR 7, 8 (detached process, fd ownership) | Opus 5 | `xhigh` |
| PR 9, 10 | Opus 5 | `high` |
| PR 11 (config + first-run prompt) | Sonnet 5 | `medium` |
| PR 12 (auto-resume flow) | Opus 5 | `high` |
| tb-mobile PRs | Sonnet 5 | `medium` |

Sonnet 5 at `high` is an acceptable substitute for PRs 2 and 3. Not for 0, 1, 7, 8 or 12 — those are where a subtly wrong lifecycle, fd-ownership or unattended-spawn decision is cheap to write and expensive to find.

---

## Standing rules for every PR in this plan

- Own worktree under `~/dev/ai-tools/tb-streamer-worktrees/`; never edit the repo root checkout.
- Conventional-commit title; no AI attribution anywhere in commits, PR bodies or issues.
- Tests ship in the same PR as the code they cover.
- Any change touching `SessionResponse` updates `docs/compatibility/tb-mobile.md` in the same commit.
- Show the staged diff and commit message and wait for approval before committing.
- Rebase onto the current integration branch, then squash-merge. One PR at a time.
