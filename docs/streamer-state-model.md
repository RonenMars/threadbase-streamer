# Streamer state model — server, session and agent state

This document reorganizes the Threadbase mobile doc *"Threadbase Mobile — Server, Session & Agent State Model"* (dated 2026-09-24) around the streamer: what it sends, what it stores, what it decides and what it guarantees.
It is a rearrangement only.
Every fact and rule from the original is kept with its original meaning; nothing is added or removed.
Facts that concern only the mobile app are kept under [Client-side context](#5-client-side-context).
Whether each fact matches the streamer code is checked separately in [streamer-state-model-audit.md](streamer-state-model-audit.md).

Each fact has an ID (`F-nnn`) and a source tag naming the section of the original document it came from.

| Source tag | Original section |
| --- | --- |
| `Summary` | Summary |
| `L1` | Layer 1 — Connection and server health (intro and state diagram) |
| `L1/Reconnect` | Layer 1 → Reconnect and liveness mechanics |
| `L1/Server` | Layer 1 → Server-level state |
| `L1/E2EE` | Layer 1 → Encryption verdicts |
| `L2` | Layer 2 — Session fields on the wire (intro) |
| `L2/Axes` | Layer 2 → The two axes |
| `L2/Detail` | Layer 2 → Detail fields |
| `L2/External` | Layer 2 → Fields for sessions the app didn't start |
| `L2/Merge` | Layer 2 → How updates arrive and merge |
| `L3` | Layer 3 — Presentation: one verdict per session (intro) |
| `L3/Order` | Layer 3 → Classification order (table and "Why the order matters") |
| `L3/Verdict` | Layer 3 → What the verdict contains |
| `L4` | Layer 4 — The live turn in chat (intro) |
| `L4/Thinking` | Layer 4 → `isAgentThinking` |
| `L4/Bubble` | Layer 4 → Thinking bubble state machine |
| `L4/Shows` | Layer 4 → What the bubble shows |
| `L4/Questions` | Layer 4 → Questions and permissions |
| `L4/StatusBar` | Layer 4 → The session status bar |
| `L5` | Layer 5 — The terminal stream (intro, sequence diagram and mechanism table) |
| `L5/Quiet` | Layer 5 → Quiet terminal periods |
| `N/Which` | Nuances and pitfalls → Which signal answers which question |
| `N/Independent` | Nuances and pitfalls → Signals that are independent |
| `N/Live` | Nuances and pitfalls → Two definitions of "live" |
| `N/Inconsistencies` | Nuances and pitfalls → Inconsistencies found while writing this |
| `SourceMap` | Source map |

---

## 1. What the streamer sends

### 1.1 WebSocket keepalive and connection

- **F-101** The streamer sends `{type:'ping'}` every 30 s. `L1/Reconnect`, `L5`
- **F-102** Protocol-level pings never reach JS, so the app needs an app-level frame (the reason the `{type:'ping'}` frame exists). `L1/Reconnect`
  > **Streamer (verified 2026-09-25):** The streamer also sends a protocol-level ping to every socket on each sweep and terminates a socket that does not pong within 10 s (`src/ws-hub.ts`, `client.ping();` and `const PONG_TIMEOUT_MS = 10_000;`).
  > Whether those pings reach JS is React Native behavior, recorded only in a comment there; the app-level `{type:'ping'}` (F-101) is the frame a JS client can see.
- **F-103** Reconnect re-authenticates but never replays: a frame sent while the app is backgrounded is gone for good. Frames sent while backgrounded are lost; reconnect never replays them. `L2/Merge`, `L1/Reconnect`
  > **Streamer (verified 2026-09-25):** Missed events are never replayed, but current state is rebuilt on every connect.
  > Each new socket receives `session_list` at once (`src/server-wiring.ts`, `deps.wsHub.unicast(ws, { type: "session_list", sessions });`), then `cache_ready` (unless the server is warming up) and any pending cache-integrity or host-pressure alert.
  > Each `subscribe_session` then gets the subscribe sequence in F-111.
- **F-104** A new socket starts with no subscriptions; `subscribe_session` must be re-sent for each held session. `L1/Reconnect`
- **F-105** On an E2EE server, the socket counts as connected on socket open plus the first frame unsealed. `L1`

### 1.2 Subscribe flow and terminal stream frames

- **F-111** Sequence on subscribe: the app sends `subscribe_session`; the streamer answers with `prompt_snapshot` (if prompt contract), then `terminal_replay` (screen so far, `seq`); then, while live, a loop of `terminal_output` (`data`, `seq`). `L5`
  > **Streamer (verified 2026-09-25):** `prompt_snapshot` is not gated on a capability: every `subscribe_session` gets one (`src/server-wiring.ts`, the `subscribe_session` case, `deps.wsHub.unicast(ws, deps.promptRegistry.snapshot(msg.sessionId));`).
  > `terminal_replay` is sent only when a live PTY exists (`if (deps.ptyManager.hasSession(msg.sessionId))`), and only after `await deps.ptyManager.getOutputLines(…)`, so live `terminal_output` can arrive before it.
  > Any pending legacy `permission` or `question` frame is sent after the replay.
- **F-112** The terminal stream is raw PTY bytes over the socket. `Summary`
  > **Streamer (verified 2026-09-25):** Only `terminal_output.data` is raw PTY bytes (`src/server-wiring.ts`, `type: "terminal_output", sessionId, data, seq`).
  > `terminal_replay` carries rendered screen lines from a headless terminal (`lines`, `userMessages`, `seq`, `cols`, `rows`; up to `REPLAY_MAX_LINES`), not bytes. `GET /api/sessions/:id/output` is the raw ring buffer.
- **F-113** Replay happens on subscribe; it fills the screen and sets the `seq` baseline. `L5`
  > **Streamer (verified 2026-09-25):** `terminal_replay.seq` is the last `terminal_output` seq sent for the session, and absent before the first chunk (`seq: deps.terminalSeq.get(msg.sessionId)`).
  > The counter is in memory only: the idle reaper deletes it (`src/server.ts`, `this.terminalSeq.delete(session.id);`) and `close()` clears it, so `seq` restarts after an idle reap or a streamer restart.
- **F-114** `GET /api/sessions/:id/output` serves the terminal output (`/output`) used as the HTTP fallback. `L5`
- **F-115** Streamers without `seq` are never rejected (by the app's seq dedup). `L5`

### 1.3 Session fields — the two axes

A `Session` carries two independent axes, plus detail fields. `status` says whose turn it is. `lifecycle` says whether a process exists. Newer, optional fields refine both. `L2`

- **F-121** The source of truth for session wire fields is the server, via `session_update` frames and REST; the main signals are `status`, `lifecycle`, `subStatus`, `ptyAttached`, `ownership`. `Summary`
  > **Streamer (verified 2026-09-25):** Session fields also arrive on two per-session frames, `session_phase` and `prompt_suggestion`, which carry `subStatus` and `promptSuggestion` (see F-134).
  > The `orphaned` lifecycle overlay (`withReconciledLifecycle` in `src/server.ts`) is applied to the REST list, `GET /api/sessions/:id` and `session_list`, not to `session_update`.
- **F-122** `status` is the turn axis. `running` means the agent holds the turn, `waiting_input` means the user does, and `idle` means nobody is mid-turn. `Summary`
  > **Streamer (verified 2026-09-25):** For a managed PTY session `idle` means no live PTY: it is set only on exit or hold (`src/pty-manager.ts`, `handleExit` and `putOnHold` both set `session.status = "idle"` and stamp `completedAt`).
  > Between turns a live session is `waiting_input`, not `idle`.
  > External sessions report `idle` + `lifecycle: detached` because the streamer cannot see their prompt state (`src/session-store.ts`, `discoveredToResponse`, `status: "idle",`).
- **F-123** `status` values: `running`, `waiting_input`, `idle` (typed). The server also sends `on_hold`, `completed` and `failed`. `L2/Axes`
  > **Streamer (verified 2026-09-25):** The streamer sends `running`, `waiting_input` and `idle` (`src/types.ts`, `export type SessionStatus = "running" | "waiting_input" | "idle";`).
  > `on_hold` comes only from the `GET /api/sessions/:id` fallback for a cached conversation (`src/api/handlers/http-helpers.ts`, `status: "on_hold" as const,`).
  > `/recents` items use `idle` (`src/api/handlers/conversations.handlers.ts`, `status: "idle" as const,`).
  > The 202 start and fork bodies carry `status: "pending"` (`src/api/handlers/sessions.handlers.ts`, `json(res, 202, { id: session.id, status: "pending" });`).
  > `completed` and `failed` are lifecycle values; as `status` they are legacy values from older streamers, and nothing in `src/` emits them as a status.
- **F-124** `lifecycle` is the process axis. It says whether an agent process exists, and is independent of `status`. `Summary`
- **F-125** `lifecycle` values: `attached`, `starting`, `detached`, `orphaned`, `resumable`, `completed`, `failed`. It is optional (older servers omit it). `L2/Axes`
  > **Streamer (verified 2026-09-25):** All seven values are produced (`src/session-store.ts`, `managedToResponse` and `lifecycle: "detached"` in `discoveredToResponse`; `src/services/sessions/reconcileSessions.ts`, `lifecycle: "orphaned",`).
  > `lifecycle` is always present on managed, external and `on_hold` objects, and absent on `/recents` items.
  > `orphaned` appears only through the REST and `session_list` overlay (F-121), never on `session_update`.
- **F-126** The axes are orthogonal on purpose. A session can be `lifecycle: attached` + `status: idle` (the process is up and nobody is mid-turn). A process can be `attached` while `status` is `idle`. `L2/Axes`, `N/Independent`
  > **Streamer (verified 2026-09-25):** `attached` + `idle` is not a steady state: between turns a live PTY is `waiting_input`, and `idle` is set only on exit or hold (F-122).
  > External sessions are `idle` + `detached` (`src/session-store.ts`, `discoveredToResponse`).
  > Before this change the only `attached` + `idle` a client saw was the exit-time `session_update`, because every runner reported the exit before forgetting the session (`src/pty-manager.ts`, `this.onStatusChange?.(toPublicSession(session)); session.screen.dispose(); this.sessions.delete(sessionId);`). After G2 (T5) it does not appear at all.
- **F-127** A session can be `lifecycle: resumable` while its last `status` was `running`: the streamer shut it down mid-turn and it can be picked up again. `L2/Axes`
  > **Streamer (verified 2026-09-25):** The wire never pairs `running` with `resumable`.
  > A stub restored after a clean shutdown is `status: "idle"`, `ownership: "historical"`, `lifecycle: "resumable"`, and carries its pre-shutdown status in `interruptedStatus` (`src/services/sessions/rehydrateSessions.ts`, `status: "idle",` and `interruptedStatus: row.status,`).
  > A held session is `idle` + `resumable`.
- **F-128** A session being spawned has no PTY yet, so its `status` is still `idle` (while `lifecycle` is `starting`). `L3/Order`
  > **Streamer (verified 2026-09-25):** Spawn sets `status: "running", statusSource: "spawn"` (`src/pty-manager.ts`, the spawn and resume session objects), so a spawning session is `running` from its first frame.
  > `lifecycle: "starting"` is a fallback for a session with no PTY, no `completedAt` and no `failureReason` (`src/session-store.ts`, `managedToResponse`). Every path to `idle` stamps `completedAt`, so in practice `starting` goes with `running`.

### 1.4 Session fields — detail fields

- **F-131** `subStatus` values: `thinking`, `streaming`, `hooks`, `acting`, `working`, `null`. Meaning: what the agent is doing inside a running turn. `L2/Detail`
- **F-132** The streamer sends only `working` for `subStatus`, only for Codex. It is always `null` for Claude. `L2/Detail`; "Claude never sends one" `L4/Shows`; "(Codex only today)" `N/Which`
- **F-133** `subStatus` explicit `null` = cleared; absent key = server too old. `L2/Detail`
- **F-134** `subStatus` is always sent, as `null` when there's no phase. `L2/Merge`
  > **Streamer (verified 2026-09-25):** The key is always present on session objects, but a phase change is not sent as `session_update`.
  > It goes out as `{ type: "session_phase", sessionId, phase, updatedAt }`, and a suggestion change as `{ type: "prompt_suggestion", sessionId, text, updatedAt }`, both only to that session's subscribers (`src/server-wiring.ts`, `onPhaseChange` / `onPromptSuggestionChange`).
  > A `session_update` carries the latest store value only when something else triggers one.
  > tb-mobile has no `session_phase` handler, so live Codex phase labels do not reach it (mobile gap M1).
- **F-135** `ptyAttached`: boolean — the streamer has a terminal attached. An older proxy for liveness, superseded by `lifecycle`. `L2/Detail`
  > **Streamer (verified 2026-09-25):** True while the runner holds a PTY (`src/server.ts`, `ptyAttachedIds()`).
  > Fixed in the change that added this doc (G2): the exit-time `session_update` used to say `ptyAttached: true`, `lifecycle: "attached"` because every runner reports the exit before deleting the session.
  > The status-change handler now drops the session from the attached set when the reported status is `idle` (`src/server-wiring.ts`, `if (session.status === "idle") attached.delete(session.id);`), so the exit frame says `ptyAttached: false` with `lifecycle` `completed`, `failed` (a `failureReason` is set) or `resumable` (a hold).
- **F-136** `statusUpdatedAt`: ISO time — when `status` last changed. During `waiting_input`, when the wait began. Optional. `L2/Detail`
  > **Streamer (verified 2026-09-25):** Fixed in the change that added this doc (G1).
  > The runners stamped `statusUpdatedAt` on every transition, but the status-change mirror into `SessionStore` did not copy it, so REST, `session_list` and `session_update` sent the spawn time for the whole life of a session.
  > The mirror now copies it (`src/server-wiring.ts`, `...(session.statusUpdatedAt != null && { statusUpdatedAt: session.statusUpdatedAt })`), so it is the time of the last status change.
- **F-137** `lifecycleSource` / `lifecycleUpdatedAt`: `spawn`, `exit`, `probe`, `reconcile` / time — how and when `lifecycle` was set. Optional. `L2/Detail`
  > **Streamer (verified 2026-09-25):** The four `lifecycleSource` values are right (`src/session-store.ts`; `lifecycleSource: "probe"` for external sessions; `"reconcile"` for the overlay and the `on_hold` fallback).
  > `lifecycleUpdatedAt` is declared (`src/types.ts`, `lifecycleUpdatedAt?: string; // ISO 8601`) and never assigned anywhere in `src/`, so it is never sent.
  > A held session shows `resumable` with `lifecycleSource: "exit"`.
- **F-138** `completedAt`: ISO time — end **or hold** was recorded. Stamped on both, so it can't distinguish "ended" from "on hold". `L2/Detail`; also "`completedAt` is stamped on both a real exit and a hold" `L3/Order`; "`completedAt` (stamped on both)" `N/Which`
- **F-139** `failureReason`: string — why it failed. Presence alone turns a completion into "failed". `L2/Detail`
  > **Streamer (verified 2026-09-25):** `lifecycle` is `failed` only when no PTY is attached and the session is neither held nor restored (`src/session-store.ts`, `managedToResponse`, where `resumable` is checked before `s.failureReason != null ? "failed"`).
  > Codex also sets `failureReason` on a live session for a usage or rate limit screen (`src/codex-pty-runner.ts`, `handleBlockingPrompt`).
  > Since this change (G3) it clears that reason when the limit screen leaves, and the status-change mirror accepts the clear while the session is live, so a session that recovers and later exits cleanly reads `completed`.
  > A session that exits with the limit screen still up reads `failed`, and a failure recorded at exit is never blanked by a later transition.
- **F-140** `promptSuggestion`: string or null — Claude's ghost next prompt. `L2/Detail`
  > **Streamer (verified 2026-09-25):** Live changes travel on their own `prompt_suggestion` frame to the session's subscribers, not as `session_update` (see F-134).
- **F-141** `elapsedMs`, `promptCount`: numbers. `L2/Detail`
  > **Streamer (verified 2026-09-25):** Managed: `elapsedMs = (completedAt ?? now) − startedAt` and `promptCount` rises once per text send (`src/session-store.ts`, `managedToResponse`).
  > The historical `on_hold` and `/recents` shapes put the conversation's message count in `promptCount` (`src/api/handlers/http-helpers.ts`, `promptCount: c.messageCount,`).
- **F-142** `resumedFromConversationId`: id or null — the session was started via resume. `L2/Detail`
  > **Streamer (verified 2026-09-25):** Set only by the resume path's best-effort enrichment, and its value equals the session's own id (`src/server.ts`, `resumedFromConversationId: sessionId,`).
  > When absent it is omitted, never `null`. A fork sets `forkedFromConversationId` instead.
- **F-143** `model`, `effort`, `permissionMode`: strings, read from the agent's status line. Descriptive only. `L2/Detail`
  > **Streamer (verified 2026-09-25):** The status-line scrape runs only on `GET /api/sessions/:id` for a live PTY (`src/api/handlers/sessions.handlers.ts`, `const status = parseStatusLine(lines);`).
  > Elsewhere `effort` comes from the spawn options (`src/pty-manager.ts`, `...(options.effort != null && { effort: options.effort })`) and `model` from the conversation cache on resume (`src/server.ts`, `model: cached.model ?? undefined,`).
  > `permissionMode` is never in the list, `session_update` or `session_list`.

### 1.5 Session fields — sessions the app didn't start

The streamer also reports CLIs it discovered but doesn't own, and shapes rebuilt from disk. `L2/External`

- **F-151** `ownership`: `managed`, `external`, `historical` — a streamer-owned PTY, a discovered CLI, or reconstructed from disk. `L2/External`
- **F-152** `processLiveness`: `alive`, `gone`, `unknown` — is the external process still running. `L2/External`
  > **Streamer (verified 2026-09-25):** Only `alive` is ever sent (`src/session-store.ts`, `discoveredToResponse`, `processLiveness: "alive",`); a vanished process simply stops being listed.
  > So mobile's `pid` fallback (F-557) cannot trigger against this streamer.
- **F-153** `activity`: `active_writing` or `quiet`, plus `lastEventAt`, source `jsonl` — inferred from the conversation log growing. Explicitly not authoritative. `L2/External`
- **F-154** `interruptedStatus`: `running`, `waiting_input` — what a stub was doing when the streamer's own shutdown stopped it. Label only. `L2/External`
  > **Streamer (verified 2026-09-25):** Set only on registry rows whose status source is `shutdown`, which a clean `close()` records (`src/server.ts`, `if (!this.ptyManager.isRemote()) this.registryBoot.recordShutdownState();`).
  > A crash never sets it, and pty-host mode skips it.
- **F-155** `pid`: number — present for discovered external processes. `L2/External`
- **F-156** Conversations carry `resumable` and, when `resumable: false`, an `unavailableReason` of `path_missing` or `worktree_removed`. `L3/Verdict`
  > **Streamer (verified 2026-09-25):** The values are complete, but the wire field is snake_case `unavailable_reason` (`src/api/handlers/http-helpers.ts`, `unavailable_reason?: "path_missing" | "worktree_removed";`); mobile maps it to `unavailableReason` itself.

### 1.6 Question, permission and prompt frames

- **F-161** There are two question contracts: the newer prompt contract (`prompt_snapshot` / `prompt_event`, streamer 1.70+) and the older `question` / `permission` frames. `L4/Questions`
  > **Streamer (verified 2026-09-25):** The prompt contract shipped in 1.70.0 (commit `68ed6691`, #700), and `/api/info` advertises `promptContract: { schemaVersion: 1, atomicAnswer: true }` (`src/api/routes/misc.routes.ts`).
  > Every gate and question is still sent on both contracts: `promptRegistry.open(…)` emits `prompt_event`, then the legacy `permission` or `question` frame is broadcast (`src/api/handlers/sessions.handlers.ts`, `handlePermissionChange` and `handleLiveQuestion`).
- **F-162** Prompts have states, of which `open` and `updated` are the actionable ones. `L4/Questions`
- **F-163** The question and the `waiting_input` status arrive as two separate frames, in no guaranteed order. `L4/Questions`
- **F-164** A question arrives on the same `running → waiting_input` edge (that starts the bubble fade). `L4/Bubble`
  > **Streamer (verified 2026-09-25):** A permission gate that paints during a turn does not produce this edge.
  > Claude holds the turn open (`src/pty-manager.ts`, `recheckReadyFromScreen`, `this.turnOpen.set(sessionId, "held");`), so `status` stays `running` and the card (`prompt_event` + `permission`) arrives with no status edge. Codex does the same while an approval, gate or picker card is open. This is deliberate (#962).
  > A question raised at the end of a turn (the agent asks, then stops) still arrives near the `running → waiting_input` edge.
  > A tier read from `status` alone misses a held gate. Since this change (G4) every session object carries `hasOpenPrompt`, `true` while the session holds an `open` or `updated` prompt, and a change is broadcast to all clients as `session_update` (`src/server.ts`, the `PromptRegistry` `emit` callback).
  > Clients should read "is it waiting on me?" as `status === "waiting_input" || hasOpenPrompt === true`.
- **F-165** Answers can come back as "question closed" and "prompt changed" (shown as notices, not errors). `L4/Questions`
  > **Streamer (verified 2026-09-25):** Both come back as HTTP 409 with `ok: false`, not as successes.
  > `POST /api/sessions/:id/prompt/answer` answers 409 with a `code` of `prompt_cancelled`, `already_resolved`, `prompt_expired`, `prompt_unavailable`, or `prompt_revision_mismatch` (with `currentRevision`); an unknown prompt gets 404 `prompt_not_found` (`src/api/handlers/sessions.handlers.ts`, `promptAnswerStatus`).
  > The legacy routes answer 409 with a `reason` of `gate_closed` or `question_gone`, and 400 `no_pending_question` or `tool_use_mismatch` (`src/services/questions/resolveAnswer.ts`).

### 1.7 Server-level REST endpoints

- **F-171** `GET /api/info` returns version and capabilities (E2EE, prompt contract, push, raw keys…). `L1/Server`
  > **Streamer (verified 2026-09-25):** The route (`src/api/routes/misc.routes.ts`) also returns `machineName`, `platform`, `activeSessions`, `publicUrl`, `claudeFlags`, `featureFlags`, `projectSummary`, `devicesDurable`, `hostPressure` and `serverIdentityKey`.
- **F-172** `GET /api/diagnostics` returns checks: `ok`, `degraded`, `failed` or `unknown`, with codes such as `PTY_UNAVAILABLE`, `DB_UNAVAILABLE`, `CLOCK_SKEWED`. `L1/Server`
  > **Streamer (verified 2026-09-25):** The route emits only `ok`, `degraded` and `failed`, with the codes `NONE`, `PROVIDER_NOT_INSTALLED`, `CACHE_DEGRADED`, `PTY_UNAVAILABLE` and `FS_SCOPE_MISSING` (`src/api/routes/diagnostics.routes.ts`).
  > `unknown`, `DB_UNAVAILABLE` and `CLOCK_SKEWED` exist only in the type (`src/services/diagnostics/diagnostics.ts`); `clockSkewCheck` has no caller.
- **F-173** `GET /api/providers` returns per-CLI install state and capabilities (`resume`, `structuredQuestions`, `permissionGates`, `liveControl`…). A server too old to serve the route exists. `L1/Server`
- **F-174** `GET /api/push/health` returns a token state: `never-delivered`, `healthy`, `failing`, `dead` or `revoked`. `L1/Server`
  > **Streamer (verified 2026-09-25):** There is a sixth state, `expired`, for a lapsed Live Activity token (`src/db/repositories/push.repository.ts`, `state: "never-delivered" | "healthy" | "failing" | "dead" | "revoked" | "expired";`).
- **F-175** `GET /api/config/feature-flags` exposes today only `liveActivityPush`. A server too old to have the route answers 404. `L1/Server`
  > **Streamer (verified 2026-09-25):** It returns the whole registry with values and sources (`src/server.ts`, `registry: FEATURE_FLAG_LIST,` alongside `values` and `sources`), not only `liveActivityPush`.
  > The route needs the `admin` capability (`src/services/security/capabilities.ts`, `["/api/config", "admin"],`).

## 2. What the streamer stores

- **F-201** `completedAt` is stamped on both a real exit and a hold. (Same fact as F-138, restated in `L3/Order` and `N/Which`.)
- **F-202** `statusUpdatedAt` records when `status` last changed; during `waiting_input`, when the wait began. (See F-136.) `L2/Detail`
- **F-203** `lifecycleSource` and `lifecycleUpdatedAt` record how and when `lifecycle` was set. (See F-137.) `L2/Detail`
- **F-204** `interruptedStatus` records what a stub was doing when the streamer's own shutdown stopped it. (See F-154.) `L2/External`
- **F-205** A session stopped by the streamer mid-turn keeps a last `status` of `running` while its `lifecycle` is `resumable`. (See F-127.) `L2/Axes`

## 3. What the streamer decides

- **F-301** Turn end: the turn ends on the flip from `running` to `waiting_input`, not when an assistant message lands. Interim replies and sub-agent dispatches arrive mid-turn. `L4/Thinking`
- **F-302** The server's `status` can lag behind the user's send. `L4/Thinking`
- **F-303** The server echoes a user message with the same text as the one sent. `L4/Thinking`
- **F-304** `subStatus` is set only for Codex (`working`) and never for Claude. (See F-132.)
- **F-305** `processLiveness` decides whether an external process is still running; `activity` is inferred from the conversation log growing. (See F-152, F-153.)
- **F-306** The streamer's own shutdown can stop a session mid-turn; see F-127 (`lifecycle: resumable` with last `status` `running`) and F-154 (`interruptedStatus`).

## 4. What the streamer guarantees — and what it does not

- **F-401** Newer, optional session fields refine both axes, and every one of them may be missing (older servers omit them). `L2`, `L2/Axes`, `L2/Detail`
- **F-402** Merge contract: a key missing from a frame keeps its old value, and an explicit `null` clears it. This is why `subStatus` is always sent, as `null` when there's no phase. `L2/Merge`
  > **Streamer (verified 2026-09-25):** The merge rule is the client's. In PTY mode every `session_update` carries a full session object (`src/server-wiring.ts`, `deps.wsHub.broadcast({ type: "session_update", session: resp });`).
  > In multi-agent mode `stage_transition` sends `session_update` with no `session` (`src/api/routes/progress.routes.ts`).
  > `subStatus` and `promptSuggestion` change live on `session_phase` and `prompt_suggestion` (F-134), and scrape-only fields (`permissionMode`, scraped `effort`) are never in frames.
- **F-403** No replay of session frames across reconnects (see F-103).
- **F-404** Question frames and status frames are not ordered relative to each other (see F-163).
- **F-405** `activity` is explicitly not authoritative (see F-153).
- **F-406** `interruptedStatus` is a label only (see F-154).
- **F-407** `model`, `effort`, `permissionMode` are descriptive only (see F-143).
- **F-408** Terminal output is evidence of output, never of work. A working agent is often silent, and a finished one can still print. `Summary`
- **F-409** Claude only redraws when something changes, so 30 s+ of silence mid-turn is routine. `L5/Quiet`
- **F-410** Signal independence — agent working (`running`) × terminal printing: tool output scrolling; working × quiet: thinking or waiting on a long tool, common, often 30 s+; not working × printing: late output after the turn ended; not working × quiet: idle, waiting for you. `N/Independent`
- **F-411** E2EE: on a server pinned with `serverPublicKey`, opening the encrypted context can fail. Only `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT` (a 429 or a 5xx) are retryable. Revoked (403), disabled (404), version-unsupported, handshake-failed and malformed are permanent. `L1/E2EE`
  > **Streamer (verified 2026-09-25):** `E2EE_TRANSIENT` is a client label and never appears on the wire. The actual answers:
  > 403 `E2EE_DEVICE_REVOKED`, 404 `E2EE_DISABLED`, 400 `E2EE_VERSION_UNSUPPORTED`, 400 `E2EE_HANDSHAKE_FAILED`, 400 `E2EE_MALFORMED`, 429 with no code, 500 with no code, 503 `STORE_UNAVAILABLE`, 401 for a bad WebSocket ticket, and 426 `E2EE_REQUIRED` (`src/api/routes/e2ee.routes.ts`, `src/e2ee/pair-request.ts`, `src/e2ee/context.ts`).
  > `E2EE_CTX_UNKNOWN` is a REST 409 or a WebSocket close 1008 (`src/api/middleware/e2ee-envelope.middleware.ts`).
  > The recoverable / never-retry split matches `src/e2ee/protocol.ts`: `E2EE_CTX_UNKNOWN` is recoverable, `E2EE_DEVICE_REVOKED` is a hard failure.
- **F-412** A later 429 after a permanent verdict is the server reacting to the app's own retries. `L1/E2EE`
- **F-413** None of the E2EE failures falls back to plaintext. `L1/E2EE`
  > **Streamer (verified 2026-09-25):** The server never downgrades on a failure: a pinned device's plaintext request gets 426 `E2EE_REQUIRED` (`src/e2ee/context.ts`), and a socket that has been sealed cannot go plaintext (`src/ws-hub.ts`, `everSealed`).
  > A phone that presents the shared API key resolves to the `legacy` principal, whose device row has no pin, and is served plaintext (`src/api/routes/ws.routes.ts`, `src/e2ee/context.ts`).
  > Current tb-mobile builds close this on the device with the `requireEncryption` pin (#698), so it is reachable only from a client without that pin. No streamer change.
- **F-414** On encrypted servers each redial costs a Noise handshake against a limit of five per minute per device. `L1/Reconnect`

## 5. Client-side context

These facts concern only the mobile app. They are kept verbatim in meaning, with their source.

### 5.1 The five layers

- **F-501** What the app shows about a session depends on five layers. Each one answers a different question, and a lower layer can be healthy while a higher one isn't. Most state bugs come from reading one layer's signal as if it answered another layer's question. `Summary`
- **F-502** Layers table. `Summary`

  | # | Layer | Question it answers | Main signal | Source of truth |
  | --- | --- | --- | --- | --- |
  | 1 | Connection & server | Can the app reach this server at all? | `wsManager` status, `isConnected`, `/api/info` | App-side socket state + server probes |
  | 2 | Session wire fields | What does the server say about this session? | `status`, `lifecycle`, `subStatus`, `ptyAttached`, `ownership` | Server (`session_update` frames and REST) |
  | 3 | Presentation | How should the app label it and what may the user do? | `deriveSessionPresentation` → `kind`, `tier`, `live`, `capabilities` | Pure function in the app, over layer 2 |
  | 4 | Live turn (chat) | Is the agent working right now, or waiting on me? | `isAgentThinking`, `thinkingState`, `activeQuestion` | Layer 2 `status` + local pending sends + question frames |
  | 5 | Terminal stream | What is on the agent's screen, and has it printed lately? | `terminal_output`, `isStreaming`, `parseConfidence` | Raw PTY bytes over the socket |

- **F-503** Presentation combines both axes into one verdict. Screens must read it rather than re-deriving liveness. `Summary`
- **F-504** Terminal activity (`isStreaming`) is evidence of output, never of work. `Summary`
- **F-505** The app never polls session state. Everything arrives over the WebSocket, plus refetches on reconnect and on returning to the foreground. A dropped socket therefore means stale state, not an error. `Summary`

### 5.2 Connection (Layer 1)

- **F-511** Each server has one WebSocket, owned by `wsManager` (`services/ws-client.ts`). Its status is the gate for everything above it: `connecting`, `connected` or `disconnected`. While it isn't `connected`, session state freezes at its last value and the composer refuses to send. `L1`
- **F-512** Socket state diagram. `L1`

  ```mermaid
  stateDiagram-v2
      [*] --> connecting: connect()
      connecting --> connected: socket open (+ first frame unsealed if E2EE)
      connecting --> disconnected: error / 15 s connect timeout
      connected --> disconnected: close / error
      disconnected --> connecting: backoff 1-2-4-8-16-30 s
      disconnected --> connecting: forceReconnect() (foreground, silence watchdog)
      connecting --> disconnected: permanent E2EE refusal (no retry)
  ```

- **F-513** The socket reconnects on its own, with a backoff that caps at 30 s. `forceReconnect()` skips the backoff; three places call it. A permanent E2EE refusal is the one case that stops reconnecting altogether. `L1`
- **F-514** Reconnect backoff: 1, 2, 4, 8, 16, then 30 s cap. Retries after an unplanned close, to avoid hammering a down server. `L1/Reconnect`
- **F-515** `CONNECT_TIMEOUT_MS` = 15 s: abandons a hung connect, because a black-holed TCP/TLS handshake can hang 60 s+. `L1/Reconnect`
- **F-516** `WS_SILENCE_TIMEOUT_MS` = 45 s: no frame of any kind → `forceReconnect()`. iOS silently kills TCP without firing `onclose`. Must stay above the 30 s ping cadence, or every idle session redials. `L1/Reconnect`; "Silence watchdog — 45 s, any frame — `forceReconnect()` and re-arm" `L5`
- **F-517** Foreground: on AppState `active` → `forceReconnect()` + refetch the session and conversation. `L1/Reconnect`
- **F-518** Waking-up backstop: 8 s / 15 s — forces reconnect + rehydrate if a session is still "waking up". Recovers a start that never got its first frame. `L1/Reconnect`
- **F-519** Resubscribe: on every `connected`, re-sends `subscribe_session` for each held session. `L1/Reconnect`
- **F-520** The app sends no heartbeat of its own; liveness is judged purely from incoming frames. `L1/Reconnect`
- **F-521** Because each E2EE redial costs a Noise handshake against the per-device limit, `forceReconnect()` no-ops while a handshake is already in flight. `L1/Reconnect`
- **F-522** `isConnected` (`stores/servers.ts`): mirror of `wsManager` status == `connected`. On disconnect, also clears scan progress, cache alerts and host pressure. `L1/Server`
- **F-523** `serverInfo` (`GET /api/info`, 12 s timeout): re-probed silently on every connect; a failed silent probe keeps the old info rather than dropping working capabilities. `L1/Server`
- **F-524** `connectionError` (same probe): human-readable reason for a failed non-silent probe; cleared on success. `L1/Server`
- **F-525** Fetch status (`useServerFetchStatusStore`): REST session fetch `ok`, `error` or `warming_up`; last-good sessions stay on screen for that server. `L1/Server`
- **F-526** Diagnostics have a 15 s stale time. `L1/Server`
- **F-527** Provider health is silent on error: a server too old to serve the route must not raise a global alert. `L1/Server`
- **F-528** Push health has a 15 s stale time. `L1/Server`
- **F-529** Feature flags: a 404 (server too old) resolves to off. `L1/Server`
- **F-530** The docs describe each server along three independent dimensions: socket status, REST fetch status and whether it is displayed. They can disagree. REST can succeed while the socket is down, and the reverse. `L1/Server`
- **F-531** A permanent E2EE verdict is remembered per server and pin, and a later 429 must not overwrite it. Only re-pairing or an explicit user retry clears the verdict, never a foreground or a network blip. `L1/E2EE`

### 5.3 Session fields as the app reads them (Layer 2)

- **F-541** `Session` is typed in `types/api.ts`; the app must treat every newer, optional field as possibly missing. `L2`
- **F-542** Status values the app doesn't recognize become `idle` via `narrowSessionStatus`, but only on REST paths. `L2/Axes`
- **F-543** `lifecycle` is preferred over guessing from `ptyAttached` or `completedAt`. `L2/Axes`
- **F-544** `promptSuggestion` is shown only during `waiting_input`. `L2/Detail`
- **F-545** `elapsedMs` and `promptCount` are shown as-is in the status bar; `promptCount === 0` feeds "waking up" logic. `L2/Detail`
- **F-546** `resumedFromConversationId` changes kind to `resumed`. `L2/Detail`
- **F-547** REST: `useEagerSessions` (the list) and `useSessionDetail` (one session) fetch once, then again on reconnect or foreground. There is no `refetchInterval` anywhere. Session detail is deliberately not persisted across restarts, because stale persisted state caused false status flickers. `L2/Merge`
- **F-548** WebSocket `session_update`: the global handler in `app/_layout.tsx` cancels any in-flight REST fetch, then merges the frame into the cache with a shallow spread. It also patches the home list in place. `L2/Merge`
- **F-549** Every `connected` event also invalidates the session query. `L2/Merge`

### 5.4 Presentation (Layer 3)

- **F-551** `deriveSessionPresentation` (`lib/sessionPresentation.ts`) is the only place that decides whether a session is live and what it may do. It is a pure function over the Layer 2 fields. It runs an ordered list of checks, and the first match wins, so the order carries meaning. `L3`
- **F-552** Classification order. `L3/Order`

  | # | First matching condition | kind | live | Color | Capabilities | List tier |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1 | `lifecycle: starting` | starting | no | running | none | Working |
  | 2 | `status: on_hold` | on_hold | no | waiting | cancel only | Resumable |
  | 3 | `lifecycle` completed / failed | completed | no | completed / failed | none | Resumable / Can't resume |
  | 4 | `status` completed / failed | completed | no | completed / failed | none | Resumable / Can't resume |
  | 5 | external and alive | external_live | **yes** (external) | completed | observe only | Observed |
  | 6 | external and `processLiveness: gone` | stale | no | idle | observe only | Resumable |
  | 7 | `lifecycle: resumable`, or `ownership: historical`, or external not alive | historical | no | idle | observe + resume | Resumable |
  | 8 | `status` running / waiting_input | managed_live, or resumed if `resumedFromConversationId` is set | **yes** | running / waiting | send + cancel | Working / Needs you |
  | 9 | anything else | idle | no | idle | none | Resumable |

- **F-553** Starting comes first. Without this check a spawning session (status still `idle`) would read as a plain idle row. `L3/Order`
- **F-554** Lifecycle comes before status, because only `lifecycle` can tell a real exit from a hold. `L3/Order`
- **F-555** Held beats running. A session with `lifecycle: resumable` is historical even if its last `status` was `running`. `interruptedStatus` then changes only the label ("Interrupted" / "Interrupted while waiting"), never the kind or what the user can do. `L3/Order`
- **F-556** No branch for `attached`, `detached` or `orphaned`. These fall through to the status checks (8 and 9), so for them `status` decides. `L3/Order`; repeated as inconsistency 5 in `N/Inconsistencies`
- **F-557** "External and alive" (check 5) uses the first answer from this list: `processLiveness: alive` → yes; `gone` → no; `activity: active_writing` → yes; no liveness or activity info but a `pid` → yes; otherwise no. `L3/Order`
  > **Streamer (verified 2026-09-25):** The "no liveness but a `pid`" branch cannot trigger against the current streamer, which always sends `processLiveness: "alive"` alongside `pid` (F-152).
- **F-558** Verdict contents. `L3/Verdict`

  | Output | Values | Used for |
  | --- | --- | --- |
  | `kind` | 10 values (classification table) | Routing and detail copy |
  | `statusLabel` | 15 values (running, waiting, interrupted, onHold, stale, unavailablePath…) | Filter sheets and longer copy |
  | `tier` | Needs you, Working, Resumable, Can't resume, Observed | The one word a list row or badge shows |
  | `live` | boolean | Pulsing dot, "Live control" chip, gating `subStatus` |
  | `colorToken` | running, waiting, completed, idle, failed | Badge color |
  | `capabilities` | canSendInput, canCancel, canOvertake, canResume, isObserveOnly | Which actions the UI offers. `canOvertake` is never true today |
  | `confidence` | process, jsonl, status, unknown | How the verdict was reached, from strongest to weakest evidence |
  | `subStatus` | an agent phase or null | Set only when `live`. A phase value the app doesn't recognize becomes null |

- **F-559** Tier comes from the verdict in its own order: observed if external-live; can't resume if unavailable or failed; if live, Needs you when waiting, otherwise Working; Working while starting; otherwise Resumable. In the screenshot, "Needs you" is tier `needsYou`: a live managed session in `waiting_input`. "Live control" is shown because `live` is true and the session isn't observe-only. `L3/Verdict`
  > **Streamer (verified 2026-09-25):** A permission gate held open during a turn keeps `status: running` (F-164), so this tier reads Working; only the open prompt shows the wait. Use `hasOpenPrompt` (F-164) as well as `waiting_input`.
- **F-560** Conversations have their own, smaller check (`deriveConversationPresentation`). `resumable: false` with an `unavailableReason` yields kind `unavailable` and tier Can't resume. `L3/Verdict`

### 5.5 The live turn in chat (Layer 4)

- **F-571** The chat screen decides "is the agent working?" with `isAgentThinking`, and shows it with the thinking bubble. The bubble swaps the Knight Rider scanner for a question card whenever the agent needs an answer. `L4`
- **F-572** `isAgentThinking` definition. `L4/Thinking`

  ```
  isAgentThinking =
    session.status === 'running'
    || (pendingSends.length > 0 && lastMessage.role !== 'assistant')
  ```

- **F-573** `status === 'running'` is the authoritative half. Gating on "last message is assistant" once hid the bubble for whole sub-agent runs. `L4/Thinking`
- **F-574** The pending-send half covers the moment right after you press send. Your message shows immediately (optimistically). A pending send is removed when the server echoes a user message with the same text, or when the send fails. `L4/Thinking`
- **F-575** Thinking bubble state machine. `L4/Bubble`

  ```mermaid
  stateDiagram-v2
      [*] --> hidden
      hidden --> thinking: isAgentThinking
      thinking --> fading: isAgentThinking turns false
      fading --> thinking: isAgentThinking again
      fading --> hidden: 350 ms fade completes
  ```

- **F-576** The bubble is mounted when `activeQuestion !== null || thinkingState !== 'hidden'`. The question half matters because a question arrives on the same edge that starts the fade. Without it, a card landing a moment later would have nowhere to render. `L4/Bubble`
- **F-577** What the bubble shows: a structured question, permission gate or prompt is active → that card only, at full opacity (a card stops the fade); a question was parsed from terminal output → that card only; otherwise → Knight Rider scanner, plus a phase label when `subStatus` is set. `L4/Shows`
- **F-578** The scanner is not gated on `subStatus`; gating on it hid the scanner for every Claude turn. Since this branch, the scanner is also the bubble's only working cue: the skeleton that appeared during quiet terminal periods is gone. `L4/Shows`
- **F-579** `useActiveQuestion` holds at most one card, in one of two phases: `active` — the gate is open; card is tappable, send is disabled. `pending` — you answered and the server accepted, but the gate hasn't been seen closing; faded ghost card, blocks nothing, expires after 30 s. `L4/Questions`
- **F-580** The card tears down on an edge: it resets only on a `waiting_input → something else` edge that was actually observed. A plain "status isn't `waiting_input`" check would kill a card right after it appeared. `L4/Questions`
- **F-581** One contract at a time: once the newer prompt contract has been seen, the older `question` / `permission` frames are ignored, or every gate would open twice. Only `open` and `updated` prompts are actionable. `L4/Questions`
  > **Streamer (verified 2026-09-25):** The streamer sends both contracts for every gate and question (F-161), so ignoring legacy frames once the prompt contract is seen is load-bearing, not defensive.
- **F-582** Answers go through the route, not the card. A tap hands off upward and the card doesn't dismiss itself. "Question closed" and "prompt changed" answers are shown as notices, not errors. `L4/Questions`
- **F-583** Session status bar: "Needs you" (label) ← `presentation.tier`; badge color ← `presentation.colorToken`, which isn't always the tier's color; pulsing dot ← `presentation.live`; "Live control" / "Observe only" ← `capabilities.isObserveOnly`, else `live`; "Chat" / "Terminal" ← page-level `isLive` + whether the terminal surface is forced (low `parseConfidence`, no conversation, user preference); "17m 9s", "9 prompts" ← raw `elapsedMs` and `promptCount`. `L4/StatusBar`

### 5.6 The terminal stream (Layer 5)

- **F-591** `useTerminalStream` feeds the agent's raw terminal (PTY) bytes into a virtual terminal and publishes its lines. It reports what is on the agent's screen and how recently it changed. It says nothing about whether the agent is working. `L5`
- **F-592** Replay: a replay of only blank lines is ignored, so the HTTP fallback still fills the screen. `L5`
- **F-593** HTTP fallback: `TERMINAL_REPLAY_TIMEOUT_MS` = 2 s. If no replay with content arrives, reads `/output`. A 404 is treated as empty history. `L5`
- **F-594** Seq dedup, per frame: drops `terminal_output` whose `seq` is at or below the last seen. `L5`
- **F-595** `isStreaming`: 1.5 s debounce — true on each accepted `terminal_output`, false 1.5 s after the last one. `L5`
- **F-596** `parseConfidence`: `low` / higher. When low, raw lines are published instead of cleaned ones, and the screen may switch to the terminal view. `L5`
- **F-597** Resubscribe on `connected`: resets replay state and re-binds every listener. `L5`
- **F-598** A quiet period is 1.5 s or more without an accepted live `terminal_output` frame. `L5/Quiet`
- **F-599** Replay never counts: `terminal_replay` fills the screen but never sets `isStreaming`, so a freshly opened session starts out quiet. `L5/Quiet`
- **F-600** Any accepted frame counts, however trivial. A cursor move or spinner redraw resets the timer just like real text. `L5/Quiet`
- **F-601** Quiet is not idle. The skeleton that used to cover these periods has been removed; the scanner alone now signals the turn. `L5/Quiet`

### 5.7 Nuances and pitfalls

- **F-611** Several signals have similar names but answer different questions. Pick the signal by the question you're asking. `N/Which`
- **F-612** Which signal answers which question. `N/Which`
  > **Streamer (verified 2026-09-25):** "Is it waiting on me?" via `tier === 'needsYou'` misses a gate held open during a turn, where `status` stays `running` (F-164). Read it as `status === "waiting_input" || hasOpenPrompt === true`; the field is absent on older streamers.

  | Question | Use | Not |
  | --- | --- | --- |
  | Can I talk to this server? | `useWsStatus` / `isConnected` | REST success (can work while the socket is down) |
  | Does the server support feature X? | `serverInfo`, feature flags, provider capabilities; missing = off | Server version comparisons |
  | Is the agent working on a turn? | `status === 'running'` (via `presentation.live` + `tier`) | `isStreaming`, `subStatus` |
  | Is it waiting on me? | `tier === 'needsYou'`, or an active question card | Silence in the terminal |
  | Does a process exist? | `lifecycle` | `completedAt`, `ptyAttached` alone |
  | Is it over, or only on hold? | `lifecycle` (`completed`/`failed` vs `resumable`) or `status: on_hold` | `completedAt` (stamped on both) |
  | What is the agent doing inside the turn? | `subStatus` (Codex only today) | Guessing from terminal text |
  | Has the terminal printed lately? | `isStreaming` | Anything about work |

- **F-613** The same independence holds between layers. A session can be `live` while the socket is `disconnected`, because the verdict comes from the last known state, which is now stale. `N/Independent`
- **F-614** Two definitions of "live": `presentation.live` — managed session with `status` running or waiting, **or** an alive external process; ignores `ptyAttached`; used by badges, list tiers, the `subStatus` gate. Page-level `isLive` (`app/session/[id].tsx`) — `ptyAttached === true` and `status` running or waiting; used by the view-mode chip, stream subscription, End Session. `N/Live`
- **F-615** An external live session is `presentation.live` but not page-level `isLive`. A managed session with `ptyAttached: false` and `status: running` is the reverse. It gets the "discovered / overtake" screen. `N/Live`
- **F-616** Inconsistencies found in the mobile code (checked 2026-09-24): `N/Inconsistencies`
  1. The chat screen replaces the cache instead of merging. `LiveConversationView.tsx` writes each `session_update` frame over the cached session. The global handler in `_layout.tsx` merges it. Both write the same key, so a partial frame can drop fields such as `promptSuggestion`, and the result depends on which handler runs last.
  2. WebSocket frames skip status narrowing. `narrowSessionStatus` runs only on REST responses. An unknown status from a frame reaches the cache as-is. Classification still falls through to `idle`, but any other code that switches on `status` sees the raw value.
  3. The badge label and its color come from different fields. The label comes from `tier`, the color from `colorToken`. On hold reads "Resumable" in amber. Starting reads "Working" in the running color.
  4. `wsManager.onAll` misses clients created later. Its comment says "all active (and future) clients", but it binds only to clients that exist at call time. It works today because `_layout` connects first.
  5. `attached`, `detached` and `orphaned` have no branch of their own. They are classified by `status` alone.
  6. Some docs are out of date. `docs/single-session-rendering-logic.md` still describes the old badge ("Active" in green) and an older `isLive`. `docs/conversation-rendering-logic.md` still gives the old `isAgentThinking`. `docs/design/session-list/README.md` contradicts itself on whether `statusUpdatedAt` exists.

  None of these is fixed in the original doc's branch. Items 1 and 2 are the ones most likely to show up as user-visible state glitches.

### 5.8 Source map (mobile repository)

- **F-621** Paths are in `RonenMars/threadbase-mobile`. Line numbers are as of 2026-09-24 and will drift. `SourceMap`

  | Topic | File | Lines |
  | --- | --- | --- |
  | Session and lifecycle types | `types/api.ts` | 5–149 |
  | Status narrowing | `lib/sessionPresentation.ts` | 8–26 |
  | Classification, tier, live | `lib/sessionPresentation.ts` | 175–392 |
  | Phase / opens-as-history helpers | `lib/sessionPresentation.ts` | 428–467 |
  | Socket status, backoff, forceReconnect | `services/ws-client.ts` | 117–489 |
  | `onAll` (current clients only) | `services/ws-client.ts` | 600–607 |
  | Server store, `/api/info` probe | `stores/servers.ts` | 365–458 |
  | E2EE retry classification | `services/e2ee/context.ts` | 71–82, 192–216, 378–453 |
  | Global `session_update` merge | `app/_layout.tsx` | 203–253 |
  | REST session queries | `hooks/useSession.ts` | 20–355 |
  | Terminal stream, replay, isStreaming, watchdog | `hooks/useTerminalStream.ts` | 22–354 |
  | Questions and permissions | `hooks/useActiveQuestion.ts` | 37–416 |
  | Answer routing | `hooks/useQuestionAnswer.ts` | 63–167 |
  | `isAgentThinking`, bubble state, cache replace | `components/conversation/LiveConversationView.tsx` | 192–298 |
  | Scanner / card rendering | `components/conversation/ThinkingBubble.tsx` | whole file |
  | Status bar, page-level `isLive`, foreground handling | `app/session/[id].tsx` | 491–519, 665–667, 1136–1244 |
  | Badge label vs color | `components/sessions/SessionStatusBadge.tsx` | 41–42 |
  | Server-state scenarios | `docs/server-state-scenarios.md` | — |
  | List tiers design ruling | `docs/design/session-list/README.md` | — |
