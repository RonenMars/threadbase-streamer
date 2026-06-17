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

**Query parameter names** — mobile builds URLs with these exact strings:
`limit`, `offset`, `sort`, `project`, `refresh`, `msg_limit`, `before_index`, `q`, `path`

**Response field names** — these are deserialized by name in mobile types; casing matters:

- Session: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `source`, `startedAt`, `completedAt`, `lastActivityAt`, `failureReason`, `ptyAttached`
- Session — new optional fields (added during the projects refactor; never required for older clients): `projectId`, `resumedFromConversationId`
- Conversation list item: `id`, `title`, `projectPath`, `messageCount`, `lastActivity`, `firstMessage`, `lastMessage`, `preview`, `model`
- Conversation detail: `meta` object + `messages` array + `message_pagination` object
- Conversation detail `meta` — new optional fields (additive; older clients ignore them): `resumable` (boolean — false when the conversation's project dir no longer exists, so resume would fail; history is still served), `unavailable_reason` (`"path_missing"` | `"worktree_removed"`, present only when `resumable` is false). The same two fields are also added to the resumable session shape (`status: "on_hold"`) returned by `GET /api/sessions/{id}` for conversation ids.
- Message: `message_index` (snake_case), `role`, `timestamp`, `text`, `content` (array), `tool_use_id` (snake_case)
- Pagination: `hasMore`, `offset`, `total`

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
