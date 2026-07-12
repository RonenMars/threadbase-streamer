# Live-conversation re-parse stall — "Couldn't load conversation / Fetch request has been canceled"

**Date:** 2026-07-12
**Status:** Diagnosed. Fix not yet applied.

## Symptom

Mobile shows:

```
Couldn't load conversation
Failed to reach https://tb.rbv1000.win/api/conversations/6762a0c9-867c-4e03-bb77-d1b56612dad4?msg_limit=80
Error: fetch failed: Fetch request has been canceled
```

The conversation being opened has a **live PTY session actively writing its JSONL**.

## It is NOT session/conversation confusion

The conversation ID resolves fine:

- Local probe: `http=200 time_total=0.024s size=210214` (24 ms)
- Through the Cloudflare tunnel (when not mid-stall): `http=200 time_total=0.206s` (206 ms)

The data and the ID mapping are healthy. `"Fetch request has been canceled"` is the **client** aborting after its own timeout, not a server 500.

## Evidence

Server logs (`~/.threadbase/logs/stdout.log`) during the incident:

- Requests from `Threadbase/163 CFNetwork` returned status `597` (the `ALREADY_HANDLED` sentinel — handler ran and wrote directly to `c.env.outgoing`) with `ms` of **120000–190000**.
- **~30 requests completed within the same second** (e.g. 14 at `14:44:48`), all with 2–3-minute `ms`. They didn't *arrive* then — they were **released in a batch** the instant the event loop unblocked. Signature of an event-loop stall: the log timestamp is when the line was *written*, i.e. when the loop finally freed.
- Stalls came in **recurring bursts** (14:05, 14:08, 14:10, 14:14, 14:39–14:45…) hitting **many different conversation IDs**, not one → a **global** event-loop stall, not a per-conversation data problem.
- Each stall window overlapped `[pty.chunk] 6762a0c9 … status=waiting_input` — a **live session writing its JSONL ~every second**.

Scale of the scan surface: **3,308 JSONL files, 1.4 GB total**; the live file `6762a0c9` was **0.6 MB** and growing.

## Root cause

A self-inflicted re-parse storm on the *actively-written* conversation:

1. Conversation `6762a0c9` has a live PTY session writing its JSONL ~every second.
2. Every `/api/conversations/:id` request hits `findConversationByUuid` → `isConversationSnapshotStale(fromIndex)` returns **true** (file mtime is always newer than the scanner snapshot for a live file) → calls `scanner.refreshFile(filePath)`.
   - `src/server.ts:1613` (the stale-snapshot branch in `findConversationByUuid`)
   - also fired at `src/server.ts:421` on every turn end
3. `refreshFile` **drops the persistent paging checkpoints** (`@threadbase-sh/scanner` `index.js:2228`, `checkpoints.remove(filePath)`) / **evicts the in-memory LRU** (`index.js:2882`).
4. The next page read finds no checkpoints → `buildCheckpoints()` (`index.js:1643`) **re-streams and re-parses the whole file from offset 0**, synchronously: `JSON.parse` per line (`streamMessages` / `reduceLine`) plus `structuredClone(state)` every 500 messages (`index.js:1654`).
5. Mobile times out on the slow response, **retries**. Each retry repeats steps 2–4. Retries **serialize on the single event loop** → 2–3-minute event-loop stall → all queued requests flush at once with huge `ms`, and the client aborts → *"Fetch request has been canceled."*

A single 0.6 MB re-parse is not a multi-minute stall by itself. The multi-minute number is the **pileup**: N synchronous re-parses serialized behind each other, with the file growing between retries. Bursts get worse over a session because the file grows, so each re-parse costs more — matching the escalating-burst pattern in the logs.

### What is NOT the cause (ruled out)

- **Directory-watcher rescan** — the debounce (`directoryScanDebounceMs`, default 1000) is correctly applied and only flips a `scannerStale` boolean; it does not trigger repeated full rescans. `conversationWatcher.ts` `watchDirectory` → `server.ts:346-370` (`markScannerStaleDebounced`) is not the blocker.
- **`conversations/count`** — fast (149 ms max); already served from cache with background reconcile.
- **`isAgentFile` sync probe** — early-exits at the first `"entrypoint":` marker and caches; typically one 64 KB sync read. Secondary at worst.
- **SQLite queries** — synchronous (better-sqlite3) but per-row and cheap in the hot path; the full-metas fold is gated behind the debounced stale flag.

The blocker is specifically the **synchronous `JSON.parse` fold over the entire active JSONL**, re-triggered on every request because `refreshFile` evicts the caches that would otherwise avoid the re-parse.

## Fix options (cheapest first)

**A. Throttle / coalesce the per-file refresh (recommended, in-repo, ~15 lines).**
Don't `refreshFile` on *every* request for the same path. Coalesce: if a refresh for that path ran within the last N seconds or is in-flight, skip it and serve the current snapshot. A live conversation being a second stale is harmless; re-parsing it 30×/burst is the bug. Implement with a `Map<filePath, { ts, promise }>` around the `isConversationSnapshotStale` → `refreshFile` branch at `server.ts:1613`.
Regression test: hammer the detail endpoint for an actively-appended file and assert a single re-parse (not one per request).

**B. Upstream: make `refreshFile` not drop checkpoints on append (durable fix, cross-repo).**
An append-only file only needs checkpoints *after* the last preserved one re-derived, not all of them dropped. Fix lives in the published `@threadbase-sh/scanner` (`index.js:2228`). Bigger, requires a scanner release + version bump here.

**C. Serve live conversations from the SQLite cache tail instead of the scanner.**
The detail handler already has a tail fallback for missing files (`getConversationTail`). Route live/active sessions to the incrementally-updated cache and skip the scanner entirely for them.

## Recommendation

Ship **A** now (stops the herd, in-repo, testable), file **B** upstream as the real durable fix.
