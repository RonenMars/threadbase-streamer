# Backlog — Threadbase Streamer

Known bugs and unresolved issues. Self-contained enough to pick up without re-reading the original conversation.

For planned features (work that adds new behavior rather than fixing broken behavior) see [ROADMAP.md](ROADMAP.md).

---

## Stale conversation history vs. fresh resume

**Symptom:** The mobile conversation history list shows old `lastMessage` / `preview` / `messageCount` / `lastActivity` for a conversation, but opening (Resume session) renders the latest messages. Reported 2026-05-31 with three screenshots in `.threadbase-uploads/044a9f81-…/IMG_5407-5409.heic`.

**Root cause (three converging gaps):**

1. **`GET /api/conversations` has no freshness check.** `handleListConversations` in `src/server.ts:545` returns straight from `ConversationCache.listConversations()` whenever the cache is open and `?refresh=1` is not set — no mtime / inode / last-conversation-id gate. Older mobile builds hitting this endpoint see whatever was warmed into the cache at server startup until something else triggers a rebuild.
2. **`/project-chats` mtime check is too coarse.** `shouldRefreshProjectsFromHdd` (`src/services/conversations/shouldRefreshProjectsFromHdd.ts`) stats only `~/.claude/projects` and compares its mtime to `cache_metadata.conversations_last_indexed_at`. POSIX directory mtime updates only when *direct* entries change — appending to an existing JSONL inside `~/.claude/projects/<existing-project>/` does NOT bump the parent mtime, so the safety net misses the two most common cases: (a) continuing an existing conversation, (b) starting a new conversation in an existing project.
3. **The chokidar watcher only tails managed sessions.** `ConversationWatcher.watch(filePath)` is called from `handleResume` (line 1372) and `handleStartSession` (line 1411). There is no `watchDirectory` on `~/.claude/projects`. Conversations written by external Claude Code processes (the normal case for desktop users) never feed `updateFromLine`, so the cache stays at startup state until a refresh triggers.

Resume *appears* fresh because `findConversationByUuid` → `scanner.getConversation(uuid)` re-parses the JSONL on a scanner-LRU miss (LRU size 5). On a repeated open the LRU can serve stale content too — but in practice the first open after a streamer restart usually misses the LRU, so it looks fresh next to the cache.

**Suggested fix paths (pick one or combine):**

- **A.** Add a `shouldRefreshProjectsFromHdd` call to `handleListConversations` mirroring `/project-chats`. Cheap, restores parity between the two list endpoints.
- **B.** Replace the parent-dir mtime check with a recursive stat: iterate child project subdirectories (one level deep), take `max(mtime)`. Catches new JSONLs in existing projects without scanning every file.
- **C.** Use `cache_metadata.last_conversation_id` + the scanner's latest-id from a fast metadata-only pass to detect drift. More work, but bounded.
- **D.** Wire a `fileWatcher.watchDirectory(~/.claude/projects)` from `server.ts` startup so any add/change inside ticks the cache dirty without needing a request to trigger refresh. Existing `onConversationChanged` hook in `ConversationWatcher` is unused — it was designed for exactly this.

Option **D + A** together is the cleanest: D fixes the root cause (cache no longer drifts) and A makes `/api/conversations` consult the same freshness gate so older mobile clients also benefit. Tests in `__tests__/should-refresh-projects.test.ts` exercise the mtime path with `utimesSync` on the parent dir — they pass but do not catch the real-world child-dir gap, so any fix should add a test that creates a JSONL inside an existing project subdirectory and asserts the next list call surfaces it without `?refresh=1`.

**Workaround for users today:** the mobile client can pass `?refresh=1` (legacy) or `?refreshConversations=1` (project-chats) to force a rescan. Not a fix — just a knob.

---

## Log truncation races with the still-running streamer fd

**Symptom:** After `npm run deploy` or `tb-streamer prod logs --clear`, `~/.threadbase/logs/stdout.log` / `stderr.log` can appear to contain NUL bytes from offset 0..N when `tail`ed, instead of being empty. Subsequent log lines are appended far past the visible end of the file.

**Root cause:** Both code paths truncate the log files via `: > file` (`scripts/deploy.sh:823-831`) / `fs.writeFileSync(file, "")` (`cli/prod.ts:123-144`) while the supervised streamer — and launchd itself, holding `StandardOutPath` / `StandardErrorPath` open — still have file descriptors at offset N. POSIX `truncate(2)` sets the inode size to 0 but does **not** reset any open writer's seek offset. The next `write(2)` from the old streamer (final shutdown line before `kickstart -k` swaps it out, or any line if `--clear` runs against a healthy daemon) lands at offset N and the kernel extends the file as sparse — leaving NUL bytes 0..N that `tail` reads as garbage.

