# Unread messages in sessions and conversations — plan

**Date:** 2026-11-20, revised 2026-11-23 (per-message read acks).
**Status:** proposal, nothing implemented.
**Repos:** tb-streamer (read state, this plan's main half) and tb-mobile (display and acking).

Searched before writing: `unread` in `src/`, `docs/` of this repo and in tb-mobile's `services/ hooks/ stores/ components/ types/ app/` (only "unreadable" hits); issues and PRs matching "unread" in `RonenMars/threadbase-streamer`, `RonenMars/threadbase-mobile` and `RonenMars/threadbase` (none relevant).

---

## 1. Goal and definition of done

A session or conversation row shows a dot when the agent has written a reply the user has not seen in any Threadbase client.
The server records each reply a client actually put on screen, so a reply that was loaded but never scrolled into view stays unread.
Opening a conversation clears only what was seen, on every paired device.

Done means:

- `GET /api/conversations` and `GET /api/sessions` items carry `unread` and `readThrough`; messages in `GET /api/conversations/:id` carry `unread` and `readAt`; `GET /api/info` reports `readState: true`.
- `PUT /api/conversations/:id/read` takes one ack per rendered range (two timestamps), not one per message and not an array of ids. It records the replies in that range, advances the row's read point, and broadcasts `read_state_changed`.
- A reply is marked read only by a client ack sent after it was on screen. Delivery to a device never marks it, so a phone that lost its connection or died before rendering leaves the reply unread.
- Read state survives a streamer restart and `tb-streamer cache clear`. A conversation whose live session did not come back after a restart still shows its dot.
- Upgrading a server lights up nothing: every conversation that existed before the upgrade reads as read.
- Mobile shows the dot on both list screens, on idle and on-hold rows as well as live ones, and shows nothing against a server without `readState`.
- Tests listed in §6 (streamer) and §5.5 (mobile) pass, each negative test seen red once.

Out of scope for v1: a numeric unread count, "mark as unread", the app icon badge. §8 says when to add each.

## 2. What "unread" means

A **countable message** is a reply the user can read: an `assistant` line with non-empty text that is not a thinking block and not a sidechain, and that has a timestamp.
Tool results, tool-use-only turns, the user's own prompts and lines without a timestamp are never countable, so none of them lights the dot or hides one.

```
key(m)      = m.uuid, else "ts:" + epoch ms of m.timestamp
unread(m)   = countable(m) AND m.ts > frontier AND key(m) has no ack
unread(row) = lastCountableTs > frontier
```

- **Ack** — a client's statement that it rendered a message. First ack wins: `readAt` is the time of the first one and never moves.
- **`frontier`** — the newest transcript time such that every countable message at or before it was read or predates the baseline. It advances only over an unbroken run of acked messages, so one skipped reply holds it back however many newer ones were read.
  This keeps the row rule exact. Any unacked countable message above the frontier forces `frontier < message.ts <= lastCountableTs`, and when every one is acked the frontier reaches `lastCountableTs`. The list therefore never reads per-message rows.
- **`lastCountableTs`** — the newest countable message's timestamp, kept on `conversation_meta` (§4.1).

Take 144 agent replies of which the user rendered only the newest 50. The frontier stays at the last reply that was read before the 94 unseen ones, so the row stays unread and the 94 report `unread: true` until they scroll into view. The 50 that were seen report `unread: false` with a `readAt`, even though the frontier has not reached them.

Three states fall out of the rule and are not stored or sent as an enum:

| State | Derivation | Dot |
|---|---|---|
| empty | no countable message yet (a started session with no turn, or only user lines) | none |
| read | `lastCountableTs <= frontier` | none |
| unread | `lastCountableTs > frontier` | yes |

A client that wants to say "no messages yet" has `messageCount`; the dot needs only `unread`.

Timestamps are epoch ms in the database and in the §2 comparisons, ISO strings on the wire.
Both sides are **transcript timestamps**: the server never stamps `Date.now()` as a read point, so a message landing while an ack is in flight is not swallowed.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Read state is **per server, shared by all paired devices**, in `runtime.db`. | Required behaviour: a user with any number of paired devices (web app, phone, others) reads a reply on one and it is marked read on all of them, so the state cannot live on a device. Same model as `saved_items` and `pinned_dirs`. It is user intent, not rebuildable, so it must survive `tb-streamer cache clear` and the integrity monitor's reset; `cache.db` would lose it. |
| D2 | Keyed by **conversation id**; a session inherits its conversation's state. | The transcript is what gets read. Resume appends to the same JSONL, so a resumed session keeps its read state. Codex placeholder ids resolve through `resolveConversationLookupId` (`server.ts`) to the bound rollout id, the same as `GET /api/conversations/:id`. |
| D3 | **Per-message read state, recorded from bulk acks (D9), first ack wins, plus a monotonic frontier.** | A single "read through" timestamp marks every older reply read the moment the newest page renders, and `GET /api/conversations/:id` pages from the tail (`msg_limit`, `before_index`). Acks keep a skipped reply unread and give each message a `readAt`. |
| D4 | **The frontier of a conversation with no row is a baseline epoch**, recorded once when the migration runs. | Without it, upgrading lights every historical conversation. With it, only replies after the upgrade can be unread, and the cache needs no backfill of the countable flag. |
| D5 | **A dot, not a count.** | A count is now derivable (countable messages above the frontier without an ack) but needs its own query path and a decision on what it shows; §8. |
| D6 | Session `lastActivityAt` is **not** used. | It moves on PTY output and input (spinner repaints included), a different clock domain from the transcript. Session rows read `lastCountableTs` from their conversation's cache row. |
| D7 | No row, no transcript, no dot. | A session that has not prompted, or a Codex session not yet bound to a rollout, has nothing to read. |
| D8 | **Only a client ack marks read.** | The server never infers "read" from serving a page or sending a frame. Both cases where that would be wrong (offline phone, a page never scrolled) are the reason for this plan. |
| D9 | **A client acks a transcript-time range, never message ids.** The server expands the range into per-message rows using its own index, keyed by `uuid`, falling back to the timestamp. | A page of 50 is one small request, and a client cannot ack a key the server never indexed. `ConversationMessage.uuid` is optional in the scanner type. Both keys survive a cache rebuild, which the cache's `message_index` does not (migrations 018 and 022 renumbered it). |

## 4. Streamer changes

### 4.1 Schemas

**Cache** — `src/db/migrations/030_add_unread_eligibility.sql` (next free number after `029`). Rebuildable, so it lives with the cache:

```sql
-- Which indexed messages can be unread, and the newest such timestamp per
-- conversation. Existing rows stay 0 / NULL: the baseline (runtime migration
-- 010) makes all earlier history read, so nothing needs a backfill.
ALTER TABLE conversation_message_index ADD COLUMN counts_for_unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_meta ADD COLUMN last_countable_ts INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_message_index_countable
  ON conversation_message_index (conversation_id, ts) WHERE counts_for_unread = 1;
```

- Both places that build an index row in `conversation-cache.ts` (the two `uuid: msg.uuid ?? null` sites) set `counts_for_unread` from the parsed message: assistant, non-empty text, not thinking, not sidechain, timestamp present.
- `last_countable_ts` is set where `last_activity` is set (`updateMetaBatch`) as `MAX(existing, new)` and recomputed on rescan.

**Runtime** — `src/db/runtime-migrations/010_create_conversation_reads.sql` (next free number is `010`; two files share `009`):

```sql
-- Read acks for the unread dot, shared by every device paired with this
-- streamer. runtime.db, not cache.db: an ack is user intent that no rescan
-- can rebuild (same reasoning as saved_items).
CREATE TABLE IF NOT EXISTS message_reads (
  conversation_id TEXT    NOT NULL,
  message_key     TEXT    NOT NULL,   -- uuid, else "ts:<epoch ms>"
  message_ts      INTEGER NOT NULL,   -- transcript timestamp, epoch ms
  read_at         INTEGER NOT NULL,   -- when the first ack arrived
  read_by_device  TEXT    NULL,       -- diagnostics only, as in saved_items
  PRIMARY KEY (conversation_id, message_key)
);

-- The read point per conversation, derived from the acks in the same
-- transaction that writes them.
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id TEXT PRIMARY KEY,
  frontier        INTEGER NOT NULL,   -- epoch ms
  updated_at      INTEGER NOT NULL
);

-- One row: conversations with no row count as read through this instant.
CREATE TABLE IF NOT EXISTS conversation_reads_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  baseline  INTEGER NOT NULL
);
INSERT OR IGNORE INTO conversation_reads_meta (id, baseline)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
```

No foreign key to `conversation_meta`: it lives in the other file, and an orphaned row costs a few bytes.
`message_reads` keeps one row per message read and v1 never prunes it; at roughly 150 replies a day that is tens of thousands of rows a year in one heavy conversation, which SQLite handles. Prune when it is measured to matter.

### 4.2 Repository — `src/db/repositories/conversation-reads.repository.ts`

Modelled on `saved-items.repository.ts`:

- `frontiers(ids: string[]): Map<string, number>` — one `SELECT … IN (…)` per list request, missing ids filled with the baseline.
- `recordAcks(id, messages: {key, ts}[], deviceId)` — `INSERT OR IGNORE` per message in one transaction; returns the keys that were new, with their `read_at`. The caller builds `messages` from the cache index for the acked range.
- `advance(id, countableAbove: {key, ts}[])` — given the countable messages above the current frontier in time order (read from the cache index by the caller), walks the unbroken acked prefix and sets `frontier` to the last one's timestamp. Never moves it backward.
- `acksFor(id, keys)` — `{key → read_at}` for decorating a page of messages.
- `baseline(): number`.

The two files are separate SQLite databases and the codebase uses no `ATTACH`, so the route reads the countable messages from the cache and the acks from `runtime.db` and intersects them in code.

### 4.3 Route — `PUT /api/conversations/:id/read`

An ack names a range of transcript time. Body is `{ "from": "<ISO timestamp>", "through": "<ISO timestamp>" }`: every countable message whose timestamp lies in that inclusive range is acked.

- **A fetched page:** the client already has each message's `timestamp`, so it sends the oldest message it put on screen as `from` and the page's newest as `through`. A page it only half scrolled is half acked. A page of 50 is one request.
- **Live replies and the raw-terminal session screen** use the same body (§5.3).
- The body is two timestamps and no message ids, whatever the page size. There is no response-id: the `GET` response carries nothing extra for acking, and the server holds no per-response state.
- At most 500 countable messages are acked per request; a longer range acks the oldest 500 and answers `truncated: true`.
- **Retrying is safe.** The ack writes rows with `INSERT OR IGNORE`, so the first `readAt` stays and a repeat answers `200` with `acked: 0`. A client whose `200` was lost can resend without knowing whether the first request landed. The client keeps its pending range in memory until a `200`; if the app dies first the range is lost and the messages stay unread.

Behaviour:

- Resolves `:id` through `resolveConversationLookupId`, so a Codex session id works.
- Expands the range into the countable messages the cache index holds for it, records them, then runs `advance`. A range that holds no indexed message records nothing, so a skewed client clock or a made-up range pre-reads nothing.
- **Known ceiling: a message indexed late.** A countable message indexed after the client fetched its page, with a timestamp older than the page's newest, falls inside the range and is acked although the client never received it. Transcripts append in order, so this needs an out-of-order timestamp. A count-checked token would catch it; v1 accepts the ceiling rather than carry one (§9).
- `200 { conversationId, readThrough, unread, acked, truncated }`, where `acked` is how many messages were newly recorded; `400` on a missing body, an unparsable timestamp, a missing field or `from` after `through`; `503 STORE_UNAVAILABLE` when `runtime.db` did not open (same as saved items).
- Broadcasts `{ type: "read_state_changed", conversationId, readThrough, unread, read: [{ key, readAt }] }` to every subscriber, which is what clears the dot and the per-message flags on the other devices. `unread` is computed by the server after the acks, so a newer reply that arrived meanwhile keeps the dot lit. `read` lists only the keys newly recorded.
- **Known ceiling.** A live reply a client rendered from a WebSocket line before the cache indexed it is in no range the server can expand, so it stays unread until the client acks a later range that covers it. Whether the cache write precedes the WS line broadcast is unverified.

It goes in `conversations.routes.ts` beside the other per-conversation routes, not in a new route file.

### 4.4 Decorating responses

`unreadFor(lastCountableTs, frontier)` is the one helper applying the row rule, used in four places:

1. `GET /api/conversations` items (`ConversationListItem`): add `unread: boolean`, `readThrough: string` (ISO, the frontier).
2. `GET /api/sessions` items (`SessionResponse`): the same two fields, plus `transcriptActivityAt` (ISO, the cache row's `last_countable_ts`) for the session screen (§5.3), read from the cache row of `boundConversationId ?? conversationId`. `unread: false` per D7 when there is no row.
3. `GET /api/conversations/:id` messages: each countable message gets `unread: boolean` and, once acked, `readAt: string` (ISO). One query for the page's keys through `acksFor`, plus the frontier. A countable message at or before the frontier with no ack is `unread: false` with no `readAt`: it predates tracking. Messages that are not countable carry neither field.
4. `session_update` frames: the row fields, so a turn ending while the phone sits on the list lights the dot without a refetch. A turn end is the moment that matters, and it already emits a `session_update`.
   Frames are emitted from about 14 places (`server.ts`, `session-watchers.ts`, `sessions.handlers.ts`, `progress.routes.ts`, …), not one, and mobile merges a frame over the old row (`{...s, ...session}`), so an undecorated frame leaves a stale `unread: false`. Decorate once, at emit time, through one shared helper that every site goes through, rather than patching sites one by one.
   `noteLastMessage` (`server.ts`) matters most: it sends the late corrective frame after the transcript lands, which can follow a turn-end frame that went out before the write.

Conversation rows need no new frame: mobile already refetches the list on `conversation_updated`, which external conversations emit (§5.2), and the refetched items carry `unread`.

### 4.5 Capability

`GET /api/info` gains `readState: true` (`misc.routes.ts`, beside `savedItems`). Absent means an older server: the client shows no dots and sends no acks.

### 4.6 Compatibility

Additive only: optional fields on list items, session payloads and messages, one new route, one new WS frame type. No grep of tb-mobile is needed (CLAUDE.md "Backward compatibility": additive changes need no check). Older mobile builds ignore all of it.

## 5. Mobile changes

Anchors checked against tb-mobile `main` on 2026-11-20; line numbers drift, the quoted anchors do not.

### 5.1 Showing the dot

- **One component.** Every list row ends up in `components/sessions/shared/ConversationListItem.tsx` (`export function ConversationListItem`), which already has a dot rail (`externalLiveDot`). Add an `unread` prop rendered with `components/sessions/LiveDot.tsx` (`live={false}` gives a static dot). No new dot component.
- **Feed it** from the rows that build `ConversationListItem`: `components/sessions/hub/SessionRow.tsx`, `components/sessions/hub/ConvRow.tsx`, `components/sessions/now/EarlierRow.tsx`, `NeedsYouCard.tsx`, `WorkingCard.tsx`, and `components/conversation/ConversationList.tsx` on the project screen.
- **Not tied to liveness.** The dot reads `unread` and nothing about whether a PTY is running, so a conversation whose session did not come back after a streamer restart shows it on its on-hold row the same as a live one.
- **Types** (`types/api.ts`): add optional `unread?: boolean` and `readThrough?: string` to Session and Conversation, and optional `unread?: boolean` and `readAt?: string` to the message type. Absent means no dot, per "degrade, don't break".
- **Placement and precedence.** The unread dot sits in the same rail as `externalLiveDot`, and where both apply the live dot wins and the unread dot is not drawn; the row's accessibility label still says "unread". The tier colour is unaffected. `NeedsYouCard` and `WorkingCard` follow the same rule, since they render through `ConversationListItem`.
- **Accessibility.** The dot is visual only, so the row's accessibility label gains an "unread" phrase when `unread` is true.
- **Gate** on `GET /api/info` → `readState === true`, cached per server like the other capability flags. Without it no row shows a dot, and nothing calls the ack route.

### 5.2 Keeping the list live

No new plumbing is needed for the common case:

- `session_update` is already merged into the session cache (`lib/eagerCacheSync.ts`, `applySessionUpdateToEagerCache`); the new fields ride along.
- `conversation_updated` already refreshes the conversation list with a 1 s debounce (`app/_layout.tsx`, `refreshEagerConversations`), so the refetched rows carry the server's `unread`.
  The streamer sends it only for **external** conversations (`external-tails.ts`, `ownership: "external"`); managed sessions are covered by `session_update`.
  Any other conversation picks up its dot on the next list fetch, which is the ceiling v1 accepts.
- **New:** handle `read_state_changed` (`services/ws-client.ts`) by setting the event's `unread` and `readThrough` on the matching session and conversation rows in the query cache, and `unread: false` plus `readAt` on the messages named in `read` when that conversation is cached. This is what clears the dot on a second device without a refetch, and it never hides a reply that arrived during the ack.

### 5.3 Acking

An ack means "this page was on screen". Fetching a page is not an ack. One request acks a whole page, and no request carries message ids.

- **When:** while a detail screen is focused **and** the app is foreground.
  - `app/conversation/[id].tsx` already has the focus-and-foreground condition (`useFocusEffect(` with `AppState.currentState === 'active'`).
  - `app/session/[id].tsx` already tracks the viewed session (`setViewedSession({ serverId, sessionId: id })`); ack from the same effect, using the session's conversation id.
- **What, on the conversation screen:** use the list's viewability callback (`onViewableItemsChanged`) with a `viewabilityConfig` of `itemVisiblePercentThreshold: 50` and `minimumViewTime: 500` to track the **oldest and newest messages that stayed viewable**, and send `{ from: <oldest's timestamp>, through: <newest's timestamp> }`. A page the user opens at the tail and reads down to its first message is one request for all 50. A page scrolled only partway acks from where the user got to, so a fast scroll past 94 older messages acks none of them until the list settles on them. Whether the message list is a `FlatList`/`FlashList` that supports this config is unverified and is the first thing to check in the mobile PR.
- **Live replies on the conversation screen:** a reply that arrives over the WebSocket while the screen is focused and the app is foreground is acked the same way once it is viewable, so a burst is still one request.
- **What, on the session screen:** the screen may show a raw terminal, which has no message list. It sends `{ "from": <transcriptActivityAt when the screen focused>, "through": <the newest transcriptActivityAt seen since> }` (§4.4). That acks the replies that streamed past while the screen was open and leaves earlier ones unread until they are seen in the message view. Assumption for the owner to confirm: watching live terminal output counts as reading it.
- **Batching:** keep one pending range per conversation, widened as more messages become viewable, and flush at most once per 2 s per conversation.
- **Failure:** the pending range stays until a `200`, and the next flush resends it. If the app dies first the range is lost and the dot stays, which is the honest state.
- **No optimistic row update.** Whether a row is still unread depends on the server's frontier, which the client cannot compute, so the row dot clears on the `200` or on `read_state_changed`. Per-message flags may update optimistically.
- **Push taps** need nothing extra: `resolveTapRoute` (`lib/coldStartDeepLink.ts`) opens the detail screen, which acks what becomes viewable.

### 5.4 Not on mobile

- No local read store. The server is the source of truth (D1); a second copy keyed by `serverId::id` (as `stores/sessionNames.ts` does for names) would only drift from it.
- No `setBadgeCountAsync`; the app sets no icon badge today and v1 does not start (§8).

### 5.5 Mobile tests

Unit and integration suites (`test:unit` alone is a false green):

- `ConversationListItem` renders the dot for `unread: true` and not for `false` or absent, and its accessibility label includes "unread" only when `unread` is true.
- An idle or on-hold row with `unread: true` shows the dot.
- `read_state_changed` clears the matching row and marks the named messages read in the cache, and leaves others alone.
- A fetched page of 50 acks with one request of two timestamps and no message ids; with only the newest 10 viewable, `from` is the oldest of those 10.
- Scrolling fast past an older page sends nothing for it until the list settles on it.
- A burst of live replies is one request.
- A failed ack is resent with the next flush; a `200` clears it.
- No ack while backgrounded, and none against a server without `readState`.

## 6. Tests (streamer)

- **Migrations**: cache `030` and runtime `010` run on a fresh database and on one at the previous number; the baseline row exists once and a second run leaves it unchanged.
- **Ingestion flag**: an assistant line with text is countable; a tool-use-only assistant line, a thinking line, a sidechain line, a `user` line (empty or not) and a line with no timestamp are not. `last_countable_ts` takes the `MAX` and survives a rescan.
- **Repository**: a second ack of the same message leaves `read_at` unchanged; `advance` never moves the frontier backward; missing ids return the baseline.
- **The 144 / 50 case**, with a positive control that goes red first: ack only the newest 50 of 144 countable messages → frontier unchanged, `unread: true`, the 94 report `unread: true` and the 50 report `unread: false` with a `readAt`; then ack the 94 → frontier at the newest, `unread: false`.
- **Unread rule**, each with a positive control:
  - countable message after the frontier → `unread: true`;
  - user line with text last → `false`;
  - tool-result line after a countable message → `unread: true`;
  - conversation older than the baseline with no row → `false`;
  - session with no bound transcript → `false`.
- **Delivery is not reading**: `GET /api/conversations/:id` and a `session_update` followed by no ack leave the conversation unread.
- **Route**: `200` records, advances and broadcasts `read_state_changed`; `400` on a missing body, a missing or unparsable timestamp or `from` after `through`; `503` with no store; a Codex placeholder id lands on the bound rollout id.
- **Range acks**, each with a positive control: `{ from, through }` acks only countable messages inside the range, inclusive of both ends, in one request; a range with no indexed message records nothing and does not move the frontier; a range of more than 500 acks the oldest 500 and answers `truncated: true`.
- **Retry**: sending the same range twice leaves each `readAt` unchanged and answers `acked: 0` the second time.
- **Survives a restart**: an ack made after closing and reopening `runtime.db` and the cache still resolves.
- **Survives a cache clear and a restart**: ack, delete `cache.db` and rescan, then close and reopen `runtime.db` → still read, and a conversation left unread stays unread.
- **Message decoration**: a page carries `unread` and `readAt` on countable messages only, and a countable message below the frontier with no ack has `unread: false` and no `readAt`.
- **`session_update`** after a turn end carries `unread: true`, including when the turn settles before the transcript write and `noteLastMessage` sends the late frame.
- **`read_state_changed`** carries the server-computed `unread`: an ack followed by a newer countable line broadcasts `unread: true`.

`npm run lint && npm test` before each commit.

## 7. Delivery

1. File the issue in both repos, each describing its own half, linked by URL: `P2: show unread conversations and sessions` (`enhancement`, `ux`).
2. Streamer PR 1: cache migration `030` and the ingestion flag, runtime migration `010`, repository, route, `readState` flag.
3. Streamer PR 2: list, message and `session_update` decoration. Can fold into PR 1 if it stays small.
4. Mobile PR after the streamer release that carries `readState` **and** the decoration (step 3). If step 3 stays a separate PR, the mobile PR waits for its release too, since `readState: true` alone would show a gate with no `unread` on any row.

Each PR closes out with a status comment on its issue (CLAUDE.md "Issue status updates").

## 8. Deliberately left out

| Left out | Add when |
|---|---|
| Unread **count** | Someone asks for a number. Count the countable messages above the frontier with no ack; it needs a batched query for the list and a rule for what the number means when replies were skipped. |
| **Mark as unread** | Asked for. Delete the message's ack and pull the frontier back below it; it breaks the frontier's monotonicity, so it needs its own test. |
| **App icon badge** | Pushes already carry the conversation. Badge = number of unread conversations; needs the count of `unread` across the list, server-side so a push can set it. |
| Advancing the read point when the user **sends input** | Only if a client sends input without the conversation open. Today replying means the screen is open, which already acks. |
| Per-device read state | Someone wants the phone and the web client to disagree. D1 says shared. |
| Clearing the dot for replies **read at the desk terminal** | Users report dots for replies they already read. Only Threadbase clients can ack a message, so a reply read in the terminal still lights the phone until the conversation is opened there. v1 accepts it. |
| Pruning `message_reads` | The table is measured to matter. v1 keeps every row so each message keeps its `readAt`. |

## 9. Open questions, with the default this plan takes

1. **Shared or per-device?** Shared (D1).
2. **Should the user's own prompt from an external terminal light the dot?** No: only countable replies do (§2).
3. **Subagent transcripts?** Not shown in lists today (`is_subagent IS NOT 1`), so no dot; a parent's dot follows the parent's own transcript only.
4. **Does watching live terminal output count as reading?** Yes, for replies that arrive while the session screen is open (§5.3).

Unverified, to settle in the first PR that needs each: which providers emit messages without a `uuid` (the timestamp key covers them, with a collision only for two replies in the same millisecond); whether the cache write precedes the WS line broadcast (§4.3); whether the mobile message list supports a viewability config (§5.3); whether any provider writes a countable line with a timestamp older than the line before it, which is what the late-indexed ceiling in §4.3 needs (if one does, add a count to the ack so the server can refuse a range that grew).
