# Offset index (PR 2 / phase 1b) — implementation plan

**Date:** 2026-07-13
**Branch:** `feat/offset-index` (stacked on `fix/reparse-stall-guard-rails` / PR #199)
**Design:** [../superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md](../superpowers/specs/2026-07-12-live-conversation-reparse-stall-design.md) §7
**Precondition (MET):** `@threadbase-sh/scanner@0.10.1` on this branch exports `parseJsonlLine`, `createJsonlParseState` (= `initialConvState`), `ConvReducerState` (= `JsonlParseState`).

Goal: conversation detail/delta reads do a windowed SQL lookup in `cache.db` + `pread` of exact byte ranges from the JSONL, parsing only the sliced lines — instead of re-parsing the whole file. GB-proof; all additive (§G6).

---

## 0. Integration points found (verified 2026-07-13)

| Concern | Location | Note |
|---|---|---|
| Migration runner | `src/db/sqlite-migrate.ts` | `NNN_name.sql`, sort order, tracked by filename in `schema_migrations`, each in a tx. **Idempotency is automatic** (tracked by id) → §7.5 test 5 mostly free. |
| Migrations dir | `src/db/migrations/001..008` | Next is **`009`**. Template: `007_add_scanner_warmup_cache.sql`. |
| Cache class | `src/conversation-cache.ts` | `private db`; `runSqliteMigrations(db, …)` in the open path (line ~244); prepared stmts on `this.stmts`. |
| **Per-line writer** | `ConversationCache.updateFromLine` / `updateFromLines` (lines 485 / 572) | The incremental index-extend hook. **Called only from `server.ts:311`** `onNewLines`. |
| **Byte offsets already exist** | `ConversationWatcher.readNewLines` (`services/conversations/conversationWatcher.ts:150`) | Tracks per-file `offset`; reads exactly `[offset, size)` via `fh.read(buf, 0, bytesToRead, readFrom)`; advances `offset`. **This is the byte-offset source** — it just doesn't forward offsets today. |
| **Torn-line gap (latent)** | watcher line 188 | `buf.toString().split("\n").filter(Boolean)` keeps a trailing partial line AND advances `offset` past it → on the next read the remainder arrives headless. Tolerated today (cache only takes a text preview); **must be fixed for the index** (§7.5 test 4). |
| Detail read path | `server.ts` `findConversationByUuid` (1650) + `handleGetConversation` (1720) | Windowed-read decision goes **before** the scanner/paged-scanner block at ~1873. |
| Paging params | `server.ts` 1836–1901 | `msg_limit`/`before_index`/`after_index`/`anchor_index` already parsed; `message_pagination` object built at 1889. Add `etag` here. |
| ETag | `computeConversationEtag` (`utils/conversationEtag.ts`), used at `server.ts:1795` | Reuse for the delta-validity token. |
| WS events | `conversation_event` / `conversation_events` (grep `ws-hub` / watcher wiring in `server.ts`) | Add optional `seq` field. |
| Scanner parse API | `parseJsonlLine(line, state?)`, `createJsonlParseState()` | Stateful reducer; returns `ConversationMessage \| null`. Non-message lines → `null` → **no index row**. |

`ConversationMessage` fields we index: `uuid?`, `role`, `timestamp` (→ `ts` as epoch ms).

---

## 1. Schema — migration `009_create_offset_index.sql`

Exactly the design §7.1 DDL, `IF NOT EXISTS` for re-run safety, plus a covering index for the window select:

```sql
CREATE TABLE IF NOT EXISTS conversation_file_state (
  path               TEXT PRIMARY KEY,
  identity           TEXT NOT NULL,      -- inode (dev+ino), else fingerprint of first N bytes
  size               INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  byte_offset        INTEGER NOT NULL,   -- end of last fully-indexed line
  last_message_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_message_index (
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

(PK on `(conversation_id, message_index)` already covers the window select `WHERE conversation_id=? AND message_index BETWEEN ? AND ?` — no extra index needed.)

**Test (§7.5 #5):** `__tests__/offset-index-migration.test.ts` — run migrations twice on a fresh db → idempotent; run against a db pre-populated with 001–008 → 009 applies cleanly, tables exist.

---

## 2. Identity + torn-line: shared helper `src/utils/fileIdentity.ts`

- `fileIdentity(stat): string` → `${stat.dev}:${stat.ino}` (inode). Fallback (ino 0 / unavailable) → sha1 of first 4 KB. Truncation/replacement rule keys off this + `size < byte_offset`.
- **Torn-line split** (used by both watcher and backfill): given a buffer starting at absolute `baseOffset`, return `{ spans: Array<{start, length, text}>, consumed }` where each span ends at a `\n`, and `consumed` = bytes up to and including the **last** newline (never past a partial line). The watcher advances `offset` by `consumed`, not `bytesToRead`.

**Test (§7.5 #4):** feed `"a\nb\npar"` → spans for `a`,`b`; `consumed` stops before `par`; next feed `"tial\n"` → span for `partial` at the correct absolute offset; `byte_offset` monotonic, never past an unparsed line.

---

## 3. Cache: index read/write methods (`conversation-cache.ts`)

New prepared stmts + methods (match existing `this.stmts` + method style):

- `getFileState(path): FileStateRow | null`
- `upsertFileState(row): void`
- `deleteFileIndex(path): void` — deletes `conversation_file_state` row + all `conversation_message_index` rows for its conversation (truncation/identity-mismatch path).
- `appendMessageIndexRows(conversationId, rows): void` — one tx, `INSERT OR REPLACE`.
- `getMessageIndexWindow(conversationId, fromIndex, toIndex): IndexRow[]` — the window select.
- `getIndexedMessageCount(conversationId): number`.

**Test (§7.5, supports #1/#2):** `__tests__/offset-index-cache.test.ts` — append rows, read windows (tail, before_index, after_index), verify truncation delete.

---

## 4. Incremental writer — thread byte spans watcher → cache

- **Watcher:** change `onNewLines(filePath, lines)` → `onNewLines(filePath, lines, spans)` where `spans` carries `{byteOffset, byteLength}` per emitted line (absolute offsets from `readFrom` + the torn-line splitter). Advance `entry.offset` by `consumed`. Keep the old `onNewLine`/string path working (additive; spans optional) so no other caller breaks.
- **server.ts:311:** pass spans through to a new `cache.extendMessageIndex(filePath, lines, spans)`.
- **`extendMessageIndex`:** maintain a per-file `ConvReducerState` (`createJsonlParseState()`), classify each line with `parseJsonlLine(line, state)`. Message → append an index row at `last_message_index+1` with its span + `uuid`/`role`/`ts`; non-message (`null`) → no row, but its bytes still advance `byte_offset`. Update `conversation_file_state`. Single-flight per path (a `Map<path, Promise>` guard like `refreshFileGuarded`).

**Test (§7.5 #1):** append lines → a subsequent `after_index` delta returns exactly the new messages, reading only their byte ranges (spy on `fs.read`/`pread`).

---

## 5. Backfill — on-demand, yielding, single-flighted

`backfillIndex(filePath, conversationId)`:
- Triggered from the read path when `file_state` is missing/stale.
- Yielding walk: read the file in chunks, split lines with the torn-line helper, `parseJsonlLine` with a running state, `await setImmediate()` every ~1000 lines, write rows + `file_state`.
- Single-flighted per file (shared guard with §4).
- The triggering request is served by the **scanner fallback** (1a-guarded) while backfill proceeds — no await on the request path.

**Test (§7.5 #3):** truncate/replace file → index dropped (identity/size mismatch), scanner fallback correct, backfill restores rows.

---

## 6. Read path — windowed pread (`server.ts` `handleGetConversation`)

Decision point **before** the paged-scanner block (~1873):

1. `stat` the file; load `file_state`. Match = same identity AND `size >= byte_offset`.
2. Match → compute the window `[fromIndex, toIndex)` from `msg_limit`/`before_index`/`after_index` (reuse existing math), `getMessageIndexWindow`, `pread` exactly those `(byte_offset, byte_length)` ranges (one `fh`, N reads), `parseJsonlLine` each, build `messagesPayload` with `message_index = row.message_index`. Respond.
3. Identity mismatch or `size < byte_offset` → `deleteFileIndex`, enqueue `backfillIndex`, fall through to scanner (1a-guarded).
4. No `file_state` → enqueue `backfillIndex`, fall through to scanner.

**Guarded by §6 live bypass from PR 1:** a live session still serves the snapshot; the index read is for non-live detail/delta. (Confirm interaction — likely the index read is the better path even for live, but keep PR 1's bypass authoritative for now and only add the index read on the non-live branch.)

**Test (§7.5 #2):** window correctness across the incremental boundary (a page spanning backfilled + tailed regions).

---

## 7. Phase-2 enablers (additive)

- **WS `seq`:** stamp `seq = message_index` on `conversation_event`/`conversation_events` entries that correspond to an indexed message; omit for non-message lines. Old clients ignore it.
- **Delta `etag`:** add `etag: computeConversationEtag(...)` into the `message_pagination` object (server.ts:1889) on `after_index` responses. Client compares its stored etag; mismatch → discard cursor, refetch tail.

---

## 8. Perf smoke (§7.5 #6)

`__tests__/offset-index-perf.test.ts` (may be `.skip` in CI, run locally): synthetic 100 MB JSONL, warm index → detail p95 < 50 ms; `perf_hooks.monitorEventLoopDelay` max < 50 ms during active append. Guard with an env flag so CI isn't slowed.

---

## Build order (TDD, each stage `npx vitest run <file>` before moving on)

1. **Migration 009** + migration test (idempotency, clean upgrade). ✅ small, isolated.
2. **`fileIdentity` + torn-line helper** + unit test. ✅ pure, no I/O.
3. **Cache index read/write methods** + cache test.
4. **Watcher span forwarding + torn-line fix** + watcher test (existing `conversation-watcher.test.ts` must stay green).
5. **`extendMessageIndex` incremental writer** + test #1.
6. **`backfillIndex`** + test #3.
7. **Read path pread window** + tests #2.
8. **WS `seq` + delta `etag`** + additive assertions.
9. **Perf smoke** (local).
10. `npm run lint && npm test`; scoped verify + CI as full-suite gate.

## Risks / decisions to confirm during build

- **Live-session interaction:** does the index read supersede PR 1's live bypass, or stay non-live-only? Plan: non-live-only first (safest), revisit.
- **Watcher signature change** touches carefully-commented code — keep the string path intact, spans additive.
- **`conversation_id` vs pseudo-id:** `updateFromLine` derives a pseudo-id from the filename stem when the file isn't yet in `fileIndex`. The index must key on the same id the read path resolves (`findConversationByUuid`'s `uuid`), i.e. the filename stem / sessionId. Verify they agree before writing rows.
- **`message_index` must equal the scanner's message ordering** so `before_index`/`after_index` cursors from the scanner path and the index path are interchangeable. Both now classify via `parseJsonlLine` → same ordering, but assert this in test #2.
