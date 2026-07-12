# Session prompt — tb-streamer: guard rails + offset index (re-parse stall fix)

> **Run in:** a fresh git worktree of `tb-streamer` (branch from a `main` that contains `docs/superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md` — read it first)
> **Deliverable:** TWO sequential PRs.
> PR 1 (guard rails) has no dependencies — build it now.
> PR 2 (offset index) requires `@threadbase-sh/scanner` on npm with the `parseJsonlLine` export — check npm before starting; if unavailable, STOP after PR 1 and report.

---

Fix a production event-loop stall: opening a conversation that has a live PTY session appending ~1 JSONL line/second re-parses the entire file on every request, serializes concurrent client retries, and freezes the server for 2-3 minutes.

## Root cause (in this repo)

1. `src/server.ts:1613` (`findConversationByUuid` stale branch): a live file's mtime is always newer than the snapshot, so `isConversationSnapshotStale()` → true on EVERY request → `scanner.refreshFile(filePath)`.
2. `src/server.ts:421` (turn-end watcher hook) fires the same `refreshFile` per change batch.
3. `refreshFile` (scanner 0.9.4) drops paging checkpoints + evicts its parse LRU, so the next read re-parses the whole file from byte 0, synchronously, on the main thread.
4. Mobile aborts at 8s, retries, and re-invalidates on every WS reconnect — each retry queues another full parse.
   Verified: ~30 requests released in same-second batches with ms=120000-190000.

## PR 1 — guard rails (no dependencies, ship first)

### 1. Single-flight + TTL around both `refreshFile` call sites

One `Map<filePath, { promise, completedAt }>`:
- refresh in flight for the path → callers await the SAME promise;
- refresh completed within `REFRESH_TTL_MS = 2000` → skip entirely, serve the snapshot;
- entries dropped on settle + TTL expiry (map bounded by the active-file set).

### 2. Live-session bypass

In `findConversationByUuid`: if `this.ptyManager.hasSession(id)` → serve the current snapshot with NO stale-check and NO refresh.
Rationale: the stall only occurs on live conversations; live clients receive `conversation_event` lines over WS; mobile refetches once on the `running → not-running` transition (the reconcile point); the TTL-throttled turn-end refresh keeps the snapshot advancing between requests.

### 3. Stale-while-revalidate

When a refresh is warranted and a snapshot EXISTS: respond from the snapshot immediately; run the refresh in the background, tracked via the existing `trackCacheWrite` pattern so `close()` awaits it.
Only a conversation with NO snapshot awaits the parse — single-flighted, so a cold thundering herd costs one parse.

### PR 1 tests (write first)

1. Hammer the detail endpoint ×20 concurrently on an actively-appended file → exactly ONE underlying `refreshFile` call (spy).
2. `hasSession(id)` true → ZERO `refreshFile` calls from the detail path.
3. SWR ordering: response resolves before the background refresh completes; the next request after completion sees the refreshed data.
4. TTL: two sequential requests inside 2s → one refresh; spaced beyond 2s → two.

## PR 2 — offset index (gated on the scanner release)

Precondition: `npm view @threadbase-sh/scanner` shows a version exporting `parseJsonlLine` (added by the parallel scanner PR).
Bump the dependency to it.

### Migration `009` in `cache.db` (follow `src/db/migrations/` + `sqlite-migrate.ts` pattern)

```sql
CREATE TABLE conversation_file_state (
  path               TEXT PRIMARY KEY,
  identity           TEXT NOT NULL,      -- inode, else fingerprint of first N bytes
  size               INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  byte_offset        INTEGER NOT NULL,   -- end of last fully-indexed line
  last_message_index INTEGER NOT NULL
);

CREATE TABLE conversation_message_index (
  conversation_id TEXT    NOT NULL,
  message_index   INTEGER NOT NULL,
  byte_offset     INTEGER NOT NULL,
  byte_length     INTEGER NOT NULL,
  uuid            TEXT,
  role            TEXT,
  ts              INTEGER,
  PRIMARY KEY (conversation_id, message_index)
);
```

### Writers

- **Incremental:** `ConversationWatcher`'s per-line tail extends the index per appended line, classifying with the scanner's `parseJsonlLine` (NEVER a local reimplementation — semantics must not drift).
  Track cumulative byte offsets per line during the tail read.
  Lines that don't produce a message (summary/sidecar records) get no index row.
- **Backfill:** on-demand when a detail request finds no/stale `file_state`: yielding walk (`await setImmediate()` per ~1000 lines), single-flighted per file, writes index rows + `file_state`.
  The triggering request is served by the scanner path (PR 1 guards it) while backfill proceeds.

### Read path

Detail/delta request where `file_state` matches `stat` (same identity, size >= byte_offset):
SQL window select for the slice (tail `msg_limit` | `before_index` | `after_index`) → `pread` exactly those `(byte_offset, byte_length)` ranges → parse only those lines → respond.
Identity mismatch or size < byte_offset → truncation rule: delete the file's index rows + `file_state`, serve via scanner fallback, enqueue backfill.
Cold index → scanner fallback.

### Phase-2 enablers (part of PR 2)

- Stamp `seq` (= `message_index`) on `conversation_event` / `conversation_events` WS entries that correspond to indexed messages; omit for non-message lines.
- Include the current conversation `etag` in `after_index` delta responses (inside `message_pagination`) as the client's cursor-validity token.

### PR 2 tests

1. Append lines → watcher extends the index; a subsequent `after_index` delta returns exactly the new messages, reading only their byte ranges (spy on file reads).
2. Window correctness across the incremental boundary (a page spanning backfilled + tailed regions).
3. Truncate / replace the file → index dropped, scanner fallback correct, backfill restores.
4. Torn write: a partial line at EOF is not indexed; completed on the next event; `byte_offset` never advances past an unparsed line.
5. Migration 009 idempotency + clean upgrade of an existing `cache.db`.
6. Perf smoke: synthetic 100 MB JSONL, warm index → detail p95 < 50 ms; event-loop max delay < 50 ms during active append (`perf_hooks.monitorEventLoopDelay`).

## Constraints (both PRs)

- Repo conventions: tests in `__tests__/` (vitest, globals on), `npm run lint && npm test` before committing, conventional commits, feature branch + PR — never push to main.
- Use the Node version in `.nvmrc` (better-sqlite3 ABI).
  The full local suite can be slow on this machine — verify with scoped `npx vitest run <files>` locally and treat CI as the full-suite gate.
- Direct-write handlers return the 597 `ALREADY_HANDLED` sentinel — follow the existing pattern in `src/api/routes/` when touching endpoints.

Full design + rationale: `docs/superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md`.
