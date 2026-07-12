# Live-conversation re-parse stall — incremental indexing & delta sync design

**Date:** 2026-07-12
**Status:** Design approved. Implementation plan not yet written.
**Diagnosis:** [docs/design/live-conversation-reparse-stall.md](../../design/live-conversation-reparse-stall.md)
**Scope decision:** phased — streamer ships first (1a, 1b), scanner fix runs in parallel (owner-run prompt, see [prompts/2026-07-12-scanner-incremental-refresh-prompt.md](prompts/2026-07-12-scanner-incremental-refresh-prompt.md)), mobile follows (phase 2).

## 1. Problem

Opening a conversation that has a **live PTY session appending ~1 JSONL line/second** stalls the whole server:

1. Every `/api/conversations/:id` request sees `isConversationSnapshotStale()` → true (file mtime is always newer than the snapshot for a live file) and calls `scanner.refreshFile()` (`src/server.ts:1613`; also fired per turn at `src/server.ts:421`).
2. `refreshFile` drops the scanner's paging checkpoints and evicts its parse LRU, so the next read **re-parses the entire file from byte 0**, synchronously (`JSON.parse` fold + `structuredClone` every 500 messages).
3. Mobile times out (8 s abort), retries, and its WS reconnect handler invalidates the whole conversation query — every retry starts another full re-parse. Re-parses serialize on the event loop → 2–3-minute global stalls, ~30 piled-up requests released in same-second batches (verified in prod logs).

The client amplifies the server stall in a feedback loop: server stall → WS heartbeat fails → socket drops → mobile invalidates + refetches (`staleTime: 0`) → more parse load → deeper stall.

