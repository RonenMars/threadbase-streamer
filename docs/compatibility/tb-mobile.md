# tb-mobile wire surface

A map of the wire surface `tb-mobile` touches. It is a **reference, not a gate** — see "Backward compatibility with tb-mobile" in [CLAUDE.md](../../CLAUDE.md) for how the check is run and what it decides. Nothing here blocks a change: it tells you what to *report*.

`tb-mobile` is a released iOS/Android app that cannot be force-updated, so a user on an old build meets whatever the server does today. The client absorbs that rather than the server holding still — it narrows unknown values, renders without a missing optional field, and hides a feature its server can't answer for. That half is written down in tb-mobile's `CLAUDE.md` under "Server contract — degrade, don't break". A change here proceeds; the cost is a degraded screen, not a crash.

This file is hand-maintained and drifts between updates. The client checkout is authoritative — `rg` it for the identifier you are changing (the command is in CLAUDE.md) and use this list for orientation.

## What tb-mobile touches

**REST endpoint paths** — mobile hard-codes every path:

- `/healthz`, `/api/info`, `/api/pair/exchange`
- `/api/sessions`, `/api/sessions/count`, `/api/sessions/{id}`
- `/api/sessions/resume`, `/api/sessions/start`
- `/api/sessions/{id}/input`, `/api/sessions/{id}/cancel`
- `/api/sessions/{id}/output`, `/api/sessions/{id}/files`
- `/api/conversations`, `/api/conversations/count`, `/api/conversations/{id}`
- `/api/search`, `/api/browse`, `/api/browse/mkdir`

**New endpoint** — purely additive; older mobile builds simply don't call it:

