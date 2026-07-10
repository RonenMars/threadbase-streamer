# tb-mobile backward-compatibility contract

`tb-mobile` is a released iOS/Android app — users on older app versions connect to whatever streamer version is deployed. The streamer must therefore remain backward-compatible with older mobile clients. The mobile client cannot be force-updated; a breaking server change will silently break functionality for any user who hasn't updated the app.

**Read this document before changing any API response shape, endpoint path, query parameter, status value, or WebSocket event.**

## What tb-mobile depends on (do not break without a migration plan)

**REST endpoint paths** — mobile hard-codes every path. Never rename or remove:

- `/healthz`, `/api/info`, `/api/pair/exchange`
- `/api/sessions`, `/api/sessions/count`, `/api/sessions/{id}`
- `/api/sessions/resume`, `/api/sessions/start`
- `/api/sessions/{id}/input`, `/api/sessions/{id}/cancel`
- `/api/sessions/{id}/output`, `/api/sessions/{id}/files`
- `/api/conversations`, `/api/conversations/count`, `/api/conversations/{id}`
- `/api/search`, `/api/browse`, `/api/browse/mkdir`

**New endpoint** — purely additive; older mobile builds simply don't call it:

- `GET /project-chats` — unified active-sessions + historical-conversations list. Accepts `?refreshConversations=1` (or legacy `?refresh=1`) to force a rescan; otherwise the server short-circuits via `cache_metadata.last_conversation_id`. Response shape is `{ projectChats: ProjectChat[] }` where `ProjectChat` is a discriminated union on `type: "session" | "conversation"`. Both variants carry `projectId` (the canonical project identity) and `projectPath` (compatibility metadata).
- `GET /api/conversations/{id}/search-target?q=<query>` — resolves an active search query to the message a client should scroll to. `200` body: `{ query, message_index, uuid, snippet, match_indexes, total_matches }` (`message_index` is the same absolute index the detail endpoint emits — the last chronological match; `uuid` may be null; `match_indexes` lists all matching indexes ascending, capped at the last 1000; `total_matches` is the uncapped count for the client's "N of M" counter). `404` with `code: "search_target_not_found"` when no message body contains the query (metadata-only search hit); `404` with `code: "not_found"` for an unknown conversation; `400` with `code: "invalid_query"` for an empty or >256-char `q`. Mobile treats any 404 as "open the tail view, no highlight".

**Query parameter names** — mobile builds URLs with these exact strings:
`limit`, `offset`, `sort`, `project`, `refresh`, `msg_limit`, `before_index`, `anchor_index`, `after_index`, `q`, `path`

- `anchor_index` on `GET /api/conversations/{id}` — returns a bounded window centered on that absolute message index (clamped into range, never an error). `after_index` returns the newer-direction window `[after_index, after_index + msg_limit)`. Precedence when combined: `before_index` > `after_index` > `anchor_index`. Anchored/after responses never answer `304` to `If-None-Match` — only the plain tail page participates in the ETag freshness check.

**Response field names** — these are deserialized by name in mobile types; casing matters:

- Session: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `source`, `startedAt`, `completedAt`, `lastActivityAt`, `failureReason`, `ptyAttached`
- Session — new optional fields (added during the projects refactor; never required for older clients): `projectId`, `resumedFromConversationId`
- Session — new optional field (Codex live-session support): `provider` (`"claude-code"` | `"codex-cli"`; absent/undefined means `claude-code` for older data). `conversationId` always equals `id` for the lifetime of a live session, regardless of provider — it is never rekeyed once a client has navigated to it.
- Session — new optional field (Codex live-session support): `boundConversationId`. Set once a *fresh* live session's underlying persisted conversation file is discovered after the fact (currently: Codex, whose CLI assigns its own session id that isn't known until it creates its own rollout JSONL). Distinct from both `conversationId` (always `=== id`, the stable mobile deep-link alias) and `resumedFromConversationId` (set only on the resume flow) — older clients that don't know this field can safely ignore it.
- Conversation list item: `id`, `title`, `projectPath`, `messageCount`, `lastActivity`, `firstMessage`, `lastMessage`, `preview`, `model`
- Conversation detail: `meta` object + `messages` array + `message_pagination` object
- Conversation detail `meta` — new optional fields (additive; older clients ignore them): `provider` (`"claude-code"` | `"codex-cli"`; absent means `claude-code`), `resumable` (boolean — false when the conversation's project dir no longer exists, so resume would fail; history is still served), `unavailable_reason` (`"path_missing"` | `"worktree_removed"`, present only when `resumable` is false). The same fields are also added to the resumable session shape (`status: "on_hold"`) returned by `GET /api/sessions/{id}` for conversation ids. **Behavior note (Codex resume support):** `resumable` for a `codex-cli` conversation previously was always forced to `false`; it now reflects the same on-disk project-path availability check as `claude-code` conversations, since Codex resume (`POST /api/sessions/resume`) is implemented and functional.
- Message: `message_index` (snake_case), `role`, `timestamp`, `text`, `content` (array), `tool_use_id` (snake_case)
- Pagination: `hasMore`, `offset`, `total`
- `message_pagination` — new optional fields (additive, emitted only on anchored/after windows): `anchor_index` (the clamped anchor the window was centered on), `has_more_newer`, `next_after_index` (cursor for the next `after_index` request, or null at the tail). The pre-existing fields `total`, `before_index`, `from_index`, `has_more_older`, `next_before_index` are unchanged.
- Search target (`/api/conversations/{id}/search-target`): `query`, `message_index`, `uuid`, `snippet`, `match_indexes`, `total_matches`, and the error `code` values `search_target_not_found` / `not_found` / `invalid_query` — mobile keys its fallback on the 404 status.

**Session status values** — mobile switches on these exact strings; adding a new value is fine, renaming or removing one breaks UI:
`running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle`
Note: mobile treats `on_hold` and `idle` as the same status. The server currently emits `running`/`waiting_input`/`idle` for live sessions (`SessionStatus` in `src/types.ts`) and `on_hold` for resumable conversation shapes; `completed`/`failed` are legacy values older streamer versions emitted — mobile still parses them, so don't reuse them with new semantics.

**WebSocket event types** — mobile registers listeners keyed on these strings:

- Server → client: `session_list`, `session_update`, `terminal_output`, `conversation_event`, `ping`
- Client → server: `{ type: "hold_session", sessionId }`

`conversation_events` (`{ type, sessionId, lines: string[] }`) is an **additive** server→client event that batches all lines from one watcher read into a single message. The server still emits per-line `conversation_event` alongside it, so older clients that only know `conversation_event` are unaffected. Never stop emitting `conversation_event`.

**HTTP status codes** — mobile maps these to typed errors:

- `401` → `AuthError` (triggers re-auth UI)
- `404` → `NotFoundError` (suppressed for `/output` endpoint — treated as empty). The `GET /api/conversations/{id}` 404 body now carries an additive `code: "not_found"` alongside `error`; older clients ignore it. `GET /api/browse` now answers `404` with `code: "PATH_NOT_FOUND"` when the requested `path` is inside the browse root but no longer exists on disk (e.g. a mobile-cached path whose folder was moved/deleted) — previously this case returned `400`. Out-of-root paths still return `400`. Older clients that only read the `error` string are unaffected; clients keying on the status can fall back to the nearest existing ancestor instead of dead-ending on "Unable to load directories".
- `429` → shown to user during pair exchange

**Auth format** — mobile sends `Authorization: Bearer <token>` and constructs WebSocket URLs as `/ws?key=<token>`. Both forms must continue to work.

**API key format** — mobile uses `tb_` prefix detection in pairing logic. Key format `tb_<32-hex-chars>` must be preserved.

## Safe changes

- Adding optional fields to any response object
- Adding new endpoints
- Adding new optional query parameters with sensible defaults
- Adding new WebSocket event types (mobile ignores unknown types)
- Adding new session status values (mobile will display them as-is)

## Risky changes (coordinate with tb-mobile)

- Renaming any field (including camelCase ↔ snake_case)
- Removing any field from a response
- Changing a field's type (e.g., `number` → `string`)
- Renaming or removing an endpoint
- Changing query parameter semantics (not just adding new ones)
- Changing WebSocket event type strings
- Changing pagination cursor behavior in `/api/conversations/{id}`
- Changing the NaCl box format or key exchange protocol in `/api/pair/exchange`

When making a risky change, either: (a) keep the old shape and add the new one alongside it, or (b) open a coordinated PR in tb-mobile at the same time and document the minimum required app version in the commit message.