The comment in `runProdLogs` (*"Removing the inode would leave the daemon writing to a ghost file. `: > file` semantics"*) is correct about unlink but wrong about truncate — the kernel-level write offset is per-fd, not per-inode.

**Suggested fix:** Either (a) reorder so the supervised process restarts *first* — `launchctl kickstart -k` opens fresh fds at offset 0 in the new process, so a separate truncate is unnecessary in `cmd_deploy`; for `runProdLogs --clear`, do `kickstart -k` *after* the truncate so the daemon reopens — or (b) send SIGUSR1/SIGHUP to the supervised process and have it reopen its log fds in-process. Tests should reproduce by writing N bytes, opening a tail fd, truncating, then writing one more byte and asserting the visible file size matches the expected post-truncate state.

---

## Busy-wait CPU spin in `bootoutAgent`

**Status:** Fixed on `fix/bootout-agent-busy-wait` — poll wait uses `Atomics.wait` (50 ms) instead of a busy-spin.

**Symptom:** `tb-streamer prod restart` (and the dev-takeover path) pegs a full CPU core for up to 2 seconds while launchd tears down the agent.

**Root cause:** `src/lifecycle/launchd.ts:33-43` polls `isAgentLoaded()` (which spawns `launchctl print`) on a 50 ms cadence — but the inter-poll wait is a tight `while (Date.now() < wake) { /* spin */ }` loop, not a sleep. With the default 2 s deadline that's up to 40 iterations of 50 ms hot-spinning. The justification comment (*"Atomics.wait would need a SharedArrayBuffer; spawnSync('sleep') is expensive"*) is misleading — `execFileSync("sleep", ["0.05"])` is ~1 ms of fork/exec overhead, dramatically cheaper than 50 ms of pegged CPU.

**Suggested fix:** Replace the inner `while` with `execFileSync("sleep", ["0.05"], { stdio: "ignore" })`, or use `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)` to stay in-process. Either is orders of magnitude cheaper than the spin.

---

## `bootstrapAgent` false-positive on exit-5 + empty stderr

**Symptom:** Rare — `tb-streamer prod restart` reports success even though the new build is not actually loaded (the old / stale agent is). Hard to spot without `prod doctor`.

**Root cause:** `src/lifecycle/launchd.ts:67-68` accepts `exit 5 + empty stderr` as success whenever `isAgentLoaded()` returns true. But `isAgentLoaded()` only confirms *something* with label `LAUNCHD_LABEL` is loaded — it does not check that the plist on disk matches what's running. If a stale incarnation is loaded and `launchctl bootstrap` fails with exit 5 / empty stderr for an unrelated reason (e.g. malformed new plist on a newer launchctl), this branch swallows the failure.

In practice `prod restart` calls `bootoutAgent` first (which now polls), so the loaded state is empty by the time `bootstrapAgent` runs and this branch is unreachable on the happy path. The regression risk exists for any standalone caller.

**Suggested fix:** Tighten the empty-stderr fallback to require that bootout was *just* run (caller-provided flag), or fall through to throw in the standalone case. At minimum, downgrade the comment from "most often the same case" to acknowledge the false-positive risk and recommend `prod doctor` for verification.

---

## `--clear` truncate failure leaves stdout cleared but stderr not

**Symptom:** `tb-streamer prod logs --clear` reports `failed to truncate <stderr>: EACCES` (or similar) but `stdout.log` has already been wiped. Recovery requires re-running after fixing perms with stdout already empty.

**Root cause:** `cli/prod.ts:134-143` loops `for (const f of [paths.stdout, paths.stderr])` and returns the first error, with no rollback. POSIX has no atomic two-file truncate.

**Suggested fix:** Best-effort both files and report a combined success/failure message — e.g. *"cleared stdout; failed to truncate stderr: EACCES"* — so the user knows the partial state instead of assuming nothing happened.

---

## Quick Access Recents tapping historical conversations shows "No terminal output"

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

