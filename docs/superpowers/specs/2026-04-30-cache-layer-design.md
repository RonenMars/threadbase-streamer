# Cache Layer Design — tb-streamer

**Date:** 2026-04-30
**Status:** Approved, ready for implementation

---

## Problem

Two user-facing latency pain points:

1. **History screen cold load** — `GET /api/conversations` re-filters the entire ConversationScanner metadata map on every request. The scanner is a disk-backed JSONL reader; on first request after restart it warms up from scratch, which takes seconds for large history sets.

2. **Conversation detail open for long conversations** — `GET /api/conversations/{id}` reads and parses the entire JSONL file to reconstruct message history. A conversation with hundreds of messages can take a second or more to open.

Secondary: `GET /api/sessions` runs OS-level process discovery (`pgrep`/`lsof` on Unix, `tasklist`/`wmic` on Windows) on every request with no caching across calls.

---

## Architecture Overview

A new `ConversationCache` module sits between the scanner and the REST endpoints. It owns a SQLite database at `~/.threadbase/cache/cache.db` (path configurable via `cacheDir` in `server.yaml`). The existing `FileWatcher` gains a second subscriber that calls `cache.updateFromLine(filePath, line)` on every new JSONL line. On startup, after scanner warm-up, `cache.upsertFromScannerMeta()` populates any rows missing from the database.

```
FileWatcher ──► WsHub (existing, unchanged)
            └──► ConversationCache.updateFromLine()   ← NEW

GET /api/conversations      ──► ConversationCache.listConversations()
GET /api/conversations/{id} ──► ConversationCache.getTail() + scanner for older pages
GET /api/sessions           ──► ProcessDiscovery with 5s in-memory TTL cache
```

The scanner is NOT removed. It remains the source of truth and the fallback on cache miss. The cache is a read-through layer, not a replacement.

---

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS conversation_meta (
  id              TEXT PRIMARY KEY,   -- conversation UUID
  file_path       TEXT NOT NULL,
  project_path    TEXT,
  project_name    TEXT,
  title           TEXT,
  model           TEXT,
  account         TEXT,
  branch          TEXT,
  message_count   INTEGER DEFAULT 0,
  last_activity   INTEGER,            -- Unix ms timestamp
  first_message   TEXT,
  last_message    TEXT,
  preview         TEXT,
  updated_at      INTEGER NOT NULL    -- Unix ms, for freshness checks
);

