# Streamer state model — audit against the code

Checked on 2026-09-24 against `main` at `251d9f58` (release 1.101.7).
Every fact is from [streamer-state-model.md](streamer-state-model.md) and is referred to by its `F-nnn` ID.
Line numbers are as of that commit and will drift; each citation carries a short excerpt so it can be re-found by search.

## 1. Summary

The doc's broad model holds, but its enumerations and several detail fields describe an older streamer.
The two failures that affect what users see are both on the wire today: `statusUpdatedAt` is frozen at spawn time (a streamer bug), and a Claude or Codex permission gate during a turn keeps `status` at `running` instead of flipping to `waiting_input` (a doc error about deliberate behavior).

**148 facts in total.**
- **59 streamer-facing facts** (§1, §3 and §4 of the reorganized doc) were checked against the code.
- **13 cross-reference entries** (F-201–205, F-304–306, F-403–407) restate a checked fact. They take that fact's verdict and are not counted again.
- **76 client-side facts** (§5) describe the mobile app and cannot be verified in this repo. Where streamer code bears on one, §2.3 says so.

| Verdict | Streamer-facing | Client-side | Total |
| --- | --- | --- | --- |
| Confirmed | 20 | 0 | 20 |
| Imprecise | 26 | 0 | 26 |
| Incorrect | 7 | 0 | 7 |
| Not verifiable in this repo | 6 | 76 | 82 |
| **Checked** | **59** | **76** | **135** |

By severity, the 39 streamer-facing facts that are not Confirmed break down as:

| Severity | Count |
| --- | --- |
| High | 3 |
| Medium | 15 |
| Low | 21 |

### Confirmed facts (not detailed further)

| ID | Fact (short) | Evidence |
| --- | --- | --- |
| F-101 | `{type:'ping'}` every 30 s | `src/ws-hub.ts:32` `export const PING_INTERVAL_MS = 30_000;` and `:538` `const appPing: WSMessage = { type: "ping", ts: Date.now() };`. It goes to every connected socket, and the timer runs only while one exists (`:522`). |
| F-104 | New socket starts with no subscriptions | `src/server-wiring.ts:1022` `subscribers.delete(ws);` on close. Subscriptions are per socket. |
| F-114 | `GET /api/sessions/:id/output` exists | `src/api/routes/sessions.routes.ts:63`; `src/api/handlers/sessions.handlers.ts:2139` `json(res, 200, { output });`. It returns the raw 64 KB ring buffer. |
| F-124 | `lifecycle` is the process axis | `src/types.ts:36-43`; derivation in `src/session-store.ts:294-302`. |
| F-131 | `subStatus` value set | `src/types.ts:29` `export type AgentPhase = "thinking" \| "streaming" \| "hooks" \| "acting" \| "working";` |
| F-132 | Only `working`, only Codex, `null` for Claude | `src/services/questions/parseAgentPhase.ts:44` returns `"working"`; `:56-57` `claudePhase(…) { return null; }`. Cursor never calls `setPhase`. |
| F-133 | Explicit `null` = cleared | `src/session-store.ts:330` `subStatus: s.subStatus ?? null`. The key is always present, so "absent key = server too old" cannot be tested here. |
| F-138 | `completedAt` stamped on exit and on hold | Exit: `src/pty-manager.ts:1517` `session.completedAt = new Date();`. Hold: `src/pty-manager.ts:776`, `src/codex-pty-runner.ts:704`, `src/cursor-pty-runner.ts:344`. `statusSource` (`process-exit` vs `shutdown`) also tells them apart. |
| F-140 | `promptSuggestion` is Claude's ghost prompt | `src/session-store.ts:333` `promptSuggestion: s.promptSuggestion ?? null`. The only setter is `src/pty-manager.ts:1465-1466` `session.promptSuggestion = text;`. |
| F-151 | `ownership` values and meaning | `src/types.ts:610`; `src/session-store.ts:315` `ownership: s.rehydrated ? "historical" : "managed"`; `:376` `ownership: "external"`. "Historical" also covers session stubs restored at boot. |
| F-153 | `activity` shape; not authoritative | `src/types.ts:613-616`; `src/external-tails.ts:35` `EXTERNAL_ACTIVE_WRITING_MS = 30_000`. Present only on external sessions in the session list. |
| F-155 | `pid` on discovered processes | `src/session-store.ts:400` `pid: d.pid,` in `discoveredToResponse`. Managed sessions never carry it. |
| F-162 | Only `open` and `updated` prompts are actionable | `src/services/prompts/promptRegistry.ts:383`. The full state set is in `src/schemas/prompt.schema.ts:59`: `open`, `updated`, `resolved`, `cancelled`, `expired`, `unavailable`. |
| F-163 | Question and status are separate, unordered frames | `src/server-wiring.ts:569` `broadcast({ type: "session_update", … })` goes to every client; `src/api/handlers/sessions.handlers.ts:1457-1458` `this.broadcastToSession(sessionId, { type: "permission", …` goes to subscribers only. Nothing orders them. |
| F-173 | `/api/providers` capability keys | `src/services/providers/capabilities.ts:18-44`: `freshSessionId`, `resume` (`"native" \| "unsupported"`, not a boolean), `systemPrompt`, `structuredQuestions`, `permissionGates`, `liveControl`. |
| F-301 | The turn ends on `running → waiting_input` | Every runner marks a signalled end `statusSource: "turn-signal"`, and the Claude marker is ignored while a turn is open (`src/pty-manager.ts` `turnOpen` handling around `:1379-1402`). |
| F-302 | Server `status` can lag the user's send | `src/pty-manager.ts:589-596`: `if (session.status === "waiting_input") { session.status = "running"; … this.onStatusChange?.(…) }`. The flip is synchronous on the server; the lag is delivery of the resulting frame. |
| F-303 | The server echoes the user message | `src/server.ts:2785-2805` `broadcastConversationLines` sends transcript lines (user lines included) as `conversation_events` plus per-line `conversation_event`. |
| F-412 | A later 429 is the server reacting to retries | `src/api/rate-limit.ts:37-38` `PAIR_EXCHANGE_LIMIT = 5; PAIR_EXCHANGE_WINDOW_MS = 60_000;` answers 429 once the device's own retries exhaust the budget. |
| F-414 | Five handshakes per minute per device | Same constants; keyed by the device's Noise static key: `src/api/routes/e2ee.routes.ts:357` `if (!rateLimit(\`key:${staticPub}\`))`. |

