# Split src/server.ts — Implementation Plan

## Context

`src/server.ts` is 3333 lines, dominated by the ~3000-line `StreamerServer` class (`src/server.ts:136`). It's the repo's #1 merge-conflict magnet — touched in nearly every PR, which hurts most now that features are developed in parallel worktrees.

The routing migration is half-done: `src/api/routes/*.ts` are thin Hono factories that delegate straight back into the class via `ApiDeps.handleXxx` bound methods (`src/api/types/api-deps.ts:33-72`, wired at `src/server.ts:505-656`). The handler **bodies** — ~2000 lines — still live inside the class. This plan finishes the extraction along seams that already exist, with zero HTTP behavior change (no endpoint, shape, or status change → tb-mobile compat untouched).

**Sequencing constraint:** the working tree has uncommitted reparse-stall guard-rail work (`refreshFileGuarded`, `inFlightCacheWrites`, single-flight tests). That must land first — PR 1 below extracts exactly that code, so refactoring before it merges guarantees conflicts.

## Approach

Extract handler bodies into **handler modules** (factory functions taking a narrow context object), not fat route files. Route files stay as-is; `ApiDeps` contract stays identical; `StreamerServer` constructs the handler groups and passes their methods into `apiDeps`. Each extraction is a mechanical move — no logic changes, one PR each, built in its own worktree from `main`.

Pattern (mirrors the existing `createXxxRoutes(deps)` convention):

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

`StreamerServer` keeps the handler group as a field (e.g. `private conversationHandlers`) so tests that spy/cast (`vi.spyOn(srv, "isConversationSnapshotStale")`, `srv.findConversationByUuid`) migrate to `srv.conversationHandlers.…` — same reach-in style, one level deeper.

## PRs, in order

### PR 1 — land the in-flight guard-rails work (prerequisite, already written)
The uncommitted `src/server.ts` + `__tests__/server.test.ts` changes on branch `docs/reparse-stall-spec-and-prompts`. Not part of this refactor — just merges first.

### PR 2 — `ScannerManager` (~250 lines out)
New `src/scanner-manager.ts`: class owning scanner lifecycle + freshness state.
- Moves: `getScanner`, `getFreshScanner`, `rescanForRefresh`, `newScanner`, `codexScanOpts` (`src/server.ts:1479-1580`), `refreshFileGuarded` (`:1034`), `isConversationSnapshotStale` (`:1706`), and fields `scanner`, `allScanners`, `scannerReady`, `scannerStale`, `scannerPersistenceDisabled`, `refreshInFlight`, `markScannerStaleDebounced`.
- Ctx: `scanProfiles`, `codexRoots`, `includeAgents`, `agentEntrypoints`, `cacheDir`, `directoryDebounceMs`, `trackCacheWrite` callback.
- `close()` teardown of `allScanners` moves into `ScannerManager.close()`, called from `StreamerServer.close()`.
- Test updates: `srv.scannerStale` casts in `__tests__/server.test.ts` → `srv.scannerManager.stale` (or equivalent).
- Payoff: the code under active churn (reparse-stall work, upcoming scanner incremental-refresh integration) moves to its own file — future scanner PRs stop touching server.ts.

### PR 3 — conversation read handlers (~900 lines out)
New `src/api/handlers/conversations.handlers.ts`.
- Moves: `handleListConversations`, `handleConversationsCount`, `refreshCountInBackground`, `buildStatCache`, `handleGetRecentSessions`, `handleGetPopularProjects`, `handleGetConversation` (275 lines), `handleSearchTarget`, `handleSearch`, `findJsonlPath`, `readCwdFromJsonl`, `findConversationByUuid` (`src/server.ts:1248-2098`), plus bottom-of-file pure helpers `classifyResumability`, `conversationToResumableSession` (`:3178-3226`).
- Shared HTTP helpers `json`, `writeHonoResponse`, `readBody`, `intParam`, `parseSessionListQuery` (`:3226-3333`) → new `src/api/handlers/http-helpers.ts` (used by later PRs too).
- Ctx: `ScannerManager`, `cache()`, repos, `sessionStore`, `ptyManager`, `discoveryCache`, `includeAgents`.
- Test updates: the ~9 `as unknown as` casts in `server.test.ts` reaching `findConversationByUuid` / `inFlightCacheWrites` — `inFlightCacheWrites` stays on the server (it spans cache writes beyond conversations); `findConversationByUuid` moves to the handlers field.

### PR 4 — session file watchers (~310 lines out)
New `src/session-watchers.ts`: `watchForJsonl`, `watchForCodexRollout`, `watchConversationFile`, `linkSessionToProject` (`src/server.ts:2772-3080`).
- Ctx: `sessionStore`, `sessionFileMap`, `fileWatcher`, `wsHub`, `cache()`, `codexRoots`, `trackCacheWrite`.

### PR 5 — session lifecycle handlers (~700 lines out)
New `src/api/handlers/sessions.handlers.ts`: `handleListSessions`, `handleSessionsCount`, `handleGetSession`, `handleGetOutput`, `handleResume`, `enrichResumedSessionAsync`, `handleSendInput`, `handleSendAnswer`, `handleStartSession`, `handleStopSession`, `handleAdopt`, `handleCancel`, `handleUploadFile`, `handleSetSessionName`, `handleGetSessionNames`, `cancelPendingQuestion`, `handleLiveQuestion`, `handlePermissionChange` (`src/server.ts:2099-2771`).
- Most entangled group (pendingQuestions/pendingPermission maps, rate limiters, grace timers, watcher calls) — done last, after the pattern is proven. Rate-limit checks stay on the server, passed in as callbacks.

### Not moving (deliberately)
Lifecycle (`listen`/`close`/`bindWithRetry`), WS handling (`handleWsOpen/Message/Close`, subscriber maps, grace timers), pairing + rate limiting (`handlePairStart/Exchange`, `rotateApiKey`, attempt maps), browse/mkdir (~55 lines). Small, load-bearing, genuinely server concerns. No DI container, no controller classes — the factory-ctx pattern already in `api/routes/` is enough.

End state: server.ts ≈ 1100-1300 lines (config, wiring, lifecycle, WS, auth/pairing).

## Verification (each PR)

1. `npm run lint && npm test` — full suite; `server.test.ts`, `conversation-*.test.ts`, contracts, and e2e all exercise handlers over HTTP, so behavior regressions surface without new tests.
2. `git diff --stat` sanity: server.ts only shrinks; new module ≈ lines removed (mechanical move).
3. No changes under `__tests__/contracts/` or `__tests__/e2e/` expected — if a contract test needs editing, the move wasn't mechanical; stop and re-check.
4. Grep guard: no route file or `ApiDeps` field renamed (`git diff src/api/types/api-deps.ts` should be empty in PRs 3-5 except delegate wiring in server.ts).