CREATE INDEX IF NOT EXISTS idx_meta_last_activity ON conversation_meta(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_meta_project       ON conversation_meta(project_path);

CREATE TABLE IF NOT EXISTS conversation_tail (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation_meta(id) ON DELETE CASCADE,
  messages_json   TEXT NOT NULL,      -- JSON array, newest N messages
  tail_size       INTEGER NOT NULL,   -- how many messages are stored
  updated_at      INTEGER NOT NULL
);
```

**Design decisions:**
- `last_activity` is stored as Unix ms integer for fast `ORDER BY` without ISO string parsing.
- `conversation_tail.messages_json` is a JSON blob (not normalized rows) — mobile reads the whole tail at once; normalization adds join complexity with no query benefit.
- `tail_size` tells callers whether the tail is complete (conversation has fewer messages than N) or truncated.
- `ON DELETE CASCADE` prevents orphaned tail rows if a conversation file is removed.
- No `projects` table at this stage — `project_path` with an index on `conversation_meta` covers all current queries. Can normalize later if needed.

---

## `ConversationCache` Module

**File:** `src/conversation-cache.ts`
**Dependency:** `better-sqlite3` (synchronous — fits Node's single-threaded event loop, standard for embedded SQLite in Node)

### Public API

```ts
class ConversationCache {
  // Lifecycle
  static open(dbPath: string, tailSize?: number): ConversationCache
  close(): void

  // Hot path — called by FileWatcher subscriber on every new JSONL line
  updateFromLine(filePath: string, line: JsonlLine): void

  // Called once after scanner warm-up to populate missing rows
  upsertFromScannerMeta(meta: ConversationMeta[]): void

  // REST endpoint reads
  listConversations(opts: {
    project?: string
    sort?: string
    limit: number
    offset: number
  }): { conversations: ConversationListItem[]; total: number }

  getConversationTail(id: string): CachedTail | null

  hasConversation(id: string): boolean

  // Cache invalidation — called when ?refresh=1 is passed
  invalidate(id?: string): void  // no id = invalidate all
}
```

### `updateFromLine` logic (hot path)

1. Parse the JSONL line to extract: role, timestamp, text snippet, model, account.
2. `UPDATE conversation_meta SET message_count = message_count + 1, last_activity = ?, last_message = ?, updated_at = ? WHERE id = ?` — single prepared statement, runs in <1ms.
3. Read current `messages_json` from `conversation_tail`, prepend new message, trim to last N, write back — all in one SQLite transaction.
4. If row doesn't exist (new conversation file seen for first time), insert skeleton row. Full metadata will be filled on next `upsertFromScannerMeta` call or `?refresh=1`.

### Startup population

1. `open()` runs idempotent schema migrations (`CREATE TABLE IF NOT EXISTS`).
2. After scanner warm-up completes, `upsertFromScannerMeta()` is called once.
3. Existing rows with `updated_at` within 24h are NOT overwritten — avoids a full rewrite on every restart.
4. New rows (conversations seen since last run) are inserted in a single batch transaction.

---

## Server Integration

### Configuration additions

**`server.yaml`:**
```yaml
cache_dir: ~/.threadbase/cache   # optional, default shown
tail_size: 10                     # optional, messages cached per conversation
```

**`ServerConfig` type:**
```ts
cacheDir?: string   // default: ~/.threadbase/cache
tailSize?: number   // default: 10
```

### Startup sequence (`server.ts` `listen()`)

```
1. ConversationCache.open(resolve(cacheDir) + '/cache.db', tailSize)
2. Scanner warm-up (existing)
3. cache.upsertFromScannerMeta(scanner.getMetadataCache())
4. FileWatcher gets cache subscriber (alongside existing WsHub subscriber)
5. HTTP server binds port
```

### FileWatcher subscriber

One additional listener on the existing `line` event — no structural change to `file-watcher.ts`:

```ts
watcher.on('line', (filePath, line) => {
  cache.updateFromLine(filePath, line)   // ← add
  wsHub.broadcast(filePath, line)        // existing
})
```

### Endpoint changes

**`GET /api/conversations`**
- Read from `cache.listConversations(opts)` → return result.
- Falls back to scanner only if cache is empty (first boot before `upsertFromScannerMeta` completes, or cache file deleted).
- `?refresh=1` calls `cache.invalidate()` then re-runs scanner scan as today, then `upsertFromScannerMeta()`.
- Response now always includes `total` (was already present, now computed by SQLite `COUNT(*)`).

**`GET /api/conversations/count`**
- Becomes `cache.listConversations({ limit: 0 })` which returns `total` from a single `COUNT(*)` query.
- Kept as a dedicated endpoint — useful for project card badges and conversation header counts.

**`GET /api/conversations/{id}`**
```
tail = cache.getConversationTail(id)
if tail:
  return last N messages instantly (no disk read)
  // older pages: existing scanner path, unchanged
else:
  fall back to scanner (existing behavior)
```

**`GET /api/sessions`**
- Add in-memory `DiscoveryCache`: `{ entries, fetchedAt }`.
- If `Date.now() - fetchedAt < 5000`: return cached entries, skip `pgrep`/`lsof`.
- Else: run discovery, update cache, return.
- Cache is invalidated immediately on any session state mutation (start, resume, cancel).

---

## Mobile Changes

The Projects Hub redesign (`app/index.tsx`) fetches both sessions and conversations in parallel from the root screen — this is compatible with and benefits from the server-side cache improvements.

### Count endpoints — keep as-is

`/api/sessions/count` and `/api/conversations/count` are retained and called as today. They are:
- Trivially cheap (single `COUNT(*)` SQLite query against cache)
- Useful for future hub UI: project card conversation count badges, conversation detail message count headers.

### `total` in list responses (additive, backward-compatible)

`GET /api/conversations` and `GET /api/sessions` responses gain an optional `total` field:
```ts
// conversations response
{ conversations: ConversationListItem[], hasMore: boolean, offset: number, total: number }

// sessions response (new field only)
{ sessions: SessionResponse[], total: number }
```

`useEagerSessions` and `useEagerConversations` can optionally consume `total` from the first list page to skip the separate count round-trip on initial load — eliminating one serial round-trip of latency on app open. The count endpoints remain available for standalone use.

This is a safe additive change per the backward-compatibility rules in `CLAUDE.md`.

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `src/conversation-cache.ts` | `ConversationCache` class — SQLite read/write, schema migrations |
| `src/__tests__/conversation-cache.test.ts` | Unit tests: schema init, updateFromLine, upsertFromScannerMeta, listConversations, getTail, invalidate |

### Modified files
| File | Change |
|---|---|
| `src/server.ts` | Wire cache into startup, endpoint handlers, ?refresh=1 |
| `src/file-watcher.ts` | Add cache subscriber alongside WsHub subscriber |
| `src/types.ts` | Add `cacheDir`, `tailSize` to `ServerConfig`; add `total` to session list response type |
| `cli/index.ts` | Parse `cache_dir` and `tail_size` from `server.yaml`, pass to `ServerConfig` |
| `package.json` | Add `better-sqlite3` dependency |

### No changes
| File | Reason |
|---|---|
| `src/pty-manager.ts` | No caching needed; ring buffer already handles output |
| `src/session-store.ts` | In-memory session map unchanged |
| `src/ws-hub.ts` | Unchanged; FileWatcher subscriber order doesn't matter |
| `src/auth.ts` | Unchanged |

---

## Testing

- `conversation-cache.test.ts`: schema init is idempotent, `updateFromLine` increments `message_count` and updates tail, `upsertFromScannerMeta` skips fresh rows and inserts stale ones, `listConversations` applies project filter and sort, `getTail` returns null on miss, `invalidate()` clears all rows.
- Existing integration tests in `__tests__/server.test.ts` remain valid — cache falls back to scanner on miss so behavior is unchanged for uncached conversations.
- Process discovery TTL: add a test asserting that a second `GET /api/sessions` within 5s does not call `pgrep`/`lsof` again.

---

## Non-Goals

- No virtual list in mobile (can revisit if FlatList performance degrades with large hub lists).
- No projects table in SQLite (can normalize later).
- No cache warming via HTTP prefetch (startup scan covers this).
- No distributed / multi-process cache (streamer is single-process by design).