**Symptom:** The `ptyGracePeriodMs = 0 disables auto-hold` block in `__tests__/server.test.ts` fails intermittently despite no changes to that test. All five PRs merged on 2026-07-16 (#209–#213) had a red Test gate because of it. CI deterministically misses the `putOnHold("disable-grace-sess")` call in `holds immediately on an explicit hold_session even when grace is 0`; a full local file run instead intermittently fails `still arms a grace timer on disconnect when grace is positive`. Either test passes in isolation.

**Likely cause:** The tests run under Vitest's single-fork configuration and use process-global prototype spies, shared session id `disable-grace-sess`, fresh WebSocket servers, and fixed 50 ms waits for WebSocket round trips. The root cause could be an insufficient fixed wait, cross-test teardown/state leakage, or both. SQLite locking is unlikely for this block because it uses `disableDb: true`.

**Reproduction:** Use the Node version from `.nvmrc` and current dependencies, then run `npx vitest run __tests__/server.test.ts` repeatedly. Also run `npm test` to match CI's full-suite ordering. Record the baseline failure rate and which assertion fails before changing anything.

**Suggested fix:** First replace fixed sleeps with a deterministic condition or event. If needed, make session ids unique and guarantee server/socket/timer teardown with scoped spies. Avoid a blanket retry or a Vitest configuration change unless evidence rules out test-level isolation.

**Done when:** The smallest verified fix has zero failures across at least 10 consecutive runs of both the focused file and full `npm test`, followed by `npm run lint`.

---

## Server tests leak host data via the default `codexRoots`

**Symptom:** A test that boots a real `StreamerServer` and reads conversations "from disk" passes on CI but is host-dependent locally — it silently scans the developer's real `~/.codex/sessions`. Concretely, `__tests__/cacheless-degradation.test.ts` failed on a machine with 189 real Codex rollouts (`expected 0 to be greater than 0` on the "serves conversation detail from disk" assertion, when one real conversation served zero messages); it was green on CI because the runner's home has no `~/.codex/sessions`. Fixed for that one test in `fix/degraded-disk-scan-profiles`, but the trap remains for any future server test.

**Root cause:** `ServerConfig.codexRoots` defaults to `[join(homedir(), ".codex", "sessions")]` (`src/server.ts:269`). A test can scope Claude JSONLs to fixtures via `scanProfiles`, but unless it *also* passes `codexRoots: []` the scanner still globs the real host Codex directory. `scanProfiles` and `codexRoots` are two independent inputs and only the first is obviously "the fixtures knob", so the second is easy to forget. Five test files already work around it (`server.test.ts`, `codex-scan.test.ts`, `server-shutdown.test.ts`, `contracts/test-helpers.ts`, `e2e/api-e2e.test.ts` all pass `codexRoots: []`), which is evidence the footgun is real and recurring rather than a one-off.

**Suggested fix:** Introduce a single test helper that constructs a host-isolated `StreamerServer` — defaulting `codexRoots: []`, `disableDb: true`, and a temp `cacheDir`/`scanProfiles` — and migrate the existing ad-hoc boots to it. Then a new server test is isolated by construction instead of by remembering the knob. Alternatively (weaker), lint/grep guard: fail CI if a `new StreamerServer(` in `__tests__/` sets `scanProfiles` without `codexRoots`. The helper is preferable because it also centralizes the temp-dir + teardown boilerplate these tests repeat.

**Done when:** A server-boot test written without thinking about Codex reads zero host data by default, and `grep -rL "codexRoots" __tests__` over files that `new StreamerServer` with `scanProfiles` returns nothing (or the guard passes).

---

## Degraded-mode `findJsonlPath` ignores `scanProfiles` (hardcodes `~/.claude/projects`)

**Symptom:** When the SQLite cache is unavailable (degraded mode), resolving a conversation's JSONL by UUID for the detail/tail read always walks `~/.claude/projects`, regardless of the server's configured `scanProfiles`. Not currently user-visible in production (prod uses the real home dir, which is correct), but it is a genuine isolation gap: a server configured to a non-default profile root serves detail reads from the wrong directory in degraded mode, and tests can't isolate this path. Latent — surfaced while investigating the `codexRoots` leak above, not independently reported.

**Root cause:** `findJsonlPath(uuid)` (`src/server.ts:1686`) hardcodes `const projectsDir = join(homedir(), ".claude", "projects")` and walks its children, ignoring `this.scanProfiles` entirely. Every other disk-discovery site derives the projects dir from the profiles (warm-up watcher at `src/server.ts:916-923`, the scanner scans via `profiles: this.scanProfiles`), so `findJsonlPath` is the one place that diverges. It's called from three sites (the two conversation-detail lookups and the session-file resolver around `src/server.ts:1802`, `:1907`, `:2485`). Note: the *live-session* watcher `watchForJsonl` (`src/server.ts:3135`) also hardcodes home, but that is correct — a live Claude Code PTY always writes under the real `~/.claude/projects`, so it is intentionally not profile-scoped and out of scope for this entry.

**Suggested fix:** Add a single private `projectsDirs()` helper returning the same set the warm-up watcher uses — enabled `scanProfiles` mapped to `join(profile.configDir, "projects")`, else the `~/.claude/projects` fallback — and rewrite `findJsonlPath` to walk each of those dirs (preserving the existing per-dir + `subagents/` sub-walk). That makes profile scoping the single source of truth for disk discovery. A degraded-mode detail-read test with a fixture profile then resolves only fixture JSONLs. Leave `watchForJsonl` alone.

**Done when:** `findJsonlPath` resolves JSONLs from the configured `scanProfiles` roots (verified by a degraded-mode detail-read test pointed at a fixture profile that has no `~/.claude/projects` counterpart), and the live-session `watchForJsonl` path is untouched.