## 2. Facts that are not Confirmed

Severity is judged by the harm a reader acting on the fact would do.
**High** means acting on it produces wrong user-visible state.
**Medium** means it misleads reasoning about the wire contract.
**Low** means it is incomplete or cosmetic.

### 2.1 Streamer-facing facts, ordered by severity

| ID | Original statement | What the code actually does (evidence) | Verdict | Severity | Recommended fix |
| --- | --- | --- | --- | --- | --- |
| F-136 | `statusUpdatedAt`: when `status` last changed; during `waiting_input`, when the wait began. | The runners stamp it on every transition (`session.statusUpdatedAt = new Date();` at `src/pty-manager.ts:507,593,775,1333,1483,1520`, and likewise in `src/codex-pty-runner.ts`). But the status-change mirror into `SessionStore` copies `status`, `completedAt`, `statusSource`, `failureReason` and others, and **not** `statusUpdatedAt` (`src/server-wiring.ts:454-480`, `deps.sessionStore.updateManaged(session.id, { status: session.status, completedAt: session.completedAt, …`). REST and `session_update` serialize the store copy (`src/session-store.ts:353`), so they send the **spawn time** for the whole life of a live session. Mobile reads it for elapsed-wait copy (`tb-mobile/components/sessions/shared/formatCoarseElapsed.ts`). | Incorrect (as sent) | High | **Code** (G1) |
| F-164 | A question arrives on the same `running → waiting_input` edge that starts the fade. | A Claude permission gate during a turn holds the turn open, so `status` stays `running`. `src/pty-manager.ts:1384-1398`: `if (turn === "ending" \|\| turn === "held") { … if (gate) { … this.turnOpen.set(sessionId, "held"); … return; }`. Codex does the same while an approval, gate or picker card is open. The card arrives while `status` is `running`, with no status edge. `prompt_event` goes only to that session's subscribers (`src/server.ts:649-651` `emit: (event) => this.wsHub.broadcastToClients(this.sessionSubscribers.get(event.sessionId) ?? [], event)`), so a client that isn't subscribed has no way to see the block. tb-mobile's tier reads `status` alone (`lib/sessionPresentation.ts:195` `if (p.live) return p.colorToken === 'waiting' ? 'needsYou' : 'working'`), so every gated session off-screen shows as Working. | Incorrect | High | **Doc** (D1) + **Code** (G4) + mobile (M2) |
| F-134 | `subStatus` is always sent, as `null` when there's no phase (in `session_update` merges). | The key is always present on session objects (`src/session-store.ts:330`). But a phase change is not sent as `session_update`. It goes as a separate `session_phase` frame to that session's subscribers only (`src/server-wiring.ts:388-404`, `type: "session_phase", sessionId, phase, updatedAt`). `promptSuggestion` works the same way with `prompt_suggestion` (`:405-415`). A `session_update` carries the latest store value only when some other event triggers one. Mobile listens for `prompt_suggestion` (`tb-mobile/hooks/usePromptSuggestion.ts`) but has no `session_phase` handler, so live phase labels do not arrive. | Imprecise | High | **Doc** (D2), plus a **mobile code** change (M1, out of scope for the streamer) |
| F-123 | `status` values `running`, `waiting_input`, `idle`; the server also sends `on_hold`, `completed` and `failed`. | `src/types.ts:10` `SessionStatus = "running" \| "waiting_input" \| "idle"`. Nothing in `src/` emits `completed` or `failed` as a status; they exist only as lifecycle values. `on_hold` appears only in the `GET /api/sessions/:id` fallback for a cached conversation (`src/api/handlers/http-helpers.ts:39` `status: "on_hold" as const`). `/recents` uses `idle` (`src/api/handlers/conversations.handlers.ts:486`). The 202 start and fork bodies carry `status: "pending"` (`src/api/handlers/sessions.handlers.ts:2719`). | Incorrect | Medium | **Doc** (D3) |
| F-126 | A session can be `lifecycle: attached` + `status: idle` (process up, nobody mid-turn). | Between turns a live PTY is `waiting_input`. `idle` is set only on exit or hold, and both stamp `completedAt`. Discovered external processes are `status: "idle"` + `lifecycle: "detached"` (`src/session-store.ts:375,384`). A multi-agent session is `attached` only while running or waiting (`src/session-store.ts:259-261`). The only `attached` + `idle` a client sees is the defective exit frame (see F-135). | Incorrect | Medium | **Doc** (D4); the exit-frame part is **Code** (G2) |
| F-128 | A session being spawned has no PTY yet, so its `status` is still `idle` (while `lifecycle` is `starting`). | Spawn sets `status: "running", statusSource: "spawn"` (`src/pty-manager.ts:380-381`). `starting` needs no PTY, no `completedAt` and no failure reason (`src/session-store.ts:300`). Every path to `idle` stamps `completedAt`, so `starting` in practice goes with `running`. | Incorrect | Medium | **Doc** (D5) |
| F-143 | `model`, `effort`, `permissionMode`: read from the agent's status line. | The status-line scrape runs only on `GET /api/sessions/:id` for a live PTY (`src/api/handlers/sessions.handlers.ts:596-603`). Elsewhere `effort` comes from the spawn options (`src/pty-manager.ts:379` `...(options.effort != null && { effort: options.effort })`) and `model` from the conversation cache on resume (`src/server.ts:3015` `model: cached.model`). `permissionMode` is never in the list, `session_update` or `session_list`. | Incorrect | Medium | **Doc** (D6) |
| F-135 | `ptyAttached`: the streamer has a terminal attached. | True when the runner holds a PTY (`src/server.ts:996-998` `new Set(this.ptyManager.listSessions().map((s) => s.id))`). But `handleExit` fires the status callback **before** deleting the session (`src/pty-manager.ts:1534-1536` `this.onStatusChange?.(toPublicSession(session)); session.screen.dispose(); this.sessions.delete(sessionId);`; the Codex and Cursor runners do the same). The exit-time `session_update` therefore says `status: "idle"`, `ptyAttached: true`, `lifecycle: "attached"`. Hold deletes first and is unaffected. | Imprecise | Medium | **Code** (G2) |
| F-139 | `failureReason` — presence alone turns a completion into "failed". | Lifecycle is `failed` only when no PTY is attached and the session is neither restored nor held (`src/session-store.ts:294-299`, where `resumable` is checked before `failureReason != null ? "failed"`). Codex sets `failureReason` on a **live** session when a usage-limit screen appears (`src/codex-pty-runner.ts:1117` `session.failureReason = blocking.detail ? …`). Nothing ever clears it, and the mirror refuses to blank it (`src/server-wiring.ts:478`). A later clean exit is then reported as `failed`, and tb-mobile shows it as a red "failed" label (`lib/sessionPresentation.ts:260-266`) and a "failed to start" screen quoting the old limit text (`app/session/[id].tsx:1300-1305`). The stickiness is known and has been worked around in one consumer only: `src/services/push/waitingInputNotifier.ts:148-150` (#951, 2026-09-19) says "A Codex session that hit a usage limit keeps its failureReason and goes idle when the user closes it much later — that is not a failed start", and suppresses the false push with a `neverReady` check. | Imprecise | Medium | **Both**: Doc (D7) + Code (G3) |
| F-137 | `lifecycleSource` / `lifecycleUpdatedAt`: `spawn`, `exit`, `probe`, `reconcile` / time. | The four source values are right (`src/session-store.ts:303-312`, `:385` `lifecycleSource: "probe"`, `src/api/handlers/http-helpers.ts:46` `"reconcile"`). `lifecycleUpdatedAt` is declared (`src/types.ts:526`) and **never assigned** anywhere in `src/`, so it is never sent. A held session shows `resumable` with source `exit`. | Imprecise | Medium | **Doc** (D8) |
| F-127 | A session can be `lifecycle: resumable` while its last `status` was `running`. | The wire never shows `running` + `resumable`. A stub restored after a clean shutdown is `status: "idle"`, `ownership: "historical"`, `lifecycle: "resumable"`, with the pre-shutdown status carried as `interruptedStatus` (`src/services/sessions/rehydrateSessions.ts:129` `status: "idle"`; `:156-158` `interruptedStatus: row.status`). A held session is `idle` + `resumable`. | Imprecise | Medium | **Doc** (D9) |
| F-122 | `idle` means nobody is mid-turn. | For managed PTY sessions `idle` means no live PTY: exit or hold (`src/pty-manager.ts:1518` on exit; hold at `:776`). Between turns the state is `waiting_input`. External sessions report `idle` because their prompt state is invisible (`src/session-store.ts:372-375`). | Imprecise | Medium | **Doc** (D4) |
| F-111 | On subscribe: `prompt_snapshot` (if prompt contract), then `terminal_replay` (screen so far, `seq`), then live `terminal_output`. | `prompt_snapshot` is **not** gated. `promptRegistry` is always built, so every subscriber gets it (`src/server-wiring.ts:848-850`). `terminal_replay` is sent only if a live PTY exists (`:851` `if (deps.ptyManager.hasSession(msg.sessionId))`), after an `await` (`:857`), so live `terminal_output` can arrive before it. Any pending legacy `permission` and `question` frames follow the replay. | Imprecise | Medium | **Doc** (D10) |
| F-161 | Two contracts: the prompt contract (`prompt_snapshot` / `prompt_event`, streamer 1.70+) and the older `question` / `permission` frames. | It shipped in exactly 1.70.0 (commit `68ed6691`, "feat(prompts): add provider-neutral prompt contract (#700)"). `/api/info` advertises `promptContract: { schemaVersion: 1, atomicAnswer: true }` (`src/api/routes/misc.routes.ts:460`). **Both contracts are emitted for every gate**: `promptRegistry.open()` emits `prompt_event`, and then the legacy `permission` frame is broadcast (`src/api/handlers/sessions.handlers.ts:1436-1463`; `question` at `:1291-1319`). | Imprecise | Medium | **Doc** (D11) |
| F-165 | Answers can come back as "question closed" and "prompt changed". | Both come back as HTTP **409** with `ok:false`, not as successes. `POST /:id/prompt/answer` answers 409 `prompt_cancelled`, `already_resolved`, `prompt_expired` or `prompt_unavailable`, 404 `prompt_not_found`, and 409 `prompt_revision_mismatch` with `currentRevision` (`src/api/handlers/sessions.handlers.ts:224-237`; `promptRegistry.ts:389-393`). Legacy: 409 `gate_closed` (`:1666`), 409 `question_gone` (`:2007`), and 400 `no_pending_question` / `tool_use_mismatch`. | Imprecise | Medium | **Doc** (D12) |
| F-172 | `/api/diagnostics` checks: `ok`, `degraded`, `failed` or `unknown`, codes such as `PTY_UNAVAILABLE`, `DB_UNAVAILABLE`, `CLOCK_SKEWED`. | The type declares all four statuses and nine codes (`src/services/diagnostics/diagnostics.ts:21,30-39`). The route emits only `ok`/`degraded`/`failed` and the codes `NONE`, `PROVIDER_NOT_INSTALLED`, `CACHE_DEGRADED`, `PTY_UNAVAILABLE`, `FS_SCOPE_MISSING` (`src/api/routes/diagnostics.routes.ts:66-142`). `clockSkewCheck` (`diagnostics.ts:92`) has no caller. `DB_UNAVAILABLE` exists only in the type. | Imprecise | Medium | **Doc** (D13) |
| F-411 | E2EE: only `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT` (429 or 5xx) are retryable; revoked (403), disabled (404), version-unsupported, handshake-failed and malformed are permanent. | `E2EE_TRANSIENT` is not a streamer code; it is a client label. Actual answers: 403 `E2EE_DEVICE_REVOKED` (`src/api/routes/e2ee.routes.ts:376-378`), 404 `E2EE_DISABLED` (`:212`), 400 `E2EE_VERSION_UNSUPPORTED` (`src/e2ee/pair-request.ts:81`), 400 `E2EE_HANDSHAKE_FAILED` (`e2ee.routes.ts:290,335`), 400 `E2EE_MALFORMED`, 429 with no code (`:258,:359`), 500 with no code (`:453`), 503 `STORE_UNAVAILABLE`, 401 for a bad WS ticket, 426 `E2EE_REQUIRED`. `E2EE_CTX_UNKNOWN` is a REST 409 or a WS close 1008 (`src/api/middleware/e2ee-envelope.middleware.ts:117-120`). The retry split matches `src/e2ee/protocol.ts:35-40`. | Imprecise | Medium | **Doc** (D14) |
| F-413 | None of the E2EE failures falls back to plaintext. | The server never downgrades on failure. A pinned device's plaintext request gets 426 (`src/e2ee/context.ts:746`), and a socket that was ever sealed cannot go plaintext (`src/ws-hub.ts:307,354` `everSealed`). But a pinned phone that presents the **shared API key** resolves to the `legacy` principal with no device row, so the pin cannot apply and it is served plaintext (`src/api/routes/ws.routes.ts:33-35`; `src/e2ee/context.ts:697-703`). | Imprecise | Medium | **Doc** (D15) |
| F-121 | Session wire fields come from the server via `session_update` frames and REST. | Also from `session_phase` and `prompt_suggestion` frames (see F-134). The `orphaned` lifecycle overlay (`withReconciledLifecycle`, `src/server.ts:1049-1058`) applies to REST list, `GET /:id` and `session_list`, not to `session_update`. | Imprecise | Low | **Doc** (D2) |
| F-102 | Protocol-level pings never reach JS, so the app needs an app-level frame. | The server also sends a protocol-level ping every sweep (`src/ws-hub.ts:561` `client.ping();`) and terminates a socket that doesn't pong within 10 s (`:48` `PONG_TIMEOUT_MS = 10_000`). Whether that reaches JS is React Native behavior, stated only in a comment (`:18-22`). | Imprecise | Low | **Doc** (D16) |
| F-103 | Reconnect never replays; frames sent while backgrounded are gone for good. | Missed events are never replayed. But state is rebuilt: every new socket gets `session_list` immediately (`src/server-wiring.ts:753` `unicast(ws, { type: "session_list", sessions })`), then `cache_ready` and any pending alerts. Each `subscribe_session` then gets a `prompt_snapshot`, a `terminal_replay` and any pending card. | Imprecise | Low | **Doc** (D16) |
| F-112 | The terminal stream is raw PTY bytes over the socket. | `terminal_output.data` is the raw chunk (`src/server-wiring.ts:381-385`). `terminal_replay` is rendered screen lines from a headless terminal (up to `REPLAY_MAX_LINES`, with `cols`, `rows`, `userMessages`), not bytes (`:857-872`). `/output` is the raw ring buffer. | Imprecise | Low | **Doc** (D10) |
| F-113 | Replay sets the `seq` baseline. | `terminal_replay.seq` is the last output seq and is absent before the first chunk (`src/server-wiring.ts:868-872`). The counter is in memory and is cleared by the idle reaper (`src/server.ts:1247`) and on close (`:2040`), so it restarts after a reap or restart. | Imprecise | Low | **Doc** (D10) |
| F-125 | `lifecycle` values (7); optional, older servers omit it. | All seven are produced (`src/session-store.ts:294-302`; `:384` `"detached"`; `src/services/sessions/reconcileSessions.ts:140` `"orphaned"`). It is always present on managed, discovered and `on_hold` objects and absent on `/recents` items. `orphaned` appears only via the REST and `session_list` overlay. | Imprecise | Low | **Doc** (D8) |
| F-141 | `elapsedMs`, `promptCount`: numbers. | Managed: `elapsedMs = (completedAt ?? now) − startedAt` (`src/session-store.ts:320`); `promptCount` rises once per text send (`src/pty-manager.ts:573,601`). The historical `on_hold` and `/recents` shapes put the conversation's **message count** in `promptCount` (`src/api/handlers/http-helpers.ts:61`). | Imprecise | Low | **Doc** (D17) |
| F-142 | `resumedFromConversationId`: id or null; the session was started via resume. | Set only by the resume path's best-effort enrichment, and only when a project id resolves; its value equals the session's own id (`src/server.ts:3037-3040`). It is omitted when absent, never `null`. Fork sets `forkedFromConversationId` instead, and adopt sets nothing. | Imprecise | Low | **Doc** (D17) |
| F-152 | `processLiveness`: `alive`, `gone`, `unknown`. | Only `alive` is ever sent. `src/session-store.ts:377-379`: "We never report "gone" here — a vanished process simply stops being listed." `processLiveness: "alive",`. | Imprecise | Low | **Doc** (D18) |
| F-154 | `interruptedStatus`: what a stub was doing when the streamer's own shutdown stopped it. | Set only for registry rows whose `status_source` is `shutdown`, recorded by a clean `close()` (`src/services/sessions/rehydrateSessions.ts:150-156`; `src/server.ts:2050` `if (!this.ptyManager.isRemote()) this.registryBoot.recordShutdownState();`). A crash never sets it, and pty-host mode skips it. | Imprecise | Low | **Doc** (D18) |
| F-156 | Conversations carry `resumable` and, when false, `unavailableReason` `path_missing` or `worktree_removed`. | The values are complete, but the wire field is snake_case `unavailable_reason` (`src/api/handlers/http-helpers.ts:19-29`). Mobile maps it to `unavailableReason` itself (`tb-mobile/hooks/useConversations.ts:281`). | Imprecise | Low | **Doc** (D18) |
| F-171 | `/api/info` returns version and capabilities (E2EE, prompt contract, push, raw keys…). | Correct as far as it goes. The route (`src/api/routes/misc.routes.ts:400-461`) also returns `machineName`, `platform`, `activeSessions`, `publicUrl`, `claudeFlags`, `featureFlags`, `projectSummary`, `devicesDurable`, `hostPressure` and `serverIdentityKey`. | Imprecise | Low | **Doc** (D13) |
| F-174 | `/api/push/health` token state: `never-delivered`, `healthy`, `failing`, `dead` or `revoked`. | There is a sixth state: `src/db/repositories/push.repository.ts:98` `… \| "revoked" \| "expired";` (a lapsed Live Activity token). | Imprecise | Low | **Doc** (D13) |
| F-175 | `/api/config/feature-flags` exposes today only `liveActivityPush`. | It returns every registry flag with its value and source: `src/server.ts:2606-2610` `return { registry: FEATURE_FLAG_LIST, values: this.featureFlags, sources: this.featureFlagSources };`. The route needs the `admin` capability (`src/services/providers/capabilities.ts:117`). | Incorrect | Low | **Doc** (D13) |
| F-402 | Merge contract: missing key keeps old value, explicit `null` clears. | That merge rule belongs to the client. In PTY mode every `session_update` carries a full session object (`src/server-wiring.ts:567-569`). In multi-agent mode `stage_transition` sends `session_update` with no `session` (`src/api/routes/progress.routes.ts:135-147`). Scrape-only fields (`permissionMode`, scraped `effort`) are never in frames. | Imprecise | Low | **Doc** (D2) |
| F-105 | On an E2EE server, the socket counts as connected on open plus the first frame unsealed. | This is the client's definition. The server's only first-frame rule is inbound: a sealed socket must send a frame that unseals within 10 s or it is closed (`src/ws-hub.ts:57-74,362` `WS_FIRST_FRAME_DEADLINE_MS = 10_000`). | Not verifiable in this repo | Low | None; keep as client context |
| F-115 | Streamers without `seq` are never rejected. | Client dedup policy. The current streamer stamps `seq` on every `terminal_output` (`src/server-wiring.ts:379-385`). | Not verifiable in this repo | Low | None |
| F-401 | Newer optional fields may be missing (older servers omit them). | Depends on older releases. On the current streamer `subStatus` and `promptSuggestion` are always present, and `lifecycleUpdatedAt` is always absent (F-137). | Not verifiable in this repo | Low | None beyond D8 |
| F-408 | Terminal output is evidence of output, never of work. | A design principle. The streamer's own turn detection uses the terminal title and screen, not output volume (`src/pty-manager.ts` `turnOpen`), which agrees with it. | Not verifiable in this repo | Low | None |
| F-409 | Claude only redraws when something changes, so 30 s+ of silence mid-turn is routine. | Claude Code CLI behavior. The idle reaper deliberately never touches a `running` session however long it is silent (see CLAUDE.md, "Idle reaper"), which is consistent with it. | Not verifiable in this repo | Low | None |
| F-410 | The working × printing independence matrix. | Agent behavior, not streamer code. | Not verifiable in this repo | Low | None |

### 2.2 Cross-reference entries

| ID | Restates | Verdict inherited |
| --- | --- | --- |
| F-201 | F-138 | Confirmed |
| F-202 | F-136 | Incorrect |
| F-203 | F-137 | Imprecise |
| F-204 | F-154 | Imprecise |
| F-205 | F-127 | Imprecise |
| F-304 | F-132 | Confirmed |
| F-305 | F-152, F-153 | Imprecise / Confirmed |
| F-306 | F-127, F-154 | Imprecise |
| F-403 | F-103 | Imprecise |
| F-404 | F-163 | Confirmed |
| F-405 | F-153 | Confirmed |
| F-406 | F-154 | Imprecise |
| F-407 | F-143 | Incorrect |

### 2.3 Client-side facts (§5) — Not verifiable in this repo

All 76 client-side facts are **Not verifiable in this repo**, severity Low, and no streamer change is recommended for them.
They are: F-501–505, F-511–531, F-541–549, F-551–560, F-571–583, F-591–601, F-611–616 and F-621.
Where the streamer code bears on one, the note below says how. None of these notes changes the verdict.

| ID | What the streamer code says about it |
| --- | --- |
| F-516 | The 45 s silence watchdog's premise holds: the server's ping cadence is 30 s (F-101), so 45 s stays above it. |
| F-521 | The per-device handshake budget it cites is confirmed (F-414). There is also a second budget of 30 failed handshakes per minute per source IP (`src/api/rate-limit.ts:58`). Behind the tunnel every request comes from 127.0.0.1, so that bucket is shared by every device. |
| F-557 | The "no liveness but a `pid` → alive" fallback cannot trigger against the current streamer, which always sends `processLiveness: "alive"` with a `pid` (F-152). |
| F-559, F-612 | "Is it waiting on me? → `tier === 'needsYou'`" misses a gate held open during a turn: `status` stays `running` (F-164), so the tier is Working and only the active question card signals the wait. |
| F-581 | The streamer sends both contracts for every gate (F-161), so "ignore legacy frames once the new contract is seen" is load-bearing, not defensive. |
| F-593 | `/output` never answers 404 on this streamer; an unknown session gets 200 `{ output: "" }` (`src/api/handlers/sessions.handlers.ts:2139-2147`). The 404 was removed in `5da6401f` (2026-04-28). |
| F-616 item 1 | In PTY mode the replacing handler only drops fields the frame never carries (`permissionMode`, scraped `effort`, the `orphaned` overlay), because `session_update` is a full object (F-402). |

## 3. Recommended fixes — which side changes, and why

### 3.1 Code changes (streamer)

| Fix | Facts | Why the code should change |
| --- | --- | --- |
| **G1** — mirror `statusUpdatedAt` into `SessionStore` on every status change. | F-136, F-202 | The field's meaning ("when `status` last changed") is right and mobile already renders it. The runners compute the correct value; one missing line in the mirror discards it. Fixing the doc to say "spawn time" would bless a bug. |
| **G2** — the exit-time `session_update` must report `ptyAttached: false` and a terminal lifecycle. | F-135, F-126 | A dead process is announced as `attached` in the one frame that marks its death. Every later read disagrees. Hold already deletes before notifying, so this is an ordering bug, not a design choice. |
| **G4** — add an additive `hasOpenPrompt` boolean to every serialized session, and broadcast `session_update` to all clients when it changes. | F-164, F-612 | Holding `status: running` through a gate is correct (#962) and must not change. But the only "blocked on you" signal, the prompt contract, reaches subscribers only, so list screens cannot see it. Exposing the fact on the session object keeps the turn axis clean and gives every client the answer. It is additive, so older apps ignore it. |
| **G3** — clear a Codex usage-limit `failureReason` once the limit screen is gone and the session is live again. | F-139 | **Decided 2026-09-25:** `failureReason` records what is blocking the session now, not its history. A limit that has cleared is not a failure, so a session that later exits cleanly must read `completed`, not `failed` / "failed to start". The history is still in the `codex.usage_limit` log event, and a session that exits while the limit screen is still up stays `failed`. The push notifier already works around the stuck reason (#951); fixing it at the source puts every consumer right, including the list and session screens that have no workaround. The mirror's "never blank a recorded failure" guard is right for real failures, so the clear must be explicit. |

### 3.2 Doc changes (the reorganized doc and the mobile source doc)

The doc should change wherever the code is doing what it was designed to do.

| Fix | Facts | Why the doc, not the code |
| --- | --- | --- |
| **D1** — a permission gate during a turn keeps `status: running`; the card arrives with no status edge. | F-164 | Holding the turn open is deliberate: it is the #962 fix that stopped "finished" pushes firing mid-turn. |
| **D2** — document the `session_phase` and `prompt_suggestion` frames as the live transport for `subStatus` and `promptSuggestion`; `session_update` is a full object in PTY mode. | F-134, F-121, F-402 | The split is intentional (`src/server-wiring.ts:393-398`: not routed through the global handler because it "can fire every scrape tick"). Mobile needs a `session_phase` handler (M1). |
| **D3** — status values are `running`, `waiting_input`, `idle`; `on_hold` only from the `GET /:id` conversation fallback; `pending` in 202 bodies; `completed` and `failed` are legacy. | F-123 | The repo's CLAUDE.md already treats `completed`/`failed` as legacy values that must not be reused. |
| **D4** — `idle` means no live PTY. Between turns a live session is `waiting_input`. `attached` + `idle` is not a valid steady state. | F-122, F-126 | This is the documented lifecycle in CLAUDE.md ("`idle`: no live PTY"). |
| **D5** — a spawning session is `running` from the first frame; `starting` is a defensive fallback. | F-128 | Spawn has always set `running`. |
| **D6** — `permissionMode` and scraped `effort` exist only on `GET /:id` for a live PTY; `effort` otherwise comes from spawn options and `model` from the cache. | F-143 | Scraping on every broadcast would be expensive; this is by design. |
| **D7** — `failureReason` yields `failed` only when there is no PTY and the session is not held or restored; Codex also sets it on a live session for usage limits and, after G3, clears it when the limit screen goes. | F-139 | Describes current rules; G3 fixes the stickiness. |
| **D8** — `lifecycleUpdatedAt` is never sent. A held session shows `resumable` with source `exit`. `orphaned` appears only via REST and `session_list`. | F-137, F-125 | Implementing an unused timestamp is not needed by any current consumer. Documenting its absence is the minimal fix. |
| **D9** — after shutdown or hold the wire shows `status: idle` + `lifecycle: resumable`; the pre-shutdown status is in `interruptedStatus`. | F-127 | This matches the doc's own "held beats running" rule. Only the phrasing of the wire state is wrong. |
| **D10** — the subscribe flow: `prompt_snapshot` always; `terminal_replay` only with a live PTY, as rendered lines, possibly after live output; then pending legacy cards. `seq` restarts after a reap or restart. | F-111, F-112, F-113 | Behavior is correct and tested; the doc simplified it. |
| **D11** — the prompt contract shipped in 1.70.0 with `schemaVersion: 1`, and legacy frames are still sent alongside it. | F-161 | The dual emission is deliberate backward compatibility for older app builds. |
| **D12** — answer outcomes are 409s with `code` (new route) or `reason` (legacy routes), plus the legacy 400s. | F-165 | The client correctly shows them as notices; the doc should name the wire shape. |
| **D13** — endpoint lists: `/api/info` fields, `/api/diagnostics` emitted codes, push-health `expired`, and the full feature-flag registry. | F-171, F-172, F-174, F-175 | The endpoints are additive by design. The doc was just incomplete. |
| **D14** — the E2EE status and code map (no `E2EE_TRANSIENT` on the wire). | F-411 | The retry classification is client policy and is consistent with `src/e2ee/protocol.ts`. |
| **D15** — the shared-API-key path serves a pinned phone in plaintext. | F-413 | The server cannot tie a shared-key request to a device, so no code change can enforce a pin there. The limit belongs in the doc. Current tb-mobile builds already enforce it on the device: the `requireEncryption` pin (#698, `__tests__/unit/e2ee-require-encryption.test.ts`) refuses a plaintext fallback, so the gap is only reachable from a client without that pin. |
| **D16** — the server also sends protocol pings (10 s pong timeout) and re-sends `session_list` on every connect. | F-102, F-103 | Correct behavior, omitted by the doc. |
| **D17** — historical shapes carry message count in `promptCount`; `resumedFromConversationId` is omitted rather than `null` and equals the session id. | F-141, F-142 | Existing contract; changing it would ripple into mobile. |
| **D18** — `processLiveness` is only ever `alive`; `interruptedStatus` needs a clean shutdown; `unavailable_reason` is snake_case on the wire. | F-152, F-154, F-156 | Accurate descriptions of intended behavior. |

### 3.3 Mobile changes (out of scope for the streamer; file in `tb-mobile`)

| Fix | Facts | Why |
| --- | --- | --- |
| **M2** — "needs you" = `status === 'waiting_input'` **or** `hasOpenPrompt === true`, falling back to status alone when the field is absent. | F-164, F-559, F-612 | The app's tier reads `status` alone (`lib/sessionPresentation.ts:195`), so a gated session shows as Working. Depends on G4. |
| **M3** — show "failed to start" only for a session that never took a prompt; otherwise a neutral "ended with an error" title plus the reason. | F-139 | `app/session/[id].tsx:1300-1305` shows `t('session.failedToStart')` whenever `failureReason` is set. After G3 the reason survives only real failures, but a session that worked for hours and then died with a limit screen up still did not fail *to start*. |
| **M1** — handle `session_phase` frames (`{ sessionId, phase, updatedAt }`) and merge `phase` into the cached session's `subStatus`. | F-134 | The streamer has sent it since phase detection shipped. No `session_phase` handler exists in `tb-mobile/{services,hooks,stores,components,types,lib,app}`, so Codex phase labels only appear after an unrelated `session_update` or a REST refetch. |
