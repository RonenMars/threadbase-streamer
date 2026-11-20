# Unread messages in sessions and conversations — plan

**Date:** 2026-11-20
**Status:** proposal, nothing implemented.
**Repos:** tb-streamer (read state, this plan's main half) and tb-mobile (display and marking).

Searched before writing: `unread` in `src/`, `docs/` of this repo and in tb-mobile's `services/ hooks/ stores/ components/ types/ app/` (only "unreadable" hits); issues and PRs matching "unread" in `RonenMars/threadbase-streamer`, `RonenMars/threadbase-mobile` and `RonenMars/threadbase` (none relevant).

---

## 1. Goal and definition of done

A session or conversation row shows a dot when the agent has written something the user has not seen in any Threadbase client.
Opening it clears the dot on every paired device.

Done means:

- `GET /api/conversations` and `GET /api/sessions` items carry `unread` and `readThrough`; `GET /api/info` reports `readState: true`.
- `PUT /api/conversations/:id/read` advances the read mark and broadcasts `read_state_changed`.
- Upgrading a server lights up nothing: every conversation that existed before the upgrade reads as read.
- Mobile shows the dot on both list screens, clears it on open, and shows nothing against a server without `readState`.
- Tests listed in §6 pass, each negative test seen red once.

Out of scope for v1: a numeric unread count, "mark as unread", the app icon badge. §8 says when to add each.

## 2. What "unread" means

```
unread = lastAssistantActivity > readThrough
```

- **`readThrough`** — the newest transcript timestamp the user has seen in this conversation, stored on the server.
- **`lastAssistantActivity`** — `conversation_meta.last_activity` when `last_message.role` is `assistant`. When the newest message is the user's own, the conversation is not unread: a prompt typed at the desk terminal must not light the phone.

Both sides are **transcript timestamps** (epoch ms). `last_activity` is set from `line.timestamp`, not from the clock at ingestion (`conversation-cache.ts`, `const timestamp = line.timestamp ?? new Date().toISOString()`), so a client marking "read through the newest message I rendered" compares like with like.
The server never stamps `Date.now()` as a read mark: a message landing while the mark request is in flight would be swallowed.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Read state is **per server, shared by all paired devices**, in `runtime.db`. | Same model as `saved_items` and `pinned_dirs`. Reading on the phone should clear the web client. It is user intent, not rebuildable, so it must survive `tb-streamer cache clear` and the integrity monitor's reset; `cache.db` would lose it. |
| D2 | Keyed by **conversation id**; a session inherits its conversation's state. | The transcript is what gets read. Resume appends to the same JSONL, so a resumed session keeps its read state. Codex placeholder ids resolve through `resolveConversationLookupId` (`server.ts`) to the bound rollout id, the same as `GET /api/conversations/:id`. |
| D3 | The mark is **monotonic**: `read_through = MAX(read_through, through)`. | Two devices marking out of order, or a retried request, can never move it backward. |
| D4 | **A conversation with no row is read through a baseline epoch**, recorded once when the migration runs. | Without it, upgrading lights every historical conversation. With it, only activity after the upgrade can be unread. |
| D5 | **A dot, not a count.** | `message_count` counts every `user`/`assistant` line, tool results included, and a rescan takes `MAX` of two counts; as an unread count it would be noisy and wrong. A count needs its own counter — §8. |
| D6 | Session `lastActivityAt` is **not** used. | It moves on PTY output and input (spinner repaints included), a different clock domain from the transcript. Session rows read `last_activity` from their conversation's cache row. |
| D7 | No row, no transcript, no dot. | A session that has not prompted, or a Codex session not yet bound to a rollout, has nothing to read. |

## 4. Streamer changes

### 4.1 Schema — `src/db/runtime-migrations/010_create_conversation_reads.sql`

Next free number is `010` (two files share `009`).

```sql
-- Read marks for the unread dot, shared by every device paired with this
-- streamer. runtime.db, not cache.db: a read mark is user intent that no
-- rescan can rebuild (same reasoning as saved_items).
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id    TEXT PRIMARY KEY,
  read_through       INTEGER NOT NULL,  -- transcript timestamp, epoch ms
  updated_at         INTEGER NOT NULL,
  updated_by_device  TEXT NULL          -- diagnostics only, as in saved_items
);

-- One row: conversations with no read row count as read through this instant,
-- so an upgrade does not mark the whole history unread.
CREATE TABLE IF NOT EXISTS conversation_reads_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  baseline  INTEGER NOT NULL
);
INSERT OR IGNORE INTO conversation_reads_meta (id, baseline)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
```

No foreign key to `conversation_meta`: it lives in the other file, and an orphaned row costs a few bytes.

### 4.2 Repository — `src/db/repositories/conversation-reads.repository.ts`

Three methods, modelled on `saved-items.repository.ts`:

- `readThrough(ids: string[]): Map<string, number>` — one `SELECT … WHERE conversation_id IN (…)` per list request, missing ids filled with the baseline.
- `markRead(id, through, deviceId)` — `INSERT … ON CONFLICT DO UPDATE SET read_through = MAX(read_through, excluded.read_through)`; returns the stored value.
- `baseline(): number`.

### 4.3 Route — `PUT /api/conversations/:id/read`

- Body `{ "through": "<ISO timestamp>" }` — the timestamp of the newest message the client rendered.
- Resolves `:id` through `resolveConversationLookupId`, so a Codex session id works.
- `200 { conversationId, readThrough, unread }`; `400` on a missing or unparsable `through`; `503 STORE_UNAVAILABLE` when `runtime.db` did not open (same as saved items).
- A `through` later than the conversation's `last_activity` is clamped to it, so a skewed client clock cannot pre-read messages that have not arrived yet.
- Broadcasts `{ type: "read_state_changed", conversationId, readThrough }` to every subscriber, which is what clears the dot on the other devices.

It goes in `conversations.routes.ts` beside the other per-conversation routes, not in a new route file.

### 4.4 Decorating the lists

One helper, `unreadFor(meta, readThrough)`, applying §2, used in three places:

1. `GET /api/conversations` items (`ConversationListItem`): add `unread: boolean`, `readThrough: string` (ISO).
2. `GET /api/sessions` items (`SessionResponse`): the same two fields, read from the cache row of `boundConversationId ?? conversationId`. `unread: false` per D7 when there is no row.
3. `session_update` frames (`server-wiring.ts`, the `broadcast({ type: "session_update", … })` sites): the same fields, so a turn ending while the phone sits on the list lights the dot without a refetch. A turn end is the moment that matters, and it already emits a `session_update`.

Conversation rows need no new frame: mobile already refetches the list on `conversation_updated` (§5.2), and the refetched items carry `unread`.

`readThrough` ships beside `unread` so a client can recompute the dot when a newer `lastActivity` reaches it by another path, without waiting for the next list.

### 4.5 Capability

`GET /api/info` gains `readState: true` (`misc.routes.ts`, beside `savedItems`). Absent means an older server: the client shows no dots.

### 4.6 Compatibility

Additive only: two optional fields on existing payloads, one new route, one new WS frame type. No grep of tb-mobile is needed (CLAUDE.md "Backward compatibility": additive changes need no check). Older mobile builds ignore all of it.

## 5. Mobile changes

Anchors checked against tb-mobile `main` on 2026-11-20; line numbers drift, the quoted anchors do not.

### 5.1 Showing the dot

- **One component.** Every list row ends up in `components/sessions/shared/ConversationListItem.tsx` (`export function ConversationListItem`), which already has a dot rail (`externalLiveDot`). Add an `unread` prop rendered with `components/sessions/LiveDot.tsx` (`live={false}` gives a static dot). No new dot component.
- **Feed it** from the rows that build `ConversationListItem`: `components/sessions/hub/SessionRow.tsx`, `components/sessions/hub/ConvRow.tsx`, `components/sessions/now/EarlierRow.tsx`, `NeedsYouCard.tsx`, `WorkingCard.tsx`, and `components/conversation/ConversationList.tsx` on the project screen.
- **Types** (`types/api.ts`): add optional `unread?: boolean` and `readThrough?: string` to Session and Conversation. Absent means no dot, per "degrade, don't break".
- **Gate** on `GET /api/info` → `readState === true`, cached per server like the other capability flags. Without it no row shows a dot, and nothing calls the mark route.

### 5.2 Keeping the list live

No new plumbing is needed for the common case:

- `session_update` is already merged into the session cache (`lib/eagerCacheSync.ts`, `applySessionUpdateToEagerCache`); the new fields ride along.
- `conversation_updated` already refreshes the conversation list with a 1 s debounce (`app/_layout.tsx`, `refreshEagerConversations`), so the refetched rows carry the server's `unread`.
- **New:** handle `read_state_changed` (`services/ws-client.ts`) by setting `unread: false` / `readThrough` on the matching session and conversation rows in the query cache. This is what clears the dot on a second device without a refetch.

### 5.3 Marking read

- **When:** while a detail screen is focused **and** the app is foreground, on open and again whenever a newer message is rendered, throttled to one request per 2 s per conversation.
  - `app/conversation/[id].tsx` already has the focus-and-foreground condition (`useFocusEffect(` with `AppState.currentState === 'active'`).
  - `app/session/[id].tsx` already tracks the viewed session (`setViewedSession({ serverId, sessionId: id })`); mark from the same effect, using the session's conversation id.
- **What:** `PUT /api/conversations/:id/read` with `through` = the timestamp of the newest message on screen. Never the device clock (§2).
- **Optimistic:** set `unread: false` on the row in the query cache before the request; the next list or `read_state_changed` confirms it. A failed request is dropped silently: the dot comes back on the next refresh, which is the honest state.
- **Push taps** need nothing extra: `resolveTapRoute` (`lib/coldStartDeepLink.ts`) opens the detail screen, which marks it.

### 5.4 Not on mobile

- No local read store. The server is the source of truth (D1); a second copy keyed by `serverId::id` (as `stores/sessionNames.ts` does for names) would only drift from it.
- No `setBadgeCountAsync`; the app sets no icon badge today and v1 does not start (§8).

### 5.5 Mobile tests

Unit and integration suites (`test:unit` alone is a false green):

- `ConversationListItem` renders the dot for `unread: true` and not for `false` or absent.
- `read_state_changed` clears the matching row in the cache and leaves others alone.
- The conversation screen sends one mark on focus, none while backgrounded, and none against a server without `readState`.

## 6. Tests (streamer)

- **Migration**: runs on a fresh `runtime.db` and on one at `009`; the baseline row exists once and a second run leaves it unchanged.
- **Repository**: `markRead` is monotonic (older `through` after newer leaves the newer); missing ids return the baseline.
- **Route**: `200` advances and broadcasts `read_state_changed`; `400` on a bad body; `503` with no store; a Codex placeholder id lands on the bound rollout id; a future `through` is clamped.
- **Unread rule**, each with a positive control that goes red first:
  - assistant line after the mark → `unread: true`;
  - user line last → `false`;
  - conversation older than the baseline with no row → `false`;
  - session with no bound transcript → `false`.
- **Survives a cache clear**: mark, delete `cache.db`, rescan → still read.
- **`session_update`** after a turn end carries `unread: true`.

`npm run lint && npm test` before each commit.

## 7. Delivery

1. File the issue in both repos, each describing its own half, linked by URL: `P2: show unread conversations and sessions` (`enhancement`, `ux`).
2. Streamer PR 1: migration, repository, route, `readState` flag.
3. Streamer PR 2: list and `session_update` decoration. Can fold into PR 1 if it stays small.
4. Mobile PR after the streamer release that carries `readState`.

Each PR closes out with a status comment on its issue (CLAUDE.md "Issue status updates").

## 8. Deliberately left out

| Left out | Add when |
|---|---|
| Unread **count** | Someone asks for a number. Needs an `assistant_count` column on `conversation_meta` bumped in `updateMetaBatch` and recounted on rescan, plus `read_count` in the read row. |
| **Mark as unread** | Asked for. `DELETE /api/conversations/:id/read` that sets `read_through` back to the baseline; it breaks D3's monotonicity, so it needs its own test. |
| **App icon badge** | Pushes already carry the conversation. Badge = number of unread conversations; needs the count of `unread` across the list, server-side so a push can set it. |
| Advancing the mark when the user **sends input** | Only if a client sends input without the conversation open. Today replying means the screen is open, which already marks it. |
| Per-device read state | Someone wants the phone and the web client to disagree. D1 says shared. |

## 9. Open questions, with the default this plan takes

1. **Shared or per-device?** Shared (D1).
2. **Should the user's own prompt from an external terminal light the dot?** No (§2 role check).
3. **Subagent transcripts?** Not shown in lists today (`is_subagent IS NOT 1`), so no dot; a parent's dot follows the parent's own transcript only.
