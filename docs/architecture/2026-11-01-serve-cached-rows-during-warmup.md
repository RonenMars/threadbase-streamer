# Serving cached rows during the startup warm-up

**Date:** 2026-11-01
**Status:** Implemented
**Scope:** tb-streamer (`src/server.ts`, the conversations and sessions handlers) — additive contract for tb-mobile

---

## Problem

Until the startup scan ends, every gated list endpoint answered `503 SERVER_WARMING_UP`.
On a 3105-file / 5.5 GB corpus that is ~35 s with a cold cache and ~5 s with a populated `cache.db`.
During that window a phone that reconnects (after a deploy, an auto-update or a crash) showed an empty app with an "indexing" banner, although `cache.db` already held every row from the previous run.

## Decision

When `cache.db` already held conversations at boot, the read endpoints answer from those rows while the startup scan runs.
Each such response is labelled so a client can tell it may be stale.
A first boot with an empty cache behaves exactly as before: 503 until the scan ends.

### How a response says "partial, still scanning"

Two redundant markers, both only present while serving during the warm-up:

- Header `X-Threadbase-Warming: startup`.
- Body field `warming: "startup"` on every object body (the paginated session page, `/count`, conversations, recents, project summaries).

Both exist because an end-to-end-encrypted relay can drop response headers, and `GET /api/sessions` without `limit` is a bare array with no room for a field (header only).
Absence of both means the data is final.
Clients that ignore unknown fields (all shipped tb-mobile builds do) simply see a 200 instead of a 503.

When the scan finishes the server broadcasts WS `cache_ready` as before; tb-mobile invalidates its sessions and conversations queries on it, which replaces the stale rows.

### Stale semantics

Rows are whatever the previous run left in `cache.db`: a conversation written since is missing, a deleted file may still be listed until `pruneGhostFiles` runs at the end of the scan.
Nothing is repaired mid-scan; `cache_ready` is the refetch signal.

## Endpoint decision table

| Endpoint | During the startup scan, cache had rows | Why |
|---|---|---|
| `GET /api/conversations` | **Serve**, labelled; `refresh=1`, `parent=` sub-agent refresh and the stale-watcher reconcile are ignored | pure cache read; the ignored options would start a second scan |
| `GET /api/conversations/count` | **Serve**, labelled; `refresh=1` and the background count refresh ignored | pure cache read |
| `GET /api/sessions/recents` | **Serve**, labelled | pure cache read |
| `GET /api/projects/summary` | **Serve**, labelled | pure cache read |
| `GET /api/sessions`, `/api/sessions/count` | **Serve** (header; body field on `/count` and the paginated page) once boot recovery has rehydrated the registry; 503 before | built from the session registry and the cache, not from the scan; before rehydration the list would be missing live sessions |
| `GET /api/sessions/:id` | **Serve** (header) when found, once boot recovery has settled; an unknown id stays **503** | a partial index cannot say 404 — the file may exist and not be scanned yet |
| `GET /api/conversations/:id` | **503** | reads through the scanner, which would start a second scan |
| any endpoint while a `cache_reset` or `conversation_refresh` warm-up is active | **503** | rows are absent or being rebuilt |
| any endpoint on a first boot (empty cache) | **503** | nothing to serve; also stops a first boot from serving rows its own scan inserted |
| `POST` / mutating / start / resume / fork | unchanged | not behind this gate |

"Cache had rows" is decided once, before the scan starts (`startupHadCachedRows`), so rows the scan inserts into an empty cache never count.
The condition is checked on every request, so a `cache_reset` that begins during the warm-up flips the endpoints back to 503 at once.

## tb-mobile today (read-only check of the sibling checkout)

- `services/server-warmup.ts:3-22` recognises the 503 body (`code: "SERVER_WARMING_UP"`).
- `services/api-client.ts:281-298` and `:413-445` — the warm-up fetch path: a 503 is retried; a **200** on these endpoints calls `recordReady` (`stores/serverFetchStatus.ts:126-131`) and clears the banner.
- `hooks/useConversations.ts:181-182`, `hooks/useProjectSummaries.ts:106-107`, `hooks/useSession.ts:227-228` — the three hooks that go through it.
- `app/_layout.tsx:275-285` and `services/ws-client.ts:70-71` — WS `cache_ready` invalidates the sessions and conversations queries.
- `components/servers/ServerIndexingBanner.tsx` — the banner; it does not read the new field, so it disappears at the first cached 200 rather than at `cache_ready`.

Nothing in tb-mobile rejects an unknown field or header.
Client work that would use the label (keep the banner up until `cache_ready` while showing the cached rows) is a separate change in tb-mobile.

## Measured

Fake `$HOME` with symlinked real roots (2981 Claude project dirs plus Codex and Cursor roots), its own `cache.db`, port 8799, build of this change, restart on a populated cache.
Seconds from process start to the first 200, three restarts:

| Endpoint | Before (503 until scan end) | After |
|---|---|---|
| `GET /api/conversations` | 5.8 – 6.2 s | 0.55 – 0.72 s |
| `GET /api/conversations/count` | 5.8 – 6.2 s | 0.55 – 0.73 s |
| `GET /api/sessions/count` | 5.8 – 6.2 s | 0.69 – 0.87 s |
| `GET /api/conversations/:id` (still gated) | 5.8 – 6.2 s | 5.84 – 6.17 s |

"Before" is read off the still-gated detail endpoint, which opens when the scan ends, on the same binary.
The first boot on an empty cache is unchanged: every endpoint answered 503 until 98 s (one run, machine under load), with no `warming` label.

## Not done, on purpose

- `GET /api/conversations/:id` stays gated: serving it means a second scan racing the first.
- Unknown session ids keep 503 rather than 404 during the warm-up.
- No tb-mobile change.
- The tail-population loop of the scan is untouched (tracked in #1106).