- `GET /project-chats` — unified active-sessions + historical-conversations list. Accepts `?refreshConversations=1` (or legacy `?refresh=1`) to force a rescan; otherwise the server short-circuits via `cache_metadata.last_conversation_id`. Response shape is `{ projectChats: ProjectChat[] }` where `ProjectChat` is a discriminated union on `type: "session" | "conversation"`. Both variants carry `projectId` (the canonical project identity) and `projectPath` (compatibility metadata).
- `GET /api/cache/alert` and `POST /api/cache/alert/resolve` — cache-integrity drift alert (purely additive; older mobile builds never call them and 404 on servers that predate the feature — new mobile must catch that 404 and hide the feature). `GET` returns `{ pending: PendingAlert | null }` (the full record, including the missing-conversation list, for building a `prune_selected` picker). `POST /resolve` body is `{ fingerprint: string, action: "prune_all" | "prune_selected" | "ignore" | "reset_rescan", ids?: string[] }` (`ids` required and non-empty only for `prune_selected`); responses are `200 { ok: true, action, pruned?, backupPath? }`, `200 { ok: true, alreadyResolved: true }` when no alert is pending, `409 { error: "fingerprint_mismatch", currentFingerprint }` when the pending set changed under the client, and `400` on an invalid body. Both live under `/api/`, so they require `Authorization: Bearer <token>` like every other API route.
- `PATCH /api/sessions/{id}/model` and `PATCH /api/sessions/{id}/effort` — switch the model / reasoning-effort of a session that is already running (purely additive; older mobile builds never call them, and they 404 on servers that predate the feature, so new mobile must treat a 404 as "hide the control"). Bodies are `{ "model": "opus" }` and `{ "effort": "low" | "medium" | "high" | "xhigh" | "max" }`. Success is `202 { id, model }` / `202 { id, effort }` — **not 200**, because the value is applied by Claude's TUI on its next render and there is nothing truthful to echo back synchronously; confirm by re-fetching `GET /api/sessions/{id}`, whose `model`/`effort` fields are scraped from the live status line. Errors: `409 { code: "SESSION_BUSY" }` mid-turn (retry once the session is back to `waiting_input`), `409 { code: "SESSION_IDLE" }` when there is no live PTY (resume first), `501 { code: "UNSUPPORTED_PROVIDER" }` for a Codex session, `400` for a value outside the accepted set, `404` for an unknown session.
- `POST /api/sessions/{id}/fork` — start an independent Codex continuation of a conversation another client owns, without touching that owner (`codex fork`). Purely additive; 404s on servers that predate it, and `501 { code: "UNSUPPORTED_PROVIDER" }` for a Claude conversation — it never silently falls back to resume. `POST /api/sessions/resume` also gained additive fields on its `409` (`reasonCode`, `provider`, `canForce`, `canTakeOver`, `canFork`, `ownerPid`, `ownerSource`) and a new `detectedBy` value, `"file_handle"`; `code` is still `CONVERSATION_BUSY`. A Codex resume that Codex itself refuses now answers that `409` instead of `201`-then-idle, and one that fails to start otherwise answers `502 { code: "SESSION_START_FAILED" }`. Full contract, including what mobile must and must not offer: [codex-collision-and-fork.md](codex-collision-and-fork.md).
- Changing the server-wide **default** model/effort needs no new endpoint: `model` and `effort` are entries in the `claudeFlags` registry, so they arrive through the existing `GET`/`PUT /api/config/claude-flags`. Mobile's server-settings form renders them from the returned `registry` with no app change; only the i18n labels under `servers:claudeFlags.flags.*` are missing, and their absence just falls back to showing the raw `--model` / `--effort` CLI spelling.
- `GET /api/projects/summary?limit=&offset=` — every project with at least one cached conversation, for the Hub's grouped (lazy, expand-to-load) views. Response `{ projects: [{ path, name, conversationCount, lastActivity }], total, offset, hasMore }`, ordered by last activity descending (ties by `path` ascending), default `limit=200`. `path` is the raw `project_path` the cache stores, so it is joinable verbatim against `GET /api/conversations?project=<path>` — the aggregate is `COUNT(*)`/`MAX(last_activity)` over the same `conversation_meta` rows that endpoint pages, which is what keeps a group from claiming 12 conversations and rendering 9. All providers and scan profiles are included; there is no `provider` filter. Warm-up behaves like the other list endpoints (`503 SERVER_WARMING_UP`); `503 { code: "CACHE_UNAVAILABLE" }` when the SQLite cache failed to open (deliberately not an empty 200, which would render an empty tree over conversations the scanner fallback still serves). Purely additive: `GET /api/info` carries `projectSummary: true` so a client can detect support without probing for a 404.
- `QUERY /api/conversations/{id}/search-target` — resolves an active search query to the message a client should scroll to. Uses the HTTP QUERY method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)): safe, idempotent, and cacheable like GET, but the query travels as a JSON request body (`{ "q": "<query>" }`, `Content-Type: application/json`) instead of a URL param — this is the only endpoint in the API that uses QUERY; everything else stays GET/POST. `200` body: `{ query, message_index, uuid, snippet, match_indexes, total_matches }` (`message_index` is the same absolute index the detail endpoint emits — the last chronological match; `uuid` may be null; `match_indexes` lists all matching indexes ascending, capped at the last 1000; `total_matches` is the uncapped count for the client's "N of M" counter). The response carries `Accept-Query: application/json` per the spec. `404` with `code: "search_target_not_found"` when no message body contains the query (metadata-only search hit); `404` with `code: "not_found"` for an unknown conversation; `415` with `code: "unsupported_media_type"` for a non-JSON `Content-Type`; `422` with `code: "invalid_query"` for an empty/whitespace or >256-char `q`, or a malformed JSON body. Mobile treats any 404 as "open the tail view, no highlight". `CORS`: `Access-Control-Allow-Methods` includes `QUERY`; a cross-origin browser caller triggers an `OPTIONS` preflight, same as any other non-simple method — mobile requests carry no `Origin` header and are unaffected.

**Query parameter names** — mobile builds URLs with these exact strings:
`limit`, `offset`, `sort`, `project`, `refresh`, `msg_limit`, `before_index`, `anchor_index`, `after_index`, `q`, `path`

(`q` is still a URL query param on `GET /api/search`, unchanged. It moved to a QUERY-method JSON body field of the same name only for `search-target` — see above.)

- `anchor_index` on `GET /api/conversations/{id}` — returns a bounded window centered on that absolute message index (clamped into range, never an error). `after_index` returns the newer-direction window `[after_index, after_index + msg_limit)`. Precedence when combined: `before_index` > `after_index` > `anchor_index`. Anchored/after responses never answer `304` to `If-None-Match` — only the plain tail page participates in the ETag freshness check.

**Response field names** — these are deserialized by name in mobile types; casing matters:

- Session: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `source`, `startedAt`, `completedAt`, `lastActivityAt`, `failureReason`, `ptyAttached`
- Session — new optional fields (added during the projects refactor; never required for older clients): `projectId`, `resumedFromConversationId`
- Session — new optional field (Codex live-session support): `provider` (`"claude-code"` | `"codex-cli"`; absent/undefined means `claude-code` for older data). `conversationId` always equals `id` for the lifetime of a live session, regardless of provider — it is never rekeyed once a client has navigated to it.
- Session — new optional field (Codex live-session support): `boundConversationId`. Set once a *fresh* live session's underlying persisted conversation file is discovered after the fact (currently: Codex, whose CLI assigns its own session id that isn't known until it creates its own rollout JSONL). Distinct from both `conversationId` (always `=== id`, the stable mobile deep-link alias) and `resumedFromConversationId` (set only on the resume flow) — older clients that don't know this field can safely ignore it.
- Session — **behaviour note (session rehydration):** after a streamer restart, sessions a previous run was interrupted mid-flight now come back in `GET /api/sessions` instead of disappearing from it.
They reuse the *existing* vocabulary rather than introducing anything: `status: "idle"`, `ownership: "historical"`, `lifecycle: "resumable"`, `lifecycleSource: "reconcile"`, `ptyAttached: false`, and — when the streamer's own shutdown ended them — `statusSource: "shutdown"`.
No field is added, renamed or retyped, and no new `SessionStatus` value exists, so a client that only reads `status` and `ptyAttached` behaves exactly as it does for any other idle session; tapping one hits the unchanged `POST /api/sessions/resume`.
`GET /api/sessions/count` deliberately excludes them, so the live-session badge keeps counting only sessions this streamer is running.
The one client-side consequence worth knowing: a recovered session carries a real `promptCount`, which mobile's `isTerminalSession` currently requires to be `0` — until mobile treats `ownership === 'historical'` as terminal, it will wait on the WebSocket for output that only arrives after a resume.
The server side is gated by the `sessionRehydration` feature flag (default on; yaml/CLI id `sessionRehydration`, or `THREADBASE_FEATURE_SESSION_REHYDRATION=0` to disable).
- Session — **behaviour note (pty-host reconnect):** with `ptyHost` enabled, a session whose PTY survived a streamer restart retains the same `id`, `conversationId`, provider, and existing status, and is reported as `ownership: "managed"`, `ptyAttached: true`, `lifecycle: "attached"`, and `lifecycleSource: "reconcile"`.
The unchanged `terminal_replay` event is sourced from the host's preserved terminal screen, and a host-owned id replaces rather than accompanies any historical rehydration stub.
Host supervision adds version checks, heartbeats, and shutdown control only to the private streamer-to-host protocol; the mobile HTTP and WebSocket contracts are unchanged.
The flag defaults off (`--feature ptyHost=true` or `THREADBASE_FEATURE_PTY_HOST=1` enables it), no endpoint, response field, status, or event name changes, and a machine reboot still follows the existing registry-rehydration path because the host is gone too.
- Session — new optional field (plan Phase 5): `interruptedStatus` (`"running"` | `"waiting_input"`). Present only on a rehydrated session whose registry row recorded `status_source: "shutdown"` — i.e. one the streamer itself stopped, as opposed to one the agent finished or a crash froze.
A recovered session's `status` has to report `idle` (it holds no PTY, and a novel `SessionStatus` value would be dropped by `?status=` filtering on already-shipped clients), which erases whether the agent was mid-answer when we stopped it.
This field carries that one bit separately, so a client can say "interrupted mid-response" instead of "idle".
Purely additive and safe to ignore: nothing keys off it server-side, and a client that never reads it behaves exactly as it does today.
Adopting it is tracked as tb-mobile PR M2.
- Session — new field `subStatus`: the agent's phase *within* a running turn (`"thinking" | "streaming" | "hooks" | "acting" | "working"`), scraped from the rendered PTY screen.
**Unlike every other addition on this list it is NOT optional — it is always serialised, and is `null` when there is no phase.**
That is deliberate and must not be "tidied" into the `...(x != null && { x })` block that the neighbouring optional fields use: `!=` catches `null` as well as `undefined`, so an explicit clear would become an absent key.
Mobile merges session frames (`{...prev, ...next}`), and a merge cannot express a removed key, so an absent field keeps its previous value and the indicator latches on a finished turn — the failure tb-mobile PR #647 shipped.
A client that ignores the field behaves exactly as today; a client that renders it must treat an unrecognised value as "no phase" rather than coercing it, because the union will grow.
It deliberately does **not** add a `SessionStatus` value: `VALID_STATUSES` rejects unknown values and `?status=` filtering would make those sessions vanish from already-shipped apps.
- WebSocket — new event `session_phase`: `{ type, sessionId, phase: AgentPhase | null, updatedAt }`, scoped to that session's subscribers rather than broadcast globally.
Purely additive; a client that never handles it behaves as today, and `subStatus` on the session object stays the source of truth for the GET path and for reconnect.
It is a minimal frame rather than a `SessionResponse` copy on purpose: `managedToResponse` recomputes `elapsedMs` from `new Date()` on every call for a live session, so a session-copy frame would differ on every tick whether or not the phase changed, and a merging client would get a fresh object identity several times a second for the whole turn.
`phase` follows the same always-present/nullable contract as the field.
- **pty-host protocol version 3** (private streamer-to-host protocol; no mobile-visible change): adds the `phase-change` event. The detectors run in the host, so without it the indicator silently no-ops when `THREADBASE_FEATURE_PTY_HOST=1`.
- Session — new value on the existing optional `lifecycle` field: `"starting"`, for a managed session this run holds no PTY for and has observed no exit for (no `completedAt`, no `failureReason`).
It replaces the `"completed"` those sessions used to report, which made "has not attached yet" and "has ended" the same value on the wire — the ambiguity tb-mobile #508 needs resolved.
`status`, `ptyAttached` and every other field are unchanged, and `lifecycle` was already optional, so a client that does not know the value behaves exactly as it does today; adopting it is tracked in tb-mobile #508.
- Session — optional field `sessionName`: a user-visible title. Previously only populated on a resumed session (from the scanner's own title derivation); now also derived for a fresh live session from its first user message (`deriveSessionName`, first line truncated to 80 chars) as soon as that message is submitted. Absent until then.
- Conversation list item: `id`, `title`, `projectPath`, `messageCount`, `lastActivity`, `firstMessage`, `lastMessage`, `preview`, `model`
- Conversation detail: `meta` object + `messages` array + `message_pagination` object
- Conversation detail `meta` — new optional fields (additive; older clients ignore them): `provider` (`"claude-code"` | `"codex-cli"`; absent means `claude-code`), `resumable` (boolean — false when the conversation's project dir no longer exists, so resume would fail; history is still served), `unavailable_reason` (`"path_missing"` | `"worktree_removed"`, present only when `resumable` is false). The same fields are also added to the resumable session shape (`status: "on_hold"`) returned by `GET /api/sessions/{id}` for conversation ids. **Behavior note (Codex resume support):** `resumable` for a `codex-cli` conversation previously was always forced to `false`; it now reflects the same on-disk project-path availability check as `claude-code` conversations, since Codex resume (`POST /api/sessions/resume`) is implemented and functional.
- Message: `message_index` (snake_case), `role`, `timestamp`, `text`, `content` (array), `tool_use_id` (snake_case)
- Pagination: `hasMore`, `offset`, `total`
- `message_pagination` — new optional fields (additive, emitted only on anchored/after windows): `anchor_index` (the clamped anchor the window was centered on), `has_more_newer`, `next_after_index` (cursor for the next `after_index` request, or null at the tail). The pre-existing fields `total`, `before_index`, `from_index`, `has_more_older`, `next_before_index` are unchanged.
- Search target (`/api/conversations/{id}/search-target`): `query`, `message_index`, `uuid`, `snippet`, `match_indexes`, `total_matches`, and the error `code` values `search_target_not_found` / `not_found` / `invalid_query` — mobile keys its fallback on the 404 status.

**Session status values** — mobile switches on these exact strings; a value it doesn't know narrows to `idle` on the client:
`running`, `waiting_input`, `completed`, `failed`, `on_hold`, `idle`
Note: mobile treats `on_hold` and `idle` as the same status. The server currently emits `running`/`waiting_input`/`idle` for live sessions (`SessionStatus` in `src/types.ts`) and `on_hold` for resumable conversation shapes; `completed`/`failed` are legacy values older streamer versions emitted — mobile still parses them, so don't reuse them with new semantics.

**WebSocket event types** — mobile registers listeners keyed on these strings:

- Server → client: `session_list`, `session_update`, `terminal_output`, `conversation_event`, `ping`
- Client → server: `{ type: "hold_session", sessionId }` (additive optional `when`: omitted / `"grace"` arms today's `ptyGracePeriodMs` timer — this is what released apps send on backgrounding; `"waiting_input"` holds at the next `running → waiting_input`, or immediately if already settled; any other value is ignored). In-app “Kill on idle” must send `when: "waiting_input"` **then** navigate (unsubscribe). Do not unsubscribe first.

`conversation_events` (`{ type, sessionId, lines: string[] }`) is an **additive** server→client event that batches all lines from one watcher read into a single message. The server still emits per-line `conversation_event` alongside it, so older clients that only know `conversation_event` are unaffected. Never stop emitting `conversation_event`.

`cache_alert` and `cache_alert_resolved` are **additive** server→client, server-level events (no `sessionId`) for the cache-integrity drift alert — old clients ignore unknown types. `cache_alert` is `{ type, fingerprint, severity: "high" | "low", missingCount, totalRows, detectedAt, sample: { id, title? }[] }` (`sample` is the first 20 missing conversations; the full list comes from `GET /api/cache/alert`); it is broadcast on raise/severity-change and also unicast to a client the moment it opens its WebSocket connection whenever an alert is pending, so a client never misses one raised while it wasn't listening. `cache_alert_resolved` is `{ type, fingerprint, action }`.

**HTTP status codes** — mobile maps these to typed errors:

- `401` → `AuthError` (triggers re-auth UI)
- `404` → `NotFoundError` (suppressed for `/output` endpoint — treated as empty). The `GET /api/conversations/{id}` 404 body now carries an additive `code: "not_found"` alongside `error`; older clients ignore it. `GET /api/browse` now answers `404` with `code: "PATH_NOT_FOUND"` when the requested `path` is inside the browse root but no longer exists on disk (e.g. a mobile-cached path whose folder was moved/deleted) — previously this case returned `400`. Out-of-root paths still return `400`. Older clients that only read the `error` string are unaffected; clients keying on the status can fall back to the nearest existing ancestor instead of dead-ending on "Unable to load directories".
- `429` → shown to user during pair exchange

**Auth format** — mobile sends `Authorization: Bearer <token>` and constructs WebSocket URLs as `/ws?key=<token>`. Both forms must continue to work.

**API key format** — mobile uses `tb_` prefix detection in pairing logic. Key format `tb_<32-hex-chars>` must be preserved.

**Push endpoints** — `POST /api/push/register` and `GET /api/push/health` both have shipped mobile consumers and belong to this contract.

`available` on `/api/push/health` means "the SQLite token store opened", **not** "credentials are present". Mobile renders it verbatim as "Push store is available / unavailable (registration cannot persist)" (`app/notification-health.tsx`), so retargeting it at credentials would tell every credential-less server's user that their registrations do not persist — false, and it points debugging at the database instead of the missing `.p8`. `parsePushHealthResponse` only type-checks it as a boolean, so the wrong sentence would render with no parse error.

`GET /api/info` and `GET /api/push/health` carry an additive `push` object describing what the server can actually deliver: `{ liveActivity: boolean, notifications: boolean, liveActivityReason?: string }`. `liveActivity` is true only when APNs credentials resolved *and* the sender was wired — the same fact the boot log reports as `live_activity.enabled`. `notifications` is currently always false: `expo-server-sdk` is not a dependency and `PushRepository.listDeliverable()` has no caller, so ordinary push has no server-side implementation either. `liveActivityReason` is present only when `liveActivity` is false and names the missing environment variable, never its value. The object is absent on servers that predate it, which a client must read as "unknown" rather than "unavailable". Mobile should hide or disable the Live Activity affordance when `push.liveActivity` is false rather than registering tokens nothing will ever send to.

## Changes that need no check

Mobile ignores what it doesn't know, so these cost nothing:

- Adding optional fields to any response object
- Adding new endpoints
- Adding new optional query parameters with sensible defaults
- Adding new WebSocket event types
- Adding new session status values

## Changes worth a grep and a report

These are the ones an older build can notice. Grep the client, say what you found — file, line, and whether the call site is in a shipped build — and carry on:

- Renaming any field (including camelCase ↔ snake_case)
- Removing any field from a response
- Changing a field's type (e.g., `number` → `string`)
- Renaming or removing an endpoint
- Changing query parameter semantics (not just adding new ones)
- Changing WebSocket event type strings
- Changing pagination cursor behavior in `/api/conversations/{id}`
- Changing the NaCl box format or key exchange protocol in `/api/pair/exchange`

## What a grep cannot answer

These hold regardless of what the client source says today, because they are how a build reaches the server at all:

- Auth: `Authorization: Bearer <token>` and `/ws?key=<token>` are both live paths.
- The `tb_<32-hex-chars>` key format is load-bearing in pairing.
- The status vocabulary above — `completed` / `failed` are legacy values older streamers emitted and mobile still parses, so don't reuse them with new semantics.
- **`publicUrl` on the `/api/pair/exchange` response advertises, it does not dictate.** It is what this server believes its public address to be; the address the client talks to is the one its user typed or scanned. The server must not assume a client adopts it, and nothing may be built on the assumption that it does.

  This was not always true, and the history is the reason the rule is written here rather than left implicit. Mobile used to resolve the server address as `body.publicUrl ?? typedUrl`, so the field silently replaced whatever the user entered — pairing against a LAN address moved the app to the tunnel with no signal. That was TB-S-13 in [../security/2026-08-14-streamer-review.md](../security/2026-08-14-streamer-review.md): the response is unauthenticated before E2EE (nothing authenticates the streamer — see TB-S-12), so one reply could relocate a device permanently. Fixed client-side in [threadbase-mobile#720](https://github.com/RonenMars/threadbase-mobile/issues/720); the field is still sent and is now recorded rather than applied.

  Two consequences for anything added here later. A released build that predates that fix **does** still adopt `publicUrl`, so changing the value changes where old devices talk — it is not a free field to repoint. And a device paired to a LAN address stays on it, which is deliberate; whether a client should ever fall back to `publicUrl` is [threadbase-mobile#722](https://github.com/RonenMars/threadbase-mobile/issues/722), not an assumption this server may make.
