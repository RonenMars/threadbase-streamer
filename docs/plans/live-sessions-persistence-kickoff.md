# Live sessions persistence — implementation kick-off

**Date:** 2026-07-30 (status refreshed 2026-07-31)
**For:** the implementation sequence in [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md).

## Status

| PR | Phase | State |
|---|---|---|
| PR 0 — runtime.db split | 0 | **Merged** — [#309](https://github.com/RonenMars/threadbase-streamer/pull/309), squashed to `b50d16c` |
| PR 1 — session rehydration | 1 | **Next.** Paste-ready prompt below |
| PR 2 onwards | 2–7 | Not started |

**Start at the PR 1 prompt.**

---

## Documents

All five live in `docs/plans/` on the integration branch — they merged in [#307](https://github.com/RonenMars/threadbase-streamer/pull/307), so read them from the repo you are working in, not from a separate plan worktree.

| File | What it is |
|---|---|
| [live-sessions-persistence-audit.md](./live-sessions-persistence-audit.md) | What survives a restart today, and the gaps `G1`–`G12` |
| [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md) | Phases 0–7, twelve PRs. The plan of record |
| this file | How to start, and the paste-ready prompts for PR 0 and PR 1 |
| [session-source-visibility-and-control.md](./session-source-visibility-and-control.md) | **Separate feature stream** — session source, stop and overtake. Own PRs. See the collision note below |
| [codex-source-visibility-investigation-prompt.md](./codex-source-visibility-investigation-prompt.md) | Research prompt for the Codex equivalent of that spec |

---

## Branching

Each implementation PR branches from the current integration branch, in its own worktree:

```bash
/opt/homebrew/bin/git worktree add -b feat/session-rehydration \
  ~/dev/ai-tools/tb-streamer-worktrees/feat-session-rehydration \
  integration/missing-prs-2026-07-23
```

Every PR gets its own worktree off the *then-current* integration branch, never off its predecessor, unless the plan explicitly stacks them (only Phase 6a → 6b–6e). Because each merge advances the integration branch, a PR opened before an earlier one lands must be rebased before it merges — one PR at a time, rebase, squash-merge.

---

## What PR 0 left behind *(merged — for context, not for doing)*

`managed_sessions` now lives in `~/.threadbase/runtime.db`, opened by `RuntimeStore` (`src/db/runtime-store.ts`) independently of the conversation cache. Facts every later PR depends on:

- `ManagedSessionsRepository` is constructed from `runtimeStore.getDatabase()`, not `cache.getDatabase()`. A cache failure no longer nulls it.
- Migrations for the registry live in `src/db/runtime-migrations/` with their own `schema_migrations` table. **The next registry migration is `002`**; the next *cache* migration is `015` (`010` left that tree, so `src/db/migrations/` now tops out at `014`).
- `reconcilePreviousSessions()` runs after the cache block and outside its `try`, so it no longer depends on the cache opening.
- `ApiDeps.runtimeStore: () => RuntimeStore | null` exists and is so far unread — PR 1 and PR 2 are its first consumers.
- `THREADBASE_RUNTIME_DB` overrides the registry path; `__tests__/setup/isolate-runtime-db.ts` uses it to give every test file its own database. A test that needs to inspect the registry should read that path, not `~/.threadbase/runtime.db`.

The original PR 0 prompt has been removed now that it is merged; the diff is the record. See [#309](https://github.com/RonenMars/threadbase-streamer/pull/309).

---

## Paste-ready prompt for PR 1

```
Implement PR 1 of the live-sessions-persistence plan.

Worktree: create your own, do not work in the repo root:
  /opt/homebrew/bin/git worktree add -b feat/session-rehydration \
    ~/dev/ai-tools/tb-streamer-worktrees/feat-session-rehydration \
    integration/missing-prs-2026-07-23

PR 0 is merged (#309). The registry is ~/.threadbase/runtime.db, opened by
RuntimeStore (src/db/runtime-store.ts); ManagedSessionsRepository is constructed
from runtimeStore.getDatabase(), and ApiDeps.runtimeStore already exists.

Read first, in order, from your own worktree — these docs are on the
integration branch, there is no separate plan worktree:
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
     existing `void this.reconcilePreviousSessions()` (src/server.ts:1706, just
     after the cache try/catch). Also seeds selfPtyEndedAt from each row's
     completed_at.
  5. handleSessionsCount (src/server.ts:2552) filters ownership !== "historical".
  6. sessionRehydration feature flag in src/feature-flags.ts, default ON.

Line numbers above are as of b50d16c and drift with every merge — grep for the
symbol rather than trusting the number.

Hard constraints:
  - NO new SessionStatus value. VALID_STATUSES (server.ts:5264) plus
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

**PR 0** — all met, verified in [#309](https://github.com/RonenMars/threadbase-streamer/pull/309)

- [x] The registry survives `rm -rf ~/.threadbase/cache`
- [x] A forced `ConversationCache.open` failure leaves `/api/conversations` degraded **and session persistence working**, each logging its own error
- [x] `npm run build` emits `dist/runtime-migrations/`, and all three deploy scripts copy it
- [x] Two consecutive boots do not re-copy rows; the source table is not dropped
- [x] `recordShutdownState()` still runs before either database closes
- [x] No wire change — `__tests__/contracts/*` untouched and green

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
| `parseSessionListQuery` (`server.ts:5271`) | untouched | adds `?ownership=`, `?source=`, `?remoteControlled=` |
| `managedToResponse` (`session-store.ts:199`) | emits `ownership: "historical"` for stubs | emits `source` and `remoteControlled` |
| Migration numbering | `runtime-migrations/002` | `015` on the cache DB — **not** the `016` that spec says |

PR 0 changed the migration arithmetic: `010_create_managed_sessions.sql` left `src/db/migrations/`, so that tree now tops out at `014` and the next free cache migration is `015`, not `016`. Registry migrations are numbered independently in `src/db/runtime-migrations/`, where `001` is taken.

**Check both directories at implementation time** rather than trusting any document's number — whichever spec lands second takes the next free one.

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
