# Session prompt — tb-mobile: persistent cache + cursor-based delta sync

> **Run in:** the `tb-mobile` repo
> **Depends on:** nothing to START — items 1, 2, 4, 5 work against today's server.
> Item 3 (WS resume-by-`seq`) requires streamer PR 2 deployed — implement it last.

---

Implement cursor-based delta sync over a persistent local cache.
Required product flow (the acceptance bar for this whole task):

> On ANY conversation open — background→foreground resume, cold app start, or opening a conversation whose session ended — the app renders instantly from its on-device store, sends its last message cursor to the server, and receives ONLY the delta.
> It never re-downloads history the device already has.

## Why (current behavior, audited 2026-07-12 — verify anchors, they may have drifted)

- History is re-fetched on essentially every open: the `'conversation'` query root IS persisted to AsyncStorage (`services/query-client.ts` persist allow-list), but `gcTime` is 5 minutes (`QUERY_GC_TIME`, `services/query-client.ts:9`) so entries evict on rehydrate, and `staleTime: 0` (`:41`) marks everything stale on every trigger.
- The tail-page ETag map (`firstPageEtags`, `hooks/useConversations.ts:334`) is module-level in-memory — lost on restart, so the first open after relaunch can't even get a 304.
- `after_index` (forward cursor) is only used inside anchored-search windows (`useConversations.ts:359-364`); normal views never ask "what's new since index N".
- WS has no resume: `hooks/useConversationStream.ts` invalidates the WHOLE conversation on subscribe (`:72`), on every `connected` transition (`:88-91`), and on `running→not-running` (`:97-104`) — a flapping socket stacks full refetches.
- Retry amplification: 8 s first-attempt abort + 15 s retry (`services/api-client.ts:34-37`) with one silent transport retry (`:84-86`), `staleTime: 0`, and 3 same-key consumers (detail screen, `LiveConversationView`, `ConversationPreviewSheet`) produced ~30 concurrent GETs against a stalled server.
  There is no refetch throttle anywhere.

## Server API contract (embedded)

- `GET /api/conversations/:id?msg_limit=N` — tail page.
  Supports `If-None-Match` → `304` (empty body); `200` carries an `ETag` header.
  Response: `{ meta, messages[], message_pagination: { total, before_index, from_index, has_more_older, next_before_index } }`.
  Messages carry `message_index`.
- `GET /api/conversations/:id?after_index=N&msg_limit=M` — forward delta window from index N.
  Pagination includes `next_after_index`.
  After streamer PR 2 it also includes `etag` (cursor-validity token).
- `GET /api/conversations/:id?before_index=N&msg_limit=M` — backward backfill (existing).
- WS `conversation_event` `{ type, sessionId, line }` and `conversation_events` `{ type, sessionId, lines[] }` — raw appended JSONL lines.
  After streamer PR 2, message-bearing entries also carry `seq` (= `message_index`).
- Id semantics: REST messages are index-keyed, WS-parsed messages are uuid-keyed.

## Required changes

1. **Durable store.**
   Raise the `'conversation'` root's persisted retention from 5 min to 7 days (per-root override; don't globally change `gcTime`).
   Persist the ETag map and a per-conversation `lastMessageIndex` cursor so both survive relaunch.
2. **Delta-on-open.**
   When a stored conversation opens with a cursor: render local immediately, then `GET ?after_index=<lastIdx>&msg_limit=80` with `If-None-Match`.
   `304` → done; `200` → merge delta, advance cursor.
   No cursor → plain tail fetch.
   **Cursor validity:** if the response's `message_pagination.total < lastMessageIndex`, or a delta `etag` is present and mismatches the stored one → discard local history + cursor, refetch the tail.
3. **WS resume (LAST — needs streamer PR 2 deployed).**
   Track the max seen `seq`.
   On reconnect/resubscribe: delta-fetch from the cursor instead of `invalidateQueries` on the whole conversation, and drop the invalidate-on-every-`connected`-transition behavior.
4. **Retry hygiene.**
   Conversation detail moves off `staleTime: 0` (e.g. 15 s) and gains a min-interval throttle (e.g. ≥5 s between same-key network refetches) so socket flaps and focus events can't stack GETs.
   Keep the 8 s/15 s AbortController timeouts.
5. **Id unification.**
   Merge/dedupe across REST and WS on `(message_index, uuid)` — uuid as identity, `message_index`/`seq` as order + cursor — replacing the current uuid-only filtering in `LiveConversationView`.

## Acceptance criteria / tests (write first; mock the server)

1. Kill + relaunch → previously-viewed conversation renders from disk with ZERO network before the delta request; the delta GET carries `after_index=<stored cursor>`.
2. Background→foreground with a cursor → exactly one conditional delta request (`If-None-Match` set); a `304` produces no re-render churn and no further requests.
3. New messages while away → delta merge appends exactly the missing messages (no duplicates by uuid, order by index) and advances the persisted cursor.
4. `total < lastMessageIndex` (rewritten file) → local history + cursor discarded, tail refetched — never a silently wrong merge.
5. WS flap ×5 in 10 s → ≤1 delta fetch, zero full-tail refetches.
6. Same-key consumers mounted together (detail + preview sheet) → one in-flight request.

## Constraints

- Repo conventions: feature branch + PR, conventional commits, run the repo's lint + test suite before committing (run Jest suites `--runInBand` — parallel runs corrupt on this machine).
- No new heavyweight deps (no WatermelonDB/Realm) — extend the existing react-query + AsyncStorage persistence.

Full server-side design (context, not required reading): `tb-streamer/docs/superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md`.