Design target from ecosystem evidence: Claude Code session files reach **multi-GB** upstream (anthropics/claude-code#22365, #18905). The design must be GB-proof, not just fix today's 65 MB worst case.

## 2. Goals

- **G1** — No request ever triggers an O(file-size) synchronous re-parse of a file that only grew.
- **G2** — Concurrent identical work is coalesced: N stacked retries cost one parse, not N.
- **G3** — Live conversations never pay a parse penalty for being live; the WS stream carries their delta.
- **G4** — A client holding messages `0..N` can fetch only `N+1..` (forward-cursor delta), validated by a cursor-validity token, over both REST and WS resume.
- **G5** — Mobile renders instantly from an on-device store on any open (foreground resume or cold start) and downloads only deltas. *(Phase 2 — designed here, implemented in tb-mobile.)*
- **G6** — All API changes are additive; released mobile clients keep working unchanged (per [docs/compatibility/tb-mobile.md](../../compatibility/tb-mobile.md)).

### Non-goals

- No worker-thread parse offload: returning a parsed multi-MB message array from a worker structured-clones it, costing roughly the parse itself. Offsets make workers unnecessary.
- No HTTP Range–based delta: raw byte ranges push JSONL parsing and torn-line handling onto the client; the message-index cursor is strictly better.
- No third-party sync engine (Replicache/PowerSync/ElectricSQL): the pattern is adopted (~1 query param + 1 WS field), not the dependency.

## 3. Current state (audited 2026-07-12)

### Streamer already has

- `after_index` forward cursor on the detail endpoint (from PR #193), used today only by anchored-search windows.
- `ETag`/`If-None-Match` with 304 on the tail page (`computeConversationEtag`).
- Per-line WS delta: `conversation_event` (single line) + `conversation_events` (batch).
- Live-session knowledge at request time: `ptyManager.hasSession(id)`.
- A chokidar tailer (`ConversationWatcher`) that already reads live files per appended line.
- SQLite cache (`cache.db`) — but it stores only a **10-message tail** per conversation, not full history.

### tb-mobile audit verdict: no cursor-based delta sync over a persistent cache

- `before_index` used for backward history backfill only; `after_index` never used for "what's new".
- ETag only on the tail page, held in an **in-memory** map — lost on restart.
- react-query → AsyncStorage persistence exists but `gcTime` is 5 min, so history evicts on rehydrate; `staleTime: 0` re-fetches on every open/focus/reconnect.
- WS has no resume cursor; every reconnect/resubscribe **invalidates the whole conversation** and refetches from scratch.
- Retry-storm mechanics: `staleTime: 0` + invalidate-on-every-WS-event + 3 same-key consumers mounted + 8 s/15 s AbortController timeouts + 1 silent transport retry, no throttle.

## 4. Research basis (distilled)

| Technique | Source | Use here |
|---|---|---|
| Byte-offset checkpointing; truncation = `size < offset`; identity = inode/fingerprint | Filebeat registry, Fluent Bit tail SQLite DB, Vector | Core of 1b and the scanner fix |
| Append-only sparse index (`{msgIndex → byteOffset}`); appends never invalidate | Kafka segment indexes | Scanner checkpoint redesign; kills `structuredClone` |
| Cooperative yielding (`setImmediate` per ~500–1000 lines) + single-flight | nodejs.org "Don't block the event loop" | 1a guard rails; scanner full-parse paths |
| Catch-up-then-live with resume cursor (`Last-Event-ID` semantics) | ElectricSQL HTTP API, Replicache pull, Linear sync | Phase 2 client flow |
| Prior art: per-transcript `{mtime, size, bytesRead}` incremental cache | Claude-Code-Agent-Monitor | Validates the exact approach |

## 5. Architecture — three pieces, no overlap

| Concern | Owner |
|---|---|
| Hot detail/delta reads (tail, `before_index`, `after_index`) | **1b — streamer offset index** (SQLite window lookup + `pread` of body bytes) |
| Cold backfill, search/anchored windows, non-detail parsing | **Scanner** (made incremental by the upstream fix, see the scanner session prompt) |
| Any remaining slow path, retry storms, live sessions | **1a — guard rails** (wrap everything) |

## 6. Phase 1a — Guard rails (streamer, first PR)

### 6.1 Single-flight + TTL on `refreshFile`

One module-level `Map<filePath, { promise: Promise<...>, completedAt: number }>` wrapping both call sites (`src/server.ts:1613` detail-stale branch, `src/server.ts:421` turn-end):

- A refresh in flight for the path → callers await the same promise.
- A refresh completed within `REFRESH_TTL_MS = 2000` → skip entirely, serve the snapshot.
- Entries are dropped on settle + TTL expiry; the map never grows past the active-file set.

### 6.2 Live-session bypass

In `findConversationByUuid`: if `this.ptyManager.hasSession(id)`, serve the current snapshot with **no stale-check and no refresh**. Rationale: the stall only occurs on live conversations; a live client is on WS receiving `conversation_event` lines; mobile already refetches once on the `running → not-running` transition, which is the reconcile point. The (TTL-throttled) turn-end refresh keeps the snapshot advancing between requests.

### 6.3 Stale-while-revalidate

When a refresh is warranted and a snapshot exists: respond from the snapshot immediately, run the refresh in the background (tracked, so shutdown awaits it). Only a conversation with **no snapshot at all** awaits the parse — single-flighted, so a cold thundering herd costs one parse.

### 6.4 Tests (1a)

- Hammer detail ×20 concurrently on an actively-appended file → exactly **one** underlying `refreshFile` (spy).
- `hasSession(id)` true → **zero** `refreshFile` calls from the detail path.
- SWR ordering: response resolves before the background refresh completes; next request after refresh sees new data.
- TTL: two sequential requests inside 2 s → one refresh; after 2 s → two.

## 7. Phase 1b — Offset index in the streamer (second PR, after the scanner release)

### 7.1 Schema — migration `009` in `cache.db`

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

Sizing: ~700k messages across today's 3,308 files ≈ ~70 MB — acceptable beside the current 39 MB cache. If it ever matters, fall back to sparse (every-50) rows; not now.

### 7.2 Writers

- **Incremental:** `ConversationWatcher`'s per-line tail extends the index for each appended line, classifying lines with the scanner's new stateless `parseJsonlLine` export (scanner session prompt, item E) so line→message semantics cannot drift from the scanner's. Lines that don't produce a message (summary/sidecar records) get no index row.
- **Backfill:** on-demand, per conversation, when a detail request finds no/stale `file_state`: yielding walk (`setImmediate` per ~1000 lines), single-flighted, writes index rows + `file_state`. The request itself is served by the scanner path (1a-guarded) while backfill proceeds.

### 7.3 Read path

Detail/delta request where `file_state` matches `stat` (same identity, `size >= byte_offset`):

1. SQL window select for the requested slice (tail `msg_limit`, `before_index`, or `after_index`).
2. `pread` exactly those `(byte_offset, byte_length)` ranges from the JSONL.
3. Parse only those lines; respond.

Mismatch (identity changed or `size < byte_offset`) → truncation rule: delete the file's index rows + `file_state`, fall back to scanner, enqueue backfill. Index cold → scanner fallback (1a-guarded).

### 7.4 Phase-2 enablers (additive, shipped with 1b)

- **WS `seq`:** stamp `seq` (= `message_index`) on `conversation_event`/`conversation_events` entries that correspond to indexed messages; omit for non-message lines. Old clients ignore unknown fields.
- **Delta validity token:** include the current conversation `etag` in `after_index` responses (in `message_pagination`). A client whose stored `etag` mismatches must discard its cursor and refetch the tail.

### 7.5 Tests (1b)

- Append lines → watcher extends index; a subsequent `after_index` delta returns exactly the new messages, reading only their byte ranges (spy on read calls).
- Window correctness across the incremental boundary (page spanning backfilled + tailed regions).
- Truncate / replace file → index dropped, scanner fallback correct, backfill restores.
- Torn write: partial line at EOF is not indexed; completed on next event; `byte_offset` never passes an unparsed line.
- Migration 009 idempotency; upgrade from an existing `cache.db`.
- Perf smoke: synthetic 100 MB JSONL, warm index → detail p95 < 50 ms; event-loop delay < 50 ms during active append.

## 8. Scanner fix (parallel workstream, owner-run)

Upstream `@threadbase-sh/scanner` gets the same log-shipper design natively: per-file resume state, incremental `refreshFile` (read only `[byte_offset, size)`), append-only checkpoints (drop only on truncation/identity change), no `structuredClone` per 500 messages, cooperative yielding on full parses, single-flight per path, LRU updated in place, and the `parseJsonlLine` export that 1b consumes. Full prompt (acceptance criteria embedded): [prompts/2026-07-12-scanner-incremental-refresh-prompt.md](prompts/2026-07-12-scanner-incremental-refresh-prompt.md).

Streamer consumes it as a normal semver-minor bump; 1b's `package.json` requires the version carrying `parseJsonlLine`.

## 9. Phase 2 — Mobile delta sync (designed here, implemented in tb-mobile)

**Acceptance criterion (verbatim requirement):** on any conversation open — background→foreground resume, cold start, or resuming a stopped session — the app renders instantly from its on-device store, sends its last message cursor, and receives **only the delta**, never the full conversation it already has.

Changes:

1. **Durable store:** raise the `'conversation'` query root's persisted retention from `gcTime` 5 min to 7 days; persist the ETag map and last `message_index` per conversation (today both are in-memory).
2. **Open flow:** render local → `GET /api/conversations/:id?after_index=<lastIdx>&msg_limit=80` with `If-None-Match` → `304` (nothing new) | delta merge | `etag` mismatch → discard cursor, refetch tail.
3. **WS resume:** track last seen `seq`; on reconnect, delta-fetch from the cursor instead of `invalidateQueries` on the whole conversation. Remove the invalidate-on-every-`connected`-transition behavior.
4. **Retry hygiene:** conversation detail moves off `staleTime: 0`; add a min-interval throttle on same-key refetches so socket flaps can't stack GETs.
5. **Id unification:** REST messages carry index-based ids, WS carries uuid — merge keys become `(message_index, uuid)` so cursor and dedupe are well-defined across sources.

Old app versions: unaffected — they keep full-tail fetching against endpoints whose shapes are unchanged (G6).

## 10. Error handling

- **Torn/partial lines:** remainder carried between reads; offsets advance only past complete, successfully parsed lines.
- **fs errors mid-read:** serve the stale snapshot, log (`event: "index.read_failed"`), retry via normal staleness on the next request.
- **Index/DB corruption:** drop the file's index rows + `file_state`, scanner fallback, backfill.
- **Cursor invalidation (client):** `etag` mismatch on a delta response → client discards local history for that conversation and refetches the tail. Server never silently serves a wrong delta.
- **Shutdown:** background refreshes and backfills are tracked (`trackCacheWrite` pattern) so `close()` awaits them before closing `cache.db`.

## 11. Rollout order

1. **PR 1 — guard rails (1a):** ships alone; kills the stall class immediately.
2. **Scanner PR** (owner runs the scanner session prompt in tb-scanner) → release → version bump here.
3. **PR 2 — offset index (1b):** requires the scanner release (for `parseJsonlLine`); adds migration 009, index read path, WS `seq`, delta `etag`.
4. **tb-mobile PR(s) — phase 2:** persistent store + cursor flows; server already speaks the protocol.

Each step is independently shippable and independently revertible; no step breaks released clients.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Watcher line-classification drifts from scanner parse semantics | Both use the scanner's exported `parseJsonlLine` (single source of truth) |
| `message_index` table growth | ~70 MB worst case measured against today's corpus; sparse-row fallback documented |
| Scanner release train delays 1b | 1a already removes the user-facing stall; 1b is a latency/scale upgrade, not the hotfix |
| Live-bypass serves a stale snapshot after session end | Mobile's `running → not-running` invalidation refetches once; turn-end (throttled) refresh advances the snapshot server-side |
| Duplicate streaming entries (same `requestId`) across incremental boundary | Called out in the scanner prompt acceptance criteria; keep-last dedupe state must persist across batches |
