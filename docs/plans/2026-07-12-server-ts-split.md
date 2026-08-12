# Split src/server.ts — Implementation Plan

> **Re-baselined 2026-08-13 against `c76c257`.**
> Every line number below was verified at that commit.
> The original draft was written on 2026-07-12 against a **3,333-line** file; it is now **6,539 lines**, so all of the original ranges were stale by roughly 3,200 lines and three whole subsystems had appeared that the draft never mentioned.
> Re-verify before executing if `main` has moved — `grep -n 'private async handleGetConversation' src/server.ts` is the fastest single check.

## Context

`src/server.ts` is 6,539 lines, essentially all of it the `StreamerServer` class (`src/server.ts:423`).
It is the repo's #1 merge-conflict magnet, and the evidence is no longer anecdotal.

- **Churn**: 182 commits in the six months to 2026-08-13 — 3× the next file (`src/types.ts`, 59).
- **Growth is accelerating**: 1,096 lines on 2026-05-01, 3,015 on 2026-07-05, 3,571 on 2026-07-16, 4,993 on 2026-08-02, 6,539 on 2026-08-11.
- **Live cost**: 5 of the 11 open PRs on 2026-08-13 touch this file (#521, #545, #546, #548, #551).
- **Measured merge cost**: `docs/landing/2026-08-01-rehearsal-notes.md` §3 records that nine of fourteen conflict rows in the 26-PR landing were the same `src/server.ts` collision, and that a blanket per-file conflict resolution there *silently deletes routes in a way `tsc` cannot catch*.

**Routing is already fully extracted, and that is the good news.**
`handleRequest` (`src/server.ts:2627`) contains no URL matching at all — it builds a `Request`, calls `honoApp.fetch()`, and pipes the result back unless the status is the `ALREADY_HANDLED` (597) sentinel.
All of `src/api/` — 17 route files, four middleware, `app.ts`, and the `ApiDeps` type — totals 1,952 lines of thin adapters.
What remains inside `StreamerServer` is the **32 `handleX` handler bodies** those routes delegate into, bound into `ApiDeps` inside the constructor.

This plan finishes that extraction along seams that already exist, with zero HTTP behaviour change — no endpoint, shape, or status change, so tb-mobile compatibility is untouched.

## What changed since the 2026-07-12 draft

Three subsystems now account for ~950 lines that the original plan does not mention at all:

| Group | Lines | Size |
|---|---|---|
| External (non-PTY) live tails | 3562–3753 | ~192 |
| Resume / fork / startup outcome | 4553–5150 | ~598 |
| Session name + live model/effort settings | 6213–6345 | ~133 |

And two regions the original plan overlooked entirely, which together are the largest single readability problem in the file:

- **The constructor is 674 lines** (`656–1329`): config resolution (658–755), a `ConversationWatcher` built with **6 inline callbacks** (760–910), a `LiveSessionManager` built with **8 inline callbacks** (911–1065), multi-agent bootstrap (1066–1095), and a 170-line `ApiDeps` object literal (1096–1266) that itself contains three more inline WS handlers — `handleWsMessage` alone runs ~70 lines.
- **`listen()` is 408 lines** (`2056–2463`), most of it one large `warmUp` promise.

`src/api/handlers/` — the directory this plan creates — still does not exist.

## Current shape

| Region | Lines | Size |
|---|---|---|
| imports (~80 statements) + module constants | 1–422 | 422 |
| class fields (~80) | 424–654 | 231 |
| **constructor** | 656–1329 | **674** |
| WS fan-out / session-list payloads | 1330–1421 | 92 |
| push init | 1422–1493 | 72 |
| boot reconcile / rehydrate / auto-resume / registry records | 1494–1923 | 430 |
| idle reaper + grace timers | 1924–2012 | 89 |
| warm-up helpers | 2013–2055 | 43 |
| **`listen()`** | 2056–2463 | **408** |
| bind retry, cache-write tracking, `close()` | 2464–2626 | 163 |
| `handleRequest` | 2627–2640 | 14 |
| pairing / key rotation / config / rate limits | 2641–2891 | 251 |
| conversation cache ↔ disk reconcile | 2892–2999 | 108 |
| conversation + project read handlers | 3000–3244 | 245 |
| scanner plumbing | 3245–3537 | 293 |
| external live tails | 3562–3753 | 192 |
| `findConversationByUuid` + staleness | 3754–3918 | 165 |
| **`handleGetConversation()`** | 3919–4294 | **376** |
| search | 4295–4424 | 130 |
| session list / discovery / detail | 4425–4552 | 128 |
| resume / fork / startup outcome | 4553–5150 | 598 |
| input / questions / permissions / answers | 5151–5417 | 267 |
| upload / output / cancel / stop / adopt / start | 5418–5809 | 392 |
| project linking + jsonl/rollout watchers | 5810–6157 | 348 |
| browse / mkdir | 6158–6212 | 55 |
| session name + live settings | 6213–6345 | 133 |
| module-level free functions | 6348–6539 | 192 |

**The field map is where the seams are.**
External tails, push init, discovery, grace/idle timers, scanner plumbing, and config/rate-limits each touch a **near-disjoint** set of instance fields, which is what makes them cheap to lift.
The genuinely tangled core is `cache` + `sessionStore` + `ptyManager` + `wsHub` + `sessionFileMap`, shared by the resume/fork/start/input/watcher group — which is why that group is extracted last.

## Approach

Extract handler bodies into **handler modules** (factory functions taking a narrow context object), not fat route files.
Route files stay as-is, the `ApiDeps` contract stays identical, and `StreamerServer` constructs the handler groups and passes their methods into `apiDeps`.
Each extraction is a mechanical move — no logic changes, one PR each, built in its own worktree from `main`.

Follow the conventions the repo already uses; do not invent a third pattern.

- **Stateless handler bodies** → free functions under `src/api/handlers/`, narrow ctx as the first parameter, mirroring the `createXxxRoutes(deps)` naming next door in `src/api/routes/`.
- **Stateful groups** (scanner, external tails, watchers) → a small class with constructor injection, mirroring `ConversationWatcher` and `CacheIntegrityMonitor` in `src/services/`.
- `src/services/` currently holds ~48 files with a median of ~90 lines, several at 18–24. **Small modules are the norm here** — a 60-line file needs no justification.

```ts
// src/api/handlers/conversations.handlers.ts
export type ConversationHandlersCtx = {
  scanner: ScannerManager;
  cache(): ConversationCache | null;
  sessionStore: SessionStore;
  // ...only what this group actually reads
};
export function createConversationHandlers(ctx: ConversationHandlersCtx) {
  return { handleListConversations, handleGetConversation, /* … */ };
}
```

`StreamerServer` keeps each handler group as a field (e.g. `private conversationHandlers`) so tests that spy or cast migrate to `srv.conversationHandlers.…` — the same reach-in style, one level deeper.

## Hard constraints

These are what separate a mechanical move from a broken suite.
All were verified at `c76c257`.

- **41 test files reference `../src/server`** (33 by static import, the rest via `await import(...)`), not just `__tests__/server.test.ts`. `StreamerServer` must keep its **name**, its **constructor options shape**, and `listen` / `port` / `close`.
- **Private fields must stay as instance properties.** Tests reach in through `(server as any)` for `sessionStatusBus` (14 hits), `handlePermissionChange` (13), `pendingQuestions` (6), `sessionStore` / `sessionFileMap` / `ptyGraceTimers` (5 each), and ~15 more. **Extracting *methods* into modules that receive state as a parameter is fine; moving *state* off the instance is not.** That is the line between a safe split and a suite-wide rewrite.
- **These named exports must survive**, because tests reference them today: `parseIncludeAgentsEnv`, `waitForProcessExit`, `ADOPT_KILL_TIMEOUT_MS`, `GRACE_MAX_DEFERS`, `IDLE_REAP_AFTER_MS`, `EXTERNAL_TAIL_MAX`, `EXTERNAL_TAIL_IDLE_MS`. Re-export them from `server.ts` if the definition moves. (`IDLE_REAP_SWEEP_MS`, `RESUME_DISCOVERY_TIMEOUT_MS`, `EXTERNAL_TAIL_RECENCY_MS` and `EXTERNAL_ACTIVE_WRITING_MS` are exported but unused by tests — they carry no such constraint.)
- **`ApiDeps` (123 lines, `src/api/types/api-deps.ts`) must not change.** No field renamed, no signature altered. `git diff src/api/types/api-deps.ts` should be empty in every PR except the delegate wiring line.
- **No build config changes are needed.** `tsup.config.ts` has five fixed entry points and bundles everything; nothing is emitted per-file. Any new file under `src/` is picked up automatically as long as `src/index.ts`'s `export { StreamerServer } from "./server"` still resolves.
- **The behaviour safety net is real.** `server.test.ts` is 119 `fetch(\`${baseUrl}/api/…\`)` calls against ~20 private reach-ins, so regressions surface over HTTP without writing new tests.

## PRs, in order

Ordered cheapest-and-most-independent first, so the pattern and the verification loop are proven before anything entangled is touched.

### PR 1 — HTTP helpers (~190 lines out)

New `src/api/handlers/http-helpers.ts`.
Moves the module-level free functions at the tail of the file: `json` (6432), `writeHonoResponse` (6437), `intParam` (6466), `parseSessionListQuery` (6482) with its `VALID_*` constants (6473–6480), `readBody` (6525), plus `classifyResumability` (6377) and `conversationToResumableSession` (6390).
All are pure, none is exported, and none has an external importer — this is the cheapest possible proof that the pattern works.
Leave `waitForProcessExit` (6359) where it is; it is exported and imported by `__tests__/adopt-kill-wait.test.ts`.

### PR 2 — `ScannerManager` (~400 lines out)

New `src/scanner-manager.ts`: a class owning scanner lifecycle and freshness state.
Moves `buildStatCache` (3245), `codexScanOpts` (3274), `newScanner` (3287), `takeStaleFiles` (3298), `refreshStaleFiles` (3309), `getScanner` (3329), `getFreshScanner` (3392), `rescanForRefresh` (3408), `projectsDirs` (3447), `refreshFileGuarded` (2535), `isConversationSnapshotStale` (3907), and the cache↔disk reconcile group (2892–2999).
Fields: `scanner`, `allScanners`, `scannerReady`, `scannerStale`, `scannerPersistenceDisabled`, `staleFiles`, `refreshInFlight`, `conversationReconcileInFlight`, `markScannerStaleDebounced`.
Ctx: `scanProfiles`, `codexRoots`, `includeAgents`, `agentEntrypoints`, `cacheDir`, `directoryDebounceMs`, `trackCacheWrite` callback.
`close()` teardown of `allScanners` moves into `ScannerManager.close()`, called from `StreamerServer.close()`.
Payoff: the code under active churn moves to its own file, so future scanner PRs stop touching server.ts.

### PR 3 — external live tails (~192 lines out)

New `src/external-tails.ts`.
Moves `isManagedTailPath` (3562), `maybeAttachExternalTail` (3574), `detachExternalTail` (3609), `handleJsonlDeleted` (3623), `evictExternalTailsIfNeeded` (3644), `externalActivityFor` (3675), `withExternalActivity` (3692), `sweepIdleExternalTails` (3703), `broadcastExternalTailLines` (3723).
This group touches an almost completely disjoint field set — `externalTails` is read in only three places outside it — which makes it the lowest-risk stateful extraction in the file.
Keep `EXTERNAL_TAIL_MAX` and `EXTERNAL_TAIL_IDLE_MS` re-exported from `server.ts`; `__tests__/external-live-tails.test.ts` imports them dynamically.

### PR 4 — conversation read handlers (~1,090 lines out)

New `src/api/handlers/conversations.handlers.ts`.
Moves `handleListConversations` (3000), `handleConversationsCount` (3120), `refreshCountInBackground` (3157), `handleGetRecentSessions` (3187), `handleGetPopularProjects` (3217), `handleGetProjectSummaries` (3227), `findJsonlPath` (3454), `readCwdFromJsonl` (3475), `findConversationByUuid` (3754), `handleGetConversation` (3919 — 376 lines, the largest single method), `handleSearchTarget` (4295), `handleSearch` (4355).
Ctx: `ScannerManager`, `cache()`, repos, `sessionStore`, `ptyManager`, `discoveryCache`, `includeAgents`.
`inFlightCacheWrites` stays on the server — it spans cache writes beyond conversations.

### PR 5 — session file watchers (~350 lines out)

New `src/session-watchers.ts`.
Moves `linkSessionToProject` (5810), `watchConversationFile` (5851), `readFirstLineSessionId` (5867), `watchForJsonl` (5883), `watchForCodexRollout` (5996).
Ctx: `sessionStore`, `sessionFileMap`, `fileWatcher`, `wsHub`, `cache()`, `codexRoots`, `trackCacheWrite`.

### PR 6 — boot registry lifecycle (~430 lines out)

New `src/session-registry-boot.ts`.
Moves `reconcilePreviousSessions` (1494), `pruneTerminalSessions` (1567), `rehydratePreviousSessions` (1601), `autoResumePreviousSessions` (1677), `spawnArgvToken` (1789), `refreshHostedSessionsFromRegistry` (1795), `recordSessionSpawn` (1826), `recordShutdownState` (1878).
Ctx: `managedSessionsRepo`, `runtimeStore`, `sessionStore`, `sessionVerdicts`, `ptyManager`, resume callback.
Note `reapIdleSessions` (1924) is **public for tests** — leave it on the class.

### PR 7 — constructor decomposition (~500 lines out)

New `src/server-wiring.ts`.
Moves the two callback blocks out of the constructor as named factories: the six `ConversationWatcher` callbacks (760–910) and the eight `LiveSessionManager` callbacks (911–1065), plus the `ApiDeps` object assembly (1096–1266) including the three inline WS handlers.
This is the largest readability win in the plan and the one the original draft missed.
Take it after PRs 2–6, because each of those shrinks the callback bodies first.

### PR 8 — session lifecycle handlers (~1,400 lines out)

New `src/api/handlers/sessions.handlers.ts`.
Moves `handleListSessions` (4425), `refreshDiscovery` (4473), `handleGetSession` (4504), `handleResume` (4553), `handleFork` (4639), `resumeSession` (4774), `resolveConversationTarget` (4960), `waitForStartupOutcome` (5043), `abandonFailedStart` (5077), `enrichResumedSessionAsync` (5092), `handleSendInput` (5151), `processJsonlQuestions` (5282), `cancelPendingQuestion` (5332), `handleLiveQuestion` (5345), `handlePermissionChange` (5357), `handleSendAnswer` (5392), `handleUploadFile` (5418), `handleGetOutput` (5484), `handleCancel` (5495), `handleStopSession` (5506), `handleAdopt` (5561), `handleStartSession` (5682), `handleSetSessionName` (6213), `applyLiveSessionSetting` (6252), `handleGetSessionNames` (6339).
The most entangled group — `pendingQuestions`, `pendingPermission`, `contendedSessions`, `idempotency`, rate limiters, grace timers, and the shared core fields — so it goes last, after the pattern is proven.
Rate-limit checks stay on the server and are passed in as callbacks.
`handlePermissionChange` is the single most-referenced private in the test suite (13 reach-ins); expect that file's casts to need the `srv.sessionHandlers.…` rewrite.

### Not moving (deliberately)

Lifecycle (`listen` / `close` / `bindWithRetry`), WS handling (`handleWsOpen` / `Message` / `Close`, subscriber maps, grace timers), pairing and rate limiting (`handlePairStart` / `handlePairExchange`, `rotateApiKey`, attempt maps), config accessors, browse/mkdir (~55 lines).
Small, load-bearing, genuinely server concerns.
No DI container and no controller classes — the factory-ctx pattern already in `api/routes/` is enough.

### End state

All eight PRs remove roughly 4,150 lines, leaving **server.ts around 2,400 lines**: imports, fields, config, lifecycle, WS, auth/pairing, browse.
The original draft promised 1,100–1,300, but that was against a 3,333-line file and only four PRs.
Getting below ~1,500 would need the `listen()` warm-up body and the WS group extracted too, which is deliberately out of scope here.

## Sequencing gate

**Do not start this while PRs are open against `src/server.ts`.**

The 2026-08-01 rehearsal already paid for this lesson and wrote it down:

> `#237` extracts the `?refresh=1` reconcile body into `reconcileConversationsCacheFromDisk()`, and four other PRs (`#232`, `#253`, `#234`, `#267`) each edit the pre-refactor body.
> It is not random hotspot churn — it is one refactor against four editors, and it recurs once per PR.

This plan is that exact shape at ten times the size.
Land or close the open PRs touching `src/server.ts` first (on 2026-08-13: #521, #545, #546, #548, #551), then run this alone on a quiet trunk, one PR at a time, re-verifying line numbers after each merge.

## Verification (each PR)

1. `npm run lint && npm test` — the full suite. `server.test.ts`, `conversation-*.test.ts`, contracts, and e2e all exercise these handlers over HTTP, so behaviour regressions surface without new tests.
2. `git diff --stat` sanity: server.ts only shrinks, and the new module is approximately the number of lines removed. A mechanical move nets near zero.
3. **No changes expected under `__tests__/contracts/` or `__tests__/e2e/`.** If a contract test needs editing, the move was not mechanical — stop and re-check.
4. `git diff src/api/types/api-deps.ts` should be empty except the delegate wiring in server.ts. No `ApiDeps` field renamed, no route file renamed.
5. **Diff the route table before and after.** The rehearsal's detour D7 records that a deleted route is invisible to `tsc`; it is the one failure mode the compiler will not catch for you.
