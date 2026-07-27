# Sessions List: Ownership + Path Filters

**Date:** 2026-07-27  
**Status:** Proposed  
**Scope:** tb-streamer — `GET /api/sessions` (and related list/count surfaces)  
**Consumers:** tb-mobile, menubar, any `history:read` client  
**Related:** [sessions-ws-push](2026-05-02-sessions-ws-push.md), [quick-access-endpoints](2026-05-02-quick-access-endpoints.md), `SessionOwnership` / `SessionListQuery` in `src/types.ts`

---

## Problem

Clients need a way to ask: **“show me only sessions this streamer created, optionally scoped to one project path.”**

Today that answer exists in the data model but not on the wire as a filter:

| Signal | Where it lives | Exposed on list? |
|--------|----------------|------------------|
| Live streamer-owned process | `SessionResponse.ownership === "managed"` | Field yes; **filter no** |
| OS-discovered Claude/Codex process | `ownership === "external"` | Field yes; **filter no** |
| Cached conversation (no live process) | `ownership === "historical"` (recents / detail fallback) | Field yes; **filter no** |
| Durable “spawned via streamer” mark | `conversation_meta.source = 'streamer'` | Stored in cache; **dropped** by `GET /api/conversations` adapter |
| Project cwd | `SessionResponse.projectPath` | Field yes; **filter no** on `/api/sessions` |

Existing path filters live elsewhere with inconsistent param names:

- `GET /api/conversations?project=` — exact match on cache `project_path`
- `GET /api/search?projectPath=` — exact equality after scan
- `GET /api/sessions` — **no path or ownership query params**

So a client that wants “managed sessions under `/Users/me/dev/app`” must download the full list (or paginated pages of everything) and filter locally. That is wasteful, races with discovery churn, and cannot be shared with count badges or WS-driven UIs cleanly.

---

## Goal

Add **server-side filters** so a client can request:

1. Only sessions created / owned by this streamer instance (`ownership=managed`).
2. Optionally only those whose project cwd matches a given path.
3. Without breaking the legacy bare `GET /api/sessions` plain-array response.

Non-goals for v1 are listed below.

---

## Definitions

### “Created by the streamer”

Two orthogonal signals already exist. This spec treats them carefully:

| Layer | Field | Meaning | When set |
|-------|-------|---------|----------|
| **Live list** | `ownership: "managed"` | This streamer spawned and holds (or held in this process) the PTY | Immediately on `POST /api/sessions/start` / resume into the in-memory `SessionStore` |
| **History / cache** | `source: "streamer"` | Conversation row was marked after JSONL/Codex rollout was wired | After `linkSessionToProject` + `cache.markAsStreamer(id)` — **not** at spawn instant |

**v1 primary filter for “created by streamer” on `/api/sessions` is `ownership=managed`.**

Rationale:

- It is already on every live managed `SessionResponse` (`managedToResponse` in `session-store.ts`).
- It does not depend on JSONL bind timing.
- `/api/sessions` is the live-process list; mixing durable `source` into it without a clear envelope would blur live vs historical.

Historical “ever started by streamer” is a **separate, follow-up** surface on conversations (Phase B).

### Path

| Concept | API / field name | Semantics |
|---------|------------------|-----------|
| Project working directory | `projectPath` | Absolute cwd of the agent process / conversation |
| Browse-relative start path | `POST /api/sessions/start` body `path` | Relative to `browseRoot`; resolved server-side to absolute before spawn |
| Conversation JSONL file | `filePath` | Path to the transcript file — **not** the path filter in this spec |

