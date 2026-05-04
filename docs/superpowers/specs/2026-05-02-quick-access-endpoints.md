# Quick Access Endpoints — Backend Spec

**Date:** 2026-05-02
**Status:** Approved
**Companion spec:** tb-mobile `docs/superpowers/specs/2026-05-02-quick-access-strip-design.md`

---

## Context

The mobile Quick Access Strip needs server-provided recents and popular data so results are accurate across app restarts and reflect true history — not just what's currently loaded in the React Query cache. Two new read-only endpoints are needed.

---

## Endpoints

### `GET /api/sessions/recents`

Returns the N most recently active sessions from the in-memory session store, sorted by `lastActivityAt` descending.

**Auth:** Bearer token required (same as all private routes).

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | `20` | Max sessions to return |

**Response `200`:**
```json
{
  "sessions": [SessionResponse, ...],
  "total": 4
}
```

`SessionResponse` is the existing type from `src/types.ts` — no new fields needed.

**Implementation notes:**
- Call `this.sessionStore.list(this.ptyAttachedIds())` to get all live sessions (same as `/api/sessions`).
- Sort by `lastActivityAt ?? startedAt` descending.
- Slice to `limit`.
- `total` is the count after slicing (i.e. `Math.min(all.length, limit)`) — mobile uses this to know if there are more.

**Route registration** in `src/server.ts` router block:
```
GET /api/sessions/recents   →   handleGetRecentSessions()
```

Must be registered **before** the existing `/api/sessions/{id}` catch-all pattern so it isn't swallowed.

---

### `GET /api/projects/popular`

Returns the N most-used project directories, ranked by total conversation count in the SQLite conversation cache.

**Auth:** Bearer token required.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | `20` | Max projects to return |

**Response `200`:**
```json
{
  "projects": [
    { "path": "~/my-app", "name": "my-app", "sessionCount": 24 },
    { "path": "~/work/api", "name": "api", "sessionCount": 18 }
  ],
  "total": 2
}
```

**Implementation notes:**
- Query the SQLite conversation cache (`ConversationCache`) — this is already available on the server instance as `this.conversationCache`.
- Add a new method `getPopularProjects(limit: number)` to `ConversationCache` (`src/conversation-cache.ts`):

```ts
getPopularProjects(limit: number): Array<{ path: string; name: string; sessionCount: number }> {
  const rows = this.db
    .prepare(
      `SELECT project_path, project_name, COUNT(*) as cnt
       FROM conversation_meta
       WHERE project_path IS NOT NULL
       GROUP BY project_path
       ORDER BY cnt DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ project_path: string; project_name: string | null; cnt: number }>

  return rows.map((r) => ({
    path: r.project_path,
    name: r.project_name ?? r.project_path.split('/').pop() ?? r.project_path,
    sessionCount: r.cnt,
  }))
}
```

- `project_name` may be null for older cache entries — fall back to the last path segment.
- Response `total` = rows returned.

**Route registration:**
```
GET /api/projects/popular   →   handleGetPopularProjects()
```

---

## Mobile API Client Changes (`tb-mobile`)

Add two typed fetch methods to `services/api-client.ts` (or the hook layer):

```ts
// hooks/useQuickAccess.ts (new file)

export function useRecentSessions(serverId: string, limit = 20) {
  return useQuery({
    queryKey: ['quick-access-recents', serverId, limit],
    queryFn: () => createApiForServer(serverId).get<{ sessions: SessionResponse[]; total: number }>(
      `/api/sessions/recents?limit=${limit}`
    ),
    staleTime: 30_000,
  })
}

export function usePopularProjects(serverId: string, limit = 20) {
  return useQuery({
    queryKey: ['quick-access-popular', serverId, limit],
    queryFn: () => createApiForServer(serverId).get<{ projects: PopularProject[]; total: number }>(
      `/api/projects/popular?limit=${limit}`
    ),
    staleTime: 5 * 60_000, // popular changes slowly
  })
}
```

**New type** in `types/api.ts`:
```ts
export interface PopularProject {
  path: string
  name: string
  sessionCount: number
}
```

For multi-server setups, `QuickAccessStrip` calls these hooks once per `activeServerId` and merges results (recents: interleaved by `lastActivityAt`; popular: summed counts, re-ranked).

---

## What's Out of Scope

- Pagination beyond `limit` (mobile uses load-more with fixed page sizes client-side)
- Persisting recents to DB (in-memory is sufficient; sessions restart cleans up naturally)
- Authentication changes

---

## Verification

1. `GET /api/sessions/recents` returns sessions sorted newest-first, respects `limit` param.
2. `GET /api/sessions/recents` registered before `GET /api/sessions/{id}` — no 404.
3. `GET /api/projects/popular` returns dirs ranked by conversation count descending.
4. `project_name` null rows fall back to last path segment, not null/undefined.
5. Both endpoints return 401 when Bearer token is missing.
6. Multi-server mobile: strip shows merged recents from all connected servers.
