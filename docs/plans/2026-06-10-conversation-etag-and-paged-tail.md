# Prompt: ETag/304 conditional fetch + bounded paged reads for conversation detail

**Repo:** `tb-streamer` (this repo) · **Endpoint:** `GET /api/conversations/{id}` in `src/server.ts`
**Companion prompts:** `tb-scanner/docs/plans/2026-06-10-paged-conversation-parse.md`, `tb-mobile/docs/2026-06-10-conversation-etag-and-paged-cache.md`

> Paste this whole file to Claude Code in the `tb-streamer` repo. Read it fully before editing. Follow the repo's `CLAUDE.md` (conventional commits, branch off `main`, never push to `main`, every feature gets tests in `__tests__/`, run `npm run lint && npm test` before committing).

## Why we're doing this

The mobile app re-opens the same conversation constantly. Today every open re-downloads the message page even when nothing changed. We want a conditional-fetch path: the client sends a validator it got last time, and if the conversation is unchanged the server returns `304 Not Modified` with an empty body. Separately, for very large conversations (10k+ messages) the current code parses the **entire** JSONL to serve any single page; we want page reads to stay bounded.

**Critical context — most of the pagination already exists. Do NOT rebuild it.**

`GET /api/conversations/{id}` already supports `?msg_limit=<n>&before_index=<cursor>` and returns:

```jsonc
"message_pagination": { "total", "before_index", "from_index", "has_more_older", "next_before_index" }
```

The mobile app already drives infinite-scroll-back off this (sends `msg_limit`, walks `next_before_index`). This prompt ADDS two things to that existing endpoint; it does not change the pagination contract.

## Backward compatibility is mandatory

`tb-mobile` is a released app on versions you cannot force-update (see `CLAUDE.md` → "Backward Compatibility with tb-mobile"). Therefore:

- A request **without** `If-None-Match` must behave **exactly** as today (full `200` with body). No behavior change for old clients.
- `304` is only ever returned when the client opted in by sending `If-None-Match`. Old clients never send it, so never receive it.
- Do not rename or remove any existing field in the response. ETag is additive (a new response header + an opt-in request header).

## Part A — ETag / `If-None-Match` (the freshness check)

### A1. Compute an opaque validator

Add a helper that derives a stable, cheap ETag for a conversation from data we already have after `findConversationByUuid` resolves (it now self-refreshes on staleness — see the `refreshFile` work already merged):

```
etag = `"` + sha1(`${conv.filePath}:${conv.messageCount}:${conv.timestamp}`).slice(0,16) + `"`
```

- Use `conv.messageCount` + `conv.timestamp` (last-activity) + `filePath`. These uniquely identify the conversation's state for our purposes and are already on the parsed `Conversation`.
- Keep it **opaque** — the client never parses it, only echoes it back. Do not use a bare timestamp or count as the validator value; wrap it in a hash so we can change the formula later without the client caring.
- Put the helper in `src/utils/` (e.g. `conversationEtag.ts`) as a **pure function** `computeConversationEtag({ filePath, messageCount, timestamp })` and unit-test it (stable for same input, differs when count or timestamp changes).

> The ETag must reflect the **same state the body would**. Compute it from the resolved `conversation`, AFTER `findConversationByUuid` has done its staleness refresh — never from the pre-refresh snapshot. Otherwise you can hand out a 304 against stale data, which is the exact bug class we just fixed.

### A2. Wire the conditional response in `handleGetConversation`

After `conversation` is resolved and non-null:

1. Compute `etag`.
2. Read the request's `If-None-Match` header (it's on `IncomingMessage.headers['if-none-match']`).
3. **Only when the client sent `If-None-Match` AND it equals the computed `etag` AND this is a first-page request** (`!url.searchParams.has("before_index")`):
   - Respond `304` with headers `ETag: <etag>`, empty body. Do not send `messages`/`meta`.
4. Otherwise: serve the normal `200`, and **always set the `ETag` response header** on the 200 too (so the client can store it).