**v1 path filter matches `projectPath` only**, after `canonicalizeProjectPath` (trim + strip trailing `/` or `\`; **no** lowercasing — see `src/utils/canonicalizeProjectPath.ts`).

Param name on the sessions list: **`projectPath`** (align with search and `SessionResponse`, not conversations’ `project`).

---

## Proposal (v1)

### Extend `GET /api/sessions`

Add two optional query parameters to the existing paginated list path.

```http
GET /api/sessions?ownership=managed&projectPath=/Users/me/dev/my-app&limit=50
```

#### Query parameters

| Param | Type | Required | Semantics |
|-------|------|----------|-----------|
| `ownership` | comma-separated enum | no | Keep sessions whose `ownership` is in the set. Allowed values: `managed`, `external`, `historical`. Invalid entry → `400`. |
| `projectPath` | string | no | Exact match against `canonicalizeProjectPath(session.projectPath) === canonicalizeProjectPath(query)`. Empty / whitespace-only → `400`. |
| existing | `limit`, `cursor`, `sortBy`, `order`, `status` | unchanged | Same validation as today |

**Combinators:** all provided filters are **AND**ed (same as `status` today). Within `ownership` and within `status`, the comma list is **OR**.

Examples:

```http
# Only streamer-owned live sessions
GET /api/sessions?ownership=managed&limit=50

# Streamer-owned + running, one project
GET /api/sessions?ownership=managed&status=running&projectPath=/abs/path&limit=50

# External (discovered) only
GET /api/sessions?ownership=external&limit=50

# Managed or external (exclude historical if any appear on this endpoint)
GET /api/sessions?ownership=managed,external&limit=50
```

#### Response envelope trigger (backward compatibility)

Today, a bare `GET /api/sessions` returns a **plain array**. Any of `limit|cursor|sortBy|order|status` switches to the paginated envelope `{ sessions, nextCursor, total }`.

**v1 rule:** presence of `ownership` or `projectPath` also switches to the paginated envelope (even without `limit`). Defaults for missing pagination fields remain: `limit=200`, `sortBy=startedAt`, `order=desc`.

Rationale: filtered results without a total/cursor are awkward for clients, and forcing the envelope matches the existing “any list-query param → new shape” contract.

Bare `GET /api/sessions` (no query params) remains an unfiltered plain array — **no behavior change**.

#### Auth

Unchanged. `GET /api/sessions*` already requires `history:read` (`capabilities.ts`). Filters do not introduce per-session ACL.

#### Error responses

| Condition | Status | Body |
|-----------|--------|------|
| Unknown `ownership` token | 400 | `{ "error": "ownership entry \"…\" is invalid" }` |
| Empty `projectPath` after trim | 400 | `{ "error": "projectPath must be a non-empty path" }` |
| Existing `limit` / `sortBy` / `order` / `status` / cursor errors | 400 | unchanged |

---

## Implementation plan (v1)

Touch points — keep the change surgical:

1. **`src/types.ts` — `SessionListQuery`**
   ```ts
   export interface SessionListQuery {
     limit: number;
     cursor?: string;
     sortBy: SessionSortKey;
     order: SortOrder;
     status?: SessionStatus[];
     ownership?: SessionOwnership[];
     projectPath?: string; // already canonicalized by the parser
   }
   ```

2. **`parseSessionListQuery` in `src/server.ts`**
   - Parse `ownership` like `status` (split on comma, validate against `SessionOwnership`).
   - Parse `projectPath`; canonicalize before returning.
   - Include both in the returned `query` object.

3. **`handleListSessions` pagination gate**
   - Extend `hasPaginationParams` to include `ownership` and `projectPath`.

4. **`SessionStore.paginate` in `src/session-store.ts`**
   - After the existing `status` filter, apply:
     - `ownership` include-set (skip sessions with missing `ownership` when filter is set — treat missing as non-match).
     - `projectPath` exact equality on already-canonicalized query value vs `canonicalizeProjectPath(s.projectPath)`.

5. **Tests** (`__tests__/server.test.ts` and/or session-store unit tests)
   - Managed-only filter excludes external fixtures.
   - Path filter exact match; trailing-slash variants canonicalize to the same hit.
   - AND with `status`.
   - Invalid ownership → 400.
   - `?ownership=managed` alone returns envelope (not plain array).
   - Bare GET still returns plain array.

6. **Docs**
   - Update `docs/api-reference.md` row / params for `GET /api/sessions`.
   - No mobile release note required until a client adopts the params (additive).

### Explicit non-changes (v1)

- Do **not** add a new route (`/api/sessions/mine`, etc.).
- Do **not** change WS `session_list` payload shape (clients that need filtered live views either refetch REST or filter locally on push — see Open questions).
- Do **not** resolve browse-relative paths on GET (clients that only have browse-relative paths should resolve via browse UX or pass absolute `projectPath` from a prior session/start response).
- Do **not** substring / prefix / glob match on path in v1 (exact only).
- Do **not** filter `filePath`.

---

## Phase B (follow-up): historical streamer sessions

Live `ownership=managed` does not answer “show history of chats I started through the streamer.”

That answer is `conversation_meta.source = 'streamer'`, set by `ConversationCache.markAsStreamer`.

### Gaps today

1. `listConversations` returns `source` on `ConversationListItem`.
2. `handleListConversations` **drops** `source` when adapting the HTTP response.
3. No `?source=` query param on conversations or recents.

### Proposed Phase B (separate PR)

```http
GET /api/conversations?source=streamer&project=/abs/path
GET /api/sessions/recents?source=streamer&projectPath=/abs/path
```

| Change | Detail |
|--------|--------|
| Expose `source` | Add `source: string \| null` to the conversations list adapter |
| Filter `source` | Cache SQL `WHERE source = ?` (and count sibling) |
| Param naming | Prefer `project` on conversations (existing); `projectPath` on sessions/recents |
| Recents | Optional; only if mobile uses recents for “my streamer chats” |

**Caveat to document for clients:** between `POST /api/sessions/start` and JSONL/rollout bind, a brand-new session is `ownership: "managed"` on the live list but may still have `source IS NULL` in the cache. Prefer live `ownership` for “running now”; prefer `source` for “started via streamer in the past.”

---

## Phase C (optional): count endpoint parity

`GET /api/sessions/count` currently returns `{ total: list().length }` with **no filters**.

If badges need “managed sessions for this project,” either:

- **C1:** Add the same query params to `/api/sessions/count`, or
- **C2:** Rely on paginated `GET /api/sessions?...&limit=1` and read `total` from the envelope.

**Recommendation:** C2 for v1 (zero extra surface); C1 if a client needs a cheap count without hydrating session bodies.

---

## Alternatives considered

| Option | Why rejected / deferred |
|--------|-------------------------|
| New `GET /api/sessions/managed` | Duplicates pagination/sort/status; ownership is already a first-class field — filters compose better |
| Filter only in tb-mobile / dashboard | Works for tiny lists; wastes bandwidth; diverges every client; count/badge wrong |
| Use `source=streamer` as the live filter | Not set until JSONL bind; wrong for “just started” |
| Substring path match (conversations scanner fallback) | Ambiguous; prefer exact + canonicalize for sessions |
| Alias `project` on sessions | Two names for one concept on one endpoint; keep `projectPath` |
| Put this API on tb-dashboard | Dashboard is CI deploy UI; session domain lives in streamer |

---

## Client usage sketches

### Mobile: “Active streamer sessions for this project”

```ts
const path = encodeURIComponent(absoluteProjectPath);
const res = await api.get(
  `/api/sessions?ownership=managed&projectPath=${path}&limit=50&sortBy=lastActivityAt&order=desc`,
);
// res.sessions, res.total, res.nextCursor
```

### Menubar: badge of managed running sessions

```ts
const res = await api.get(
  `/api/sessions?ownership=managed&status=running&limit=1`,
);
// use res.total
```

### Legacy clients

Omit the new params. Behavior unchanged (plain array or existing pagination).

---

## Testing matrix

| Case | Expect |
|------|--------|
| No query | Plain array; includes managed + external |
| `?limit=10` | Envelope; unfiltered |
| `?ownership=managed` | Envelope; only managed |
| `?ownership=managed,external` | Both; no historical unless present |
| `?ownership=bogus` | 400 |
| `?projectPath=/a/b` vs session `/a/b/` | Match (canonicalize) |
| `?projectPath=/a/b` vs session `/a/B` | No match on case-sensitive FS semantics (no lowercasing) |
| `?ownership=managed&status=idle&projectPath=…` | AND of all three |
| `?projectPath=` (empty) | 400 |
| Cursor page with filters | Cursor applies **after** filter+sort; `total` is filtered total |

---

## Rollout

1. Land streamer PR (additive query params + tests + api-reference).
2. No forced mobile bump — old clients ignore the params.
3. Adopt in mobile/menubar when a screen needs the filter.
4. Phase B/C as separate PRs when history/count requirements land.

---

## Open questions

1. **WS push:** Should `session_list` / `session_update` eventually carry a filter echo, or remain “full set, client filters”? v1 assumes REST refetch or local filter on push.
2. **Missing `ownership` on some responses:** Treat as non-match when filter is set (proposed). Alternatively default missing → `external` — but that would be a lie for historical fallbacks.
3. **Browse-relative `projectPath` on GET:** Resolve against `browseRoot` if the value is not absolute? Convenient for some UIs; surprising for others. v1 says absolute only; revisit if a consumer needs it.
4. **Include `historical` on `/api/sessions` list?** Today the main list is managed + discovered live; historical appears on recents/detail fallback. Keeping `historical` in the ownership enum is fine for forward-compat even if the live list rarely emits it.

---

## Decision summary

| Decision | Choice |
|----------|--------|
| New endpoint? | **No** — extend `GET /api/sessions` |
| “Created by streamer” (live) | `ownership=managed` |
| Path filter | `projectPath` exact + `canonicalizeProjectPath` |
| Envelope | New params force paginated envelope |
| Auth | Unchanged (`history:read`) |
| Historical streamer chats | Phase B on `/api/conversations?source=streamer` |
| Count API | Prefer envelope `total` in v1 |
