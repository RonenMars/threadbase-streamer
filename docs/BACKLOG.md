# Backlog — Threadbase Streamer

Loose ends and follow-ups for `@threadbase/streamer`. Self-contained enough to pick up without re-reading the original conversation.

---

## Cleanup TODO

### Scanner repo visibility (A12)

`@threadbase/scanner` is consumed as a npm git URL dep (`github:RonenMars/threadbase-scanner#<tag>`) per CLAUDE.md. The repo migration plan called for making the repo public under MIT (commits `20a6060`, `ba36685`); that landed and tag `v0.3.0` is published, but the repo visibility flip on GitHub was deferred for manual review.

**Fix:** confirm `https://github.com/RonenMars/threadbase-scanner` is public and the README clearly states MIT licensing. If still private, flip visibility in GitHub repo settings and verify a clean clone works without auth (the streamer install path depends on this for end users without a GitHub token).

### Release pipeline stalled — Actions budget exhausted

The last 3 pushes to `main` (runs `26372378887`, `26372564655`, `26373635465`, all on 2026-05-24) failed within ~3-5 s with no failed *steps* — GitHub Actions is rejecting jobs at queue time because the account is over its monthly Actions spending limit. semantic-release config itself is fine; the latest successful release was `v1.0.1` on 2026-05-23.

Two release-worthy commits are merged but unreleased:
- `fda9e2a feat: filter agent conversations from cache via entrypoint marker (#4)` — minor bump
- `93e93ff fix: backfill project context for skeleton conversation cache rows (#3)` — patch

**Fix:** top up the Actions budget (or wait for the monthly reset), then re-run the latest failed workflow on `main`. Both commits will be picked up in one `1.1.0` release.

### Stale conversation history vs. fresh resume

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

Option **D + A** together is the cleanest: D fixes the root cause (cache no longer drifts) and A makes `/api/conversations` consult the same freshness gate so older mobile clients also benefit. Tests in `__tests__/should-refresh-projects.test.ts` exercise the mtime path with `utimesSync` on the parent dir — they pass but don't catch the real-world child-dir gap, so any fix should add a test that creates a JSONL inside an existing project subdirectory and asserts the next list call surfaces it without `?refresh=1`.

**Workaround for users today:** the mobile client can pass `?refresh=1` (legacy) or `?refreshConversations=1` (project-chats) to force a rescan. Not a fix — just a knob.

---

### Homebrew vs `scripts/deploy.sh` plist collision

The Homebrew tap ships its own launchd plist (`homebrew.mxcl.tb-streamer`) via `brew services`. Users who previously installed through `scripts/deploy.sh` already have `com.threadbase.streamer.plist` (or the newer lifecycle-shim variant) bound to port 8766. Running `brew services start tb-streamer` on top will start a second agent that crashes on `EADDRINUSE` until launchd throttles it.

Shipped today: caveats note in the formula tells users Homebrew + manual deploy are mutually exclusive. That bites the unlucky user who upgrades from manual → Homebrew without reading.

**Fix:** add a conflict check inside `tb-streamer serve` (or a dedicated `tb-streamer doctor` step) that, on startup, scans `launchctl list` for `com.threadbase.streamer*` labels other than `homebrew.mxcl.tb-streamer`. If found, exit 0 with a log line directing the user to either `launchctl bootout` the legacy agent or uninstall the Homebrew formula. Reuse the Supervisor / marker plumbing from `src/lifecycle/`. Add a matching check on Windows (Task Scheduler `Threadbase` task vs any Homebrew-equivalent — currently N/A but worth scaffolding).

## Sequencing

Nothing in this backlog is blocking. Address Scanner visibility before the next end-user-facing release announcement (otherwise `npm install` will fail for users without GitHub credentials).