Gate the 304 to **first-page only** (`before_index` absent). Older pages are immutable history — paginating backward should not 304; only the "is the conversation as a whole still current" check belongs on the first page. Sending `If-None-Match` on a back-page request must still return that page's `200` body.

Add `ETag` to the CORS `Access-Control-Expose-Headers` (check `src/api/middleware/cors.middleware.ts`) so the mobile fetch can read it cross-origin, and ensure `If-None-Match` is allowed in `Access-Control-Allow-Headers`.

Mind the direct-`ServerResponse` write pattern: handlers write via `c.env.outgoing` and the routes return the `ALREADY_HANDLED` (597) sentinel. The `json(res, …)` helper sets status + body; you'll need to set the `ETag`/return-304 path the same way the existing handler writes (look at how `json()` and the raw `res.writeHead`/`res.end` are used in `server.ts`). For a 304, write status 304 with the `ETag` header and `res.end()` (no body).

### A3. Tests (extend `__tests__/server.test.ts`)

Reuse the existing temp-profile harness in the `GET /api/conversations/:id stale-snapshot re-scan` describe block (it spins up a server against a temp profile dir with a real JSONL). Add a describe block:

- **First fetch returns an ETag header**, body intact.
- **Second fetch with that `If-None-Match` returns 304**, empty body.
- **After appending a message (and bumping mtime), the same `If-None-Match` returns 200** with a new ETag and the new message. (This proves the validator tracks growth and composes with the staleness refresh.)
- **A back-page request (`before_index` set) with a matching `If-None-Match` still returns 200** with that page (never 304).
- **A request with no `If-None-Match` returns 200** (old-client path unchanged).

## Part B — Bounded page reads for large conversations (efficiency)

> Do Part A first; it's the user-visible win and is self-contained. Part B is an optimization that depends on a scanner change — only start it once the companion `tb-scanner` prompt has landed and `vendor/scanner` is bumped. If the scanner change isn't available yet, STOP after Part A and note that Part B is blocked on the scanner bump.

### The problem

`handleGetConversation` does `conversation.messages` then `.slice(start, beforeIndex)`. `findConversationByUuid → scanner.getConversation()` parses the **whole** JSONL into memory and caches the full `Conversation` in the scanner LRU (size 5). For a 10k-message conversation:
- First page parses all 10k messages and holds them in RAM.
- `refreshFile()` evicts the LRU, so the next request re-parses all 10k.

### The fix (after scanner support exists)

The companion scanner prompt adds a bounded read: `scanner.getConversationPage(id, { beforeIndex, limit })` returning `{ messages, total, fromIndex }` by reading only the needed window (the scanner already has a backward-chunk reader pattern in `tb-streamer`'s `ConversationCache.populateTailFromFile` — the scanner version reads the file once to get `total`, then the requested slice).

In `handleGetConversation`, when paging:
- Prefer `scanner.getConversationPage(id, { beforeIndex, limit })` over parsing the full conversation, when available.
- Build `message_pagination` from the returned `total`/`fromIndex` exactly as today (no contract change).
- Keep the full-parse path as a fallback when the scanner method is unavailable (so a partial rollout can't break).

### Tests

- A large fixture (e.g. 300 messages) returns the same `message_pagination` numbers and the same final-page bytes as the full-parse path. (Assert equivalence so the optimization is provably behavior-preserving.)
- Memory/parse-bound assertion is optional; equivalence is the must-have.

## Out of scope

- Changing the `message_pagination` field names or cursor semantics (mobile depends on them verbatim).
- Persisting message bodies anywhere new.
- Touching the SQLite `conversation_tail` cache contract (the `tailSize`-based list enrichment is separate from this endpoint's paging).

## Done when

- `npm run lint && npm test` green.
- Old clients (no `If-None-Match`) see identical responses.
- New clients get `ETag` on 200 and `304` on unchanged first-page re-fetch.
- (Part B, if unblocked) paging a large conversation no longer requires a full re-parse per page, with an equivalence test proving identical output.
