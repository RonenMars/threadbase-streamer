# Backlog — Threadbase Streamer

Known bugs and unresolved issues. Self-contained enough to pick up without re-reading the original conversation.

For planned features (work that adds new behavior rather than fixing broken behavior) see [ROADMAP.md](ROADMAP.md).

---

## Status overview (2026-07-22)

| Item | Status |
|---|---|
| Stale conversation history vs. fresh resume | 🔄 In flight — [PR #237](https://github.com/RonenMars/threadbase-streamer/pull/237) |
| Homebrew vs deploy launchd conflict check | ✅ DONE — [PR #238](https://github.com/RonenMars/threadbase-streamer/pull/238) (merged 2026-07-20) |
| `bootstrapAgent` exit-5 false-positive | 🔄 In flight — [PR #240](https://github.com/RonenMars/threadbase-streamer/pull/240) |
| Upload filenames / `@path` spaces | 🔄 In flight — [PR #241](https://github.com/RonenMars/threadbase-streamer/pull/241) (pairs with mobile #345) |
| Quiet timeout stuck as `running` | 🔄 In flight — [PR #252](https://github.com/RonenMars/threadbase-streamer/pull/252) |
| External session mirror + resume collision guard | 🔄 In flight — [PR #253](https://github.com/RonenMars/threadbase-streamer/pull/253) (pairs with mobile #354) |
| Windows adopt working directory | 🔄 In flight — [PR #254](https://github.com/RonenMars/threadbase-streamer/pull/254) |
| Quick Access Recents historical routing | ♻️ Superseded on modern mobile (Favorites-only); keep `/api/sessions/recents` for older clients |
| Degraded-mode `findJsonlPath` / `scanProfiles` | ✅ DONE — [PR #243](https://github.com/RonenMars/threadbase-streamer/pull/243) |
| Server tests `codexRoots` host leak | ✅ DONE — [PR #235](https://github.com/RonenMars/threadbase-streamer/pull/235) / [PR #239](https://github.com/RonenMars/threadbase-streamer/pull/239) |
| `server.test.ts` grace-timer flake | 🟡 Partial — [PR #248](https://github.com/RonenMars/threadbase-streamer/pull/248) merged; follow-up [PR #245](https://github.com/RonenMars/threadbase-streamer/pull/245) open |
| Log truncation sparse/NUL logs | Open — **next action** |
| Busy-wait CPU spin in `bootoutAgent` | Open — **next action** |
| Partial `prod logs --clear` failure messaging | Open |
| Cache integrity alert management | 🔄 In flight — [PR #232](https://github.com/RonenMars/threadbase-streamer/pull/232) |
| Explicit warm-up status API | 🔄 In flight — [PR #234](https://github.com/RonenMars/threadbase-streamer/pull/234) |
| `enrichResumedSessionAsync` writes to a throwaway copy | ✅ DONE — [PR #336](https://github.com/RonenMars/threadbase-streamer/pull/336) (merged 2026-08-01) |

**Suggested next-up (new PRs, 2026-07-22):** **(1) Log truncation races** → **(2) `bootoutAgent` busy-wait spin**. Merge the in-flight product PRs (#237, #240, #241, #252, #253) ahead of opening those when possible.

---

## Upload filenames with spaces break `@path` references — FIXED

**Status:** Fixed on `fix/upload-filename-sanitize` — `sanitizeFilename` replaces spaces and shell-problematic characters (`@ " ' \` $ \\`) with underscores so Claude Code `@path` refs stay a single token. Mobile also escapes spaces in `buildPayload` for legacy uploads (tb-mobile `fix/multi-attachment-send`).

---

## Stale conversation history vs. fresh resume

**Status:** Fixed on `fix/stale-conversation-history` — `GET /api/conversations`
auto-reconciles when `scannerStale` is set (directory watcher) or
`shouldRefreshProjectsFromHdd` detects disk drift (orphan rows or
max(root, child-dir) mtime newer than `conversations_last_indexed_at`).
`?refresh=1` remains supported. Child-dir mtime covers new JSONLs under
existing projects; in-place appends rely on the watcher → `scannerStale` path.

**Symptom:** The mobile conversation history list shows old `lastMessage` / `preview` / `messageCount` / `lastActivity` for a conversation, but opening (Resume session) renders the latest messages. Reported 2026-05-31 with three screenshots in `.threadbase-uploads/044a9f81-…/IMG_5407-5409.heic`.

**Original symptom:** The mobile conversation history list shows old `lastMessage` /
`preview` / `messageCount` / `lastActivity` for a conversation, but opening
(Resume session) renders the latest messages. Reported 2026-05-31.

---

## Log truncation races with the still-running streamer fd

**Status:** Fixed on `fix/log-truncation-sparse-nuls` — `prod logs --clear` kickstarts after truncate; deploy `--clear-logs` bootouts before truncate then re-bootstraps. Partial truncate failures report both outcomes.

**Symptom:** `tb-streamer prod restart` (and the dev-takeover path) pegs a full CPU core for up to 2 seconds while launchd tears down the agent.

**Root cause:** `src/lifecycle/launchd.ts:33-43` polls `isAgentLoaded()` (which spawns `launchctl print`) on a 50 ms cadence — but the inter-poll wait is a tight `while (Date.now() < wake) { /* spin */ }` loop, not a sleep. With the default 2 s deadline that's up to 40 iterations of 50 ms hot-spinning. The justification comment (*"Atomics.wait would need a SharedArrayBuffer; spawnSync('sleep') is expensive"*) is misleading — `execFileSync("sleep", ["0.05"])` is ~1 ms of fork/exec overhead, dramatically cheaper than 50 ms of pegged CPU.

**Suggested fix:** Replace the inner `while` with `execFileSync("sleep", ["0.05"], { stdio: "ignore" })`, or use `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)` to stay in-process. Either is orders of magnitude cheaper than the spin.

---

## `bootstrapAgent` false-positive on exit-5 + empty stderr — FIXED

**Status:** Fixed — `bootstrapAgent` now requires `opts.afterBootout: true` to tolerate exit 5 + empty stderr. Callers that just ran `bootoutAgent()` pass the flag; standalone callers without the flag will throw on exit 5 + empty stderr. Tests added in `__tests__/lifecycle/launchd.test.ts`.

---

## `--clear` truncate failure leaves stdout cleared but stderr not

**Status:** Fixed on `fix/log-truncation-sparse-nuls` — best-effort both files; combined cleared/failed message.

**Symptom:** `tb-streamer prod logs --clear` reports `failed to truncate <stderr>: EACCES` (or similar) but `stdout.log` has already been wiped. Recovery requires re-running after fixing perms with stdout already empty.

**Root cause:** `cli/prod.ts:134-143` loops `for (const f of [paths.stdout, paths.stderr])` and returns the first error, with no rollback. POSIX has no atomic two-file truncate.

**Suggested fix:** Best-effort both files and report a combined success/failure message — e.g. *"cleared stdout; failed to truncate stderr: EACCES"* — so the user knows the partial state instead of assuming nothing happened.

---

## Homebrew vs deploy.sh launchd conflict

**Status (2026-07-22):** ✅ DONE — [PR #238](https://github.com/RonenMars/threadbase-streamer/pull/238) (merged). `serve` and `prod doctor` warn when both Homebrew and deploy agents are loaded.

---

## Quick Access Recents tapping historical conversations shows "No terminal output"

**Status:** Superseded on modern tb-mobile — Recents/Popular were removed with `/project-chats`; Favorites pin `type: "conversation"` and route to `/conversation/[id]`. Legacy `/api/sessions/recents` remains for older clients only.

**Symptom:** In tb-mobile, tapping a recent conversation from the Quick Access chips at the top of the home screen briefly shows a "No terminal output" screen before redirecting to the conversation detail view. Reported 2026-06-09 with screenshots in `.threadbase-uploads/05509314-a6f6-40c2-b509-19664a2b38e4/IMG_5645.heic` and `IMG_5642.heic`.

**Root cause:** The Quick Access Recents feature (`components/quick-access/QuickAccessStrip.tsx`) was implemented in May 2026 before the ProjectChat unified model existed. It still calls the legacy `/api/sessions/recents` endpoint, which returns historical conversations disguised as sessions with `status: "idle"` and `ptyAttached: false`. When the user taps a chip, the mobile app routes to `/session/[id]` (the PTY session detail screen), which then detects the mismatch and redirects to `/conversation/[id]` — but the initial render shows the "No terminal output" empty state.

The `/api/sessions/recents` endpoint (`src/server.ts` line 637) maps cached conversations to session objects:

```typescript
const sessions = conversations.map((c) => ({
  id: c.id,
  status: "idle" as const,  // ← historical conversation pretending to be a session
  ptyAttached: false,
  // ...
}));
```

This was acceptable before ProjectChat, but now breaks the discriminated-union contract: mobile types expect `ProjectChat` with `type: "session" | "conversation"`, but Recents returns undifferentiated session-shaped objects.

**Timeline:**
- **May 2, 2026:** `/api/sessions/recents` added (see `docs/archive/implementation-plans/2026-05-02-quick-access-endpoints.md`)
- **May 6, 2026:** ProjectChat unified model designed (see `docs/archive/implementation-plans/2026-05-06-projects-cache-migration-prompt.md` Phase 12)
- **Result:** Quick Access was never migrated to the new endpoint

**Suggested fix (tb-mobile):**

1. **Replace `/api/sessions/recents` with `/project-chats`** in `hooks/useQuickAccess.ts`:
   ```typescript
   // Current (broken):
   const r = await createApiForServer(serverId).get<RecentsResponse>(
     `/api/sessions/recents?limit=${limit}`,
   )
   
   // Fixed:
   const r = await createApiForServer(serverId).get<{ items: ProjectChat[] }>(
     `/project-chats?limit=${limit}`,
   )
   ```

2. **Update `QuickAccessStrip.tsx`** to route based on `ProjectChat.type`:
   ```typescript
   const handleOpenSession = () => {
     if (!activeItem?.serverId) return
     const [, id] = activeItem.id.split('::')
     
     // Check type if the item carries it (future-proof for when recents uses /project-chats)
     const chat = recentsData?.items?.find(c => c.id === id)
     if (chat?.type === 'conversation') {
       router.push(`/conversation/${id}?server=${activeItem.serverId}`)
     } else {
       router.push(`/session/${id}?server=${activeItem.serverId}`)
     }
     setActiveItem(null)
   }
   ```

3. **Update `allItems` mapping** in `QuickAccessStrip.tsx` to preserve the `type` field from the response so the tap handler can branch correctly.

**Alternative (streamer-side, breaking change):** Deprecate `/api/sessions/recents` entirely and have mobile migrate to `/project-chats`. This is the long-term direction but risks breaking older mobile builds. Safer to fix mobile first, then deprecate the legacy endpoint in a future release.

**Workaround for users today:** Pull-to-refresh the conversation list, then open the conversation from the "history" section instead of the Recents chips.

---

## `server.test.ts` grace-timer flake blocks CI

**Status (2026-07-22):** 🟡 Partial — port/grace fixes in [PR #248](https://github.com/RonenMars/threadbase-streamer/pull/248); polling follow-up open as [PR #245](https://github.com/RonenMars/threadbase-streamer/pull/245).

**Symptom:** The `ptyGracePeriodMs = 0 disables auto-hold` block in `__tests__/server.test.ts` fails intermittently despite no changes to that test. All five PRs merged on 2026-07-16 (#209–#213) had a red Test gate because of it. CI deterministically misses the `putOnHold("disable-grace-sess")` call in `holds immediately on an explicit hold_session even when grace is 0`; a full local file run instead intermittently fails `still arms a grace timer on disconnect when grace is positive`. Either test passes in isolation.

**Likely cause:** The tests run under Vitest's single-fork configuration and use process-global prototype spies, shared session id `disable-grace-sess`, fresh WebSocket servers, and fixed 50 ms waits for WebSocket round trips. The root cause could be an insufficient fixed wait, cross-test teardown/state leakage, or both. SQLite locking is unlikely for this block because it uses `disableDb: true`.

**Reproduction:** Use the Node version from `.nvmrc` and current dependencies, then run `npx vitest run __tests__/server.test.ts` repeatedly. Also run `npm test` to match CI's full-suite ordering. Record the baseline failure rate and which assertion fails before changing anything.

**Suggested fix:** First replace fixed sleeps with a deterministic condition or event. If needed, make session ids unique and guarantee server/socket/timer teardown with scoped spies. Avoid a blanket retry or a Vitest configuration change unless evidence rules out test-level isolation.

**Done when:** The smallest verified fix has zero failures across at least 10 consecutive runs of both the focused file and full `npm test`, followed by `npm run lint`.

---

## Server tests leak host data via the default `codexRoots`

**Status (2026-07-22):** ✅ DONE — isolation in [PR #235](https://github.com/RonenMars/threadbase-streamer/pull/235) / [PR #239](https://github.com/RonenMars/threadbase-streamer/pull/239).

**Symptom:** A test that boots a real `StreamerServer` and reads conversations "from disk" passes on CI but is host-dependent locally — it silently scans the developer's real `~/.codex/sessions`. Concretely, `__tests__/cacheless-degradation.test.ts` failed on a machine with 189 real Codex rollouts (`expected 0 to be greater than 0` on the "serves conversation detail from disk" assertion, when one real conversation served zero messages); it was green on CI because the runner's home has no `~/.codex/sessions`. Fixed for that one test in `fix/degraded-disk-scan-profiles`, but the trap remains for any future server test.

**Root cause:** `ServerConfig.codexRoots` defaults to `[join(homedir(), ".codex", "sessions")]` (`src/server.ts:269`). A test can scope Claude JSONLs to fixtures via `scanProfiles`, but unless it *also* passes `codexRoots: []` the scanner still globs the real host Codex directory. `scanProfiles` and `codexRoots` are two independent inputs and only the first is obviously "the fixtures knob", so the second is easy to forget. Five test files already work around it (`server.test.ts`, `codex-scan.test.ts`, `server-shutdown.test.ts`, `contracts/test-helpers.ts`, `e2e/api-e2e.test.ts` all pass `codexRoots: []`), which is evidence the footgun is real and recurring rather than a one-off.

**Suggested fix:** Introduce a single test helper that constructs a host-isolated `StreamerServer` — defaulting `codexRoots: []`, `disableDb: true`, and a temp `cacheDir`/`scanProfiles` — and migrate the existing ad-hoc boots to it. Then a new server test is isolated by construction instead of by remembering the knob. Alternatively (weaker), lint/grep guard: fail CI if a `new StreamerServer(` in `__tests__/` sets `scanProfiles` without `codexRoots`. The helper is preferable because it also centralizes the temp-dir + teardown boilerplate these tests repeat.

**Done when:** A server-boot test written without thinking about Codex reads zero host data by default, and `grep -rL "codexRoots" __tests__` over files that `new StreamerServer` with `scanProfiles` returns nothing (or the guard passes).

---

## `enrichResumedSessionAsync` writes its enrichment to a throwaway copy — FIXED

**Status (2026-08-01):** ✅ DONE — [PR #336](https://github.com/RonenMars/threadbase-streamer/pull/336). Found while extracting `resumeSession()` in [PR #324](https://github.com/RonenMars/threadbase-streamer/pull/324) and deliberately left out of that refactor so it would get a deliberate fix.

**What shipped**, all three parts in one PR so the guard landed with the instance it catches:

- `SessionStore.get()` returns `Readonly<SessionResponse>`, `list()` returns `readonly Readonly<SessionResponse>[]`. Mutating a response copy is now a **compile error**, so this bug cannot be written again. All four getters carry doc comments naming which side of the copy/reference split they are on.
- `enrichResumedSessionAsync` writes through `updateManaged()`, and `resumeSession()` reads its response **after** enrichment — which settles the open design question below: the `201` body now carries the enriched shape rather than the pre-enrichment one.
- `handleGetSession`'s two legitimate mutations build a new object instead.

**Two findings from doing it**, both worth keeping:

1. **The blast radius proved it was a one-off, not a pattern.** `tsc` flagged property mutation in exactly the two functions predicted and nowhere else; the remaining errors were array variance on already-non-mutating helpers. Had it flagged more, each would have been another instance of this bug.
2. **The naïve port would have been worse than the bug.** Beyond the `Date`-versus-ISO-string mismatch described below, `new Date(<unparseable>)` yields an `Invalid Date` that `managedToResponse` throws on — so a corrupt cached timestamp would have turned a silent no-op into a **500 on `GET /api/sessions/:id`**. The fix reuses the existing `parseIsoDateOrNull` so an unparseable value lands as absent.

The original analysis is kept below: the class it describes is what motivated the `Readonly` guard, and the reasoning is worth having if that guard is ever questioned or relaxed.

**Symptom:** A resumed session never gains most of the metadata the resume path goes to the trouble of computing. `sessionName`, `messageCount`, `account`, `filePath`, `model`, `preview`, `firstMessageText`/`firstMessageAt`, `lastMessageText`/`lastMessageAt`, `projectId` and `resumedFromConversationId` are all resolved and then discarded. Not user-reported — the fields are usually repopulated from the scanner/cache on a later list read, which is why this has stayed invisible.

**Root cause:** `enrichResumedSessionAsync` (`src/server.ts:4410`) starts with

```ts
const session = this.sessionStore.get(sessionId, this.ptyAttachedIds());
```

but `SessionStore.get()` (`src/session-store.ts:82`) returns `managedToResponse(managed, …)` — a **freshly constructed `SessionResponse` object literal**, not a reference into the store. Every subsequent `session.<field> = …` therefore mutates a local that is dropped when the function returns.

Two things are *not* broken, which is why the bug is easy to miss: the repository writes in the same function (`projectsRepo.upsertProjectByPath`, `conversationsRepo.updateConversationProjectId`) act on real repositories and do persist. And the caller does not read the mutated object either — `resumeSession()` builds its own response before calling this, so nothing observes the lost writes at the call site.

**Suggested fix — not a one-line swap.** The obvious move is `sessionStore.updateManaged(sessionId, {...})` (`src/session-store.ts:34`), which `Object.assign`s into the stored object. But the store holds a `ManagedSession` while this function was written against a `SessionResponse`, and the two disagree on types for the date fields:

| Field | `ManagedSession` (`src/types.ts:78,80`) | `SessionResponse` (`src/types.ts:380`) |
|---|---|---|
| `firstMessageAt` | `Date` | `string` (ISO) |
| `lastMessageAt` | `Date` | `string` (ISO) |

The current code assigns `new Date(...).toISOString()` — correct for the response shape, wrong for the store. Porting it verbatim would put ISO strings where `managedToResponse` later calls `.toISOString()` on them, which throws. Convert to `Date` when writing to the store and let `managedToResponse` do the serialization, exactly as it already does for `startedAt`.

Worth deciding at the same time whether the enrichment should reach the resume response at all. Today `resumeSession()` computes its response *before* calling this, so even a correct fix leaves the 201 body unenriched; a caller that wants the enriched shape must re-read after. Either re-read and return the enriched response, or document that the 201 is intentionally the pre-enrichment shape — the current arrangement is neither.

**Done when:** After a resume, `sessionStore.getManaged(sessionId)` carries the enriched fields (assert `sessionName` and `projectId` specifically), the date fields are `Date` instances rather than strings, and a subsequent `GET /api/sessions/:id` serializes them without throwing. A regression test should fail if the write goes back to a copy — assert against the store, never against the object the function happens to hold.

### The class, not just this instance

Fixing only `enrichResumedSessionAsync` leaves the trap that produced it. `SessionStore` exposes two pairs of getters with **opposite mutation semantics and nothing in the types to tell them apart**:

| Method | Returns | Mutating the result |
|---|---|---|
| `getManaged(id)` (`src/session-store.ts:45`) | `this.managed.get(id)` — the **live object** | changes the store |
| `get(id, ptyAttachedIds)` (`:82`) | `managedToResponse(…)` — a **fresh copy** | changes nothing |
| `listManaged()` (`:56`) | live references | changes the store |
| `list(ptyAttachedIds)` (`:63`) | fresh copies | changes nothing |

Worse, mutating a copy is *correct* in one context. `handleGetSession` (`src/server.ts:4132`) does exactly that — decorating the response with `failureReason` and the reconciled `lifecycle` before serving it — and that is the right use of a copy.

So the codebase contains a normalised idiom, "get a session, mutate it, done", that is right when building a response and silently wrong when persisting state. The next person to copy `handleGetSession`'s shape into a persistence context reintroduces this bug, and nothing will object. That is how this one was written in the first place.

**Prevention, in order of strength:**

1. **Type-level (recommended).** Return `Readonly<SessionResponse>` from `get()` and `readonly Readonly<SessionResponse>[]` from `list()`. Every mutation of a copy becomes a compile error — including the one in `enrichResumedSessionAsync`, so the bug could not have been written. The two legitimate sites in `handleGetSession` build their own object instead (`{ ...session, failureReason, lifecycle }`), which reads better anyway. This is the only option that cannot regress.
2. **Naming.** Rename `get`/`list` to `snapshot`/`snapshotAll` (or `toResponse`) so the copy semantics are visible at the call site. Cheap, but no compile-time guarantee.
3. **A doc comment.** Near-zero value alone — this bug was written directly against a store that already behaved this way.

Do (1). It is one signature change, two call sites in `handleGetSession` adjusted, plus the real fix above. Ship it as a single PR so the guard and the instance it catches land together.

**Done in [PR #336](https://github.com/RonenMars/threadbase-streamer/pull/336)** — option (1), as written. The table above is now enforced by the type system rather than by convention: `get()`/`list()` hand back `Readonly`, so writing to a copy no longer compiles. If a future change relaxes that, this section is the reason not to.

---

## Degraded-mode `findJsonlPath` ignores `scanProfiles` (hardcodes `~/.claude/projects`)

**Status (2026-07-22):** ✅ DONE — [PR #243](https://github.com/RonenMars/threadbase-streamer/pull/243).

**Symptom:** When the SQLite cache is unavailable (degraded mode), resolving a conversation's JSONL by UUID for the detail/tail read always walks `~/.claude/projects`, regardless of the server's configured `scanProfiles`. Not currently user-visible in production (prod uses the real home dir, which is correct), but it is a genuine isolation gap: a server configured to a non-default profile root serves detail reads from the wrong directory in degraded mode, and tests can't isolate this path. Latent — surfaced while investigating the `codexRoots` leak above, not independently reported.

**Root cause:** `findJsonlPath(uuid)` (`src/server.ts:1686`) hardcodes `const projectsDir = join(homedir(), ".claude", "projects")` and walks its children, ignoring `this.scanProfiles` entirely. Every other disk-discovery site derives the projects dir from the profiles (warm-up watcher at `src/server.ts:916-923`, the scanner scans via `profiles: this.scanProfiles`), so `findJsonlPath` is the one place that diverges. It's called from three sites (the two conversation-detail lookups and the session-file resolver around `src/server.ts:1802`, `:1907`, `:2485`). Note: the *live-session* watcher `watchForJsonl` (`src/server.ts:3135`) also hardcodes home, but that is correct — a live Claude Code PTY always writes under the real `~/.claude/projects`, so it is intentionally not profile-scoped and out of scope for this entry.

**Suggested fix:** Add a single private `projectsDirs()` helper returning the same set the warm-up watcher uses — enabled `scanProfiles` mapped to `join(profile.configDir, "projects")`, else the `~/.claude/projects` fallback — and rewrite `findJsonlPath` to walk each of those dirs (preserving the existing per-dir + `subagents/` sub-walk). That makes profile scoping the single source of truth for disk discovery. A degraded-mode detail-read test with a fixture profile then resolves only fixture JSONLs. Leave `watchForJsonl` alone.

**Done when:** `findJsonlPath` resolves JSONLs from the configured `scanProfiles` roots (verified by a degraded-mode detail-read test pointed at a fixture profile that has no `~/.claude/projects` counterpart), and the live-session `watchForJsonl` path is untouched.
