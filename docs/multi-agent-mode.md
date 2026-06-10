# Multi-agent mode

When `--multi-agent-flow` (or `MULTI_AGENT_FLOW=true`) is set, tb-streamer routes user input through a Temporal-orchestrated multi-agent pipeline instead of the node-pty Claude Code session. PTY mode is unreachable from a multi-agent-mode process.

To compare the two modes side by side, run two tb-streamer processes on different ports — one with the flag, one without.

## Required services

Multi-agent mode requires a Temporal server and a `tb-multi-agent` worker process. For local dev:

```bash
# Terminal 1: Temporal dev server
temporal server start-dev --ui-port 8233

# Terminal 2: tb-multi-agent worker
cd ../tb-multi-agent
npm run worker

# Terminal 3: tb-streamer in multi-agent mode
cd ../tb-streamer
MULTI_AGENT_FLOW=true PROGRESS_HMAC_SECRET=shared-dev-secret \
  ANTHROPIC_API_KEY=... \
  npm run dev -- --multi-agent-flow --port 3456
```

`PROGRESS_HMAC_SECRET` MUST match between the two processes — set it in both `.env` files.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MULTI_AGENT_FLOW` | (unset) | Set to `true` (or use `--multi-agent-flow`) to enable. |
| `PROGRESS_HMAC_SECRET` | `dev-secret-change-me` | Shared secret with the worker. Match both processes. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `TEMPORAL_TASK_QUEUE` | `agent-tasks` | Task queue both processes use. |
| `PROGRESS_DEDUPE_CAPACITY` | `1024` | Per-session LRU size for event dedupe. |
| `PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS` | `300` | Reject events with timestamps outside this skew. |
| `AGENT_PAYLOAD_LIMIT_BYTES` | `1572864` | Threshold for the `SESSION_HISTORY_FULL` guard (1.5 MB, 75% of Temporal's 2 MB ceiling). Returns HTTP 413 with `code: SESSION_HISTORY_FULL` when exceeded. |
| `AGENT_TRAJECTORY_LOG_BYTES` | `512000` | Byte threshold that triggers a WARN log trajectory entry independently of turn count. |
| `AGENT_TRAJECTORY_LOG_TURNS` | `20` | First turn count at which to emit trajectory WARN logs, then every 5 turns. |
| `AGENT_SESSION_BUSY_RETRY_MS` | `1000` | `retryAfterMs` value returned in 429 `SESSION_BUSY` responses. |

## Runtime API (Plan 3.5)

When `MULTI_AGENT_FLOW=true`, the PTY-oriented endpoints route to the multi-agent path:

- `POST /api/sessions/start` accepts `{}` (new conversation) or `{conversationId: string}` (resume). Returns 200 with `{sessionId, conversationId, status: "running"}`. For a new conversation, `conversationId` equals `sessionId`; on resume, `conversationId` is the supplied existing one while `sessionId` is freshly generated.
- `POST /api/sessions/:id/input` accepts `{text: string}`. Returns 202 with `{turnId, status: "queued"}` on success.
- Both endpoints emit structured error responses `{error, code}` where `code` is one of the values defined in `src/agent/errors.ts`: `SESSION_NOT_FOUND`, `SESSION_HISTORY_FULL`, `SESSION_BUSY`, `INVALID_SESSION_STATE`, `CONVERSATION_NOT_FOUND`, `INPUT_REQUIRED`, `INVALID_BODY`, `TEMPORAL_UNAVAILABLE`, `NOT_APPLICABLE_IN_MULTI_AGENT_MODE`, `INTERNAL_ERROR`. Existing PTY endpoints continue to return unstructured `{error}` only (retrofit deferred — see `tb-multi-agent/docs/plans/structured-error-codes-retrofit.md`).
- **429 `SESSION_BUSY`** is returned when a turn is already in flight for that session; the response body carries `retryAfterMs` (default 1000). Mobile clients should retry after the hint.
- **413 `SESSION_HISTORY_FULL`** is returned when the composed `UserInputSignal` exceeds the configured payload limit (default 1.5 MB, 75% of Temporal's 2 MB ceiling). The mobile app should branch on this code to prompt "start a new conversation."

Internal: `session.currentTurnId` (on `ManagedSession`) is set when an input POST acquires the lock and cleared by the webhook receiver when `stage=done` or `terminal_failure` fires for the matching turn. Two-layer race defense: the HTTP-level 429 check plus the orchestrator's signal-queue serialization (milestone B spec §7.2).

Full design and decision rationale: `tb-multi-agent/docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md`.

## Wire endpoints

- `POST /internal/sessions/:sessionId/progress` — worker → tb-streamer progress webhook. HMAC-signed via `X-Progress-Signature`. Bypasses Bearer auth (HMAC-only).
- Existing WebSocket protocol — augmented with `session_update.stage`, `session_update.stalledSinceMs`, plus two new event types: `agent_output` and `turn_failure`. All additive — old clients ignore unknown fields.

## Smoke test

With all three processes running, send a user input via the WebSocket as you would in PTY mode. Watch:

- tb-streamer logs show one `POST /internal/sessions/:sessionId/progress` per stage transition.
- The Temporal UI at `http://localhost:8233` shows one `session-<id>` orchestrator workflow with one or more `turn-<id>` children.
- The WebSocket emits `session_update` events with stage transitions and `agent_output` blocks per agent.

## Failure modes

- **Worker can't reach tb-streamer.** Webhook fails silently. Final answer is still queryable via Temporal (`getSessionStage`). The frontend reconciles state on WS reconnect.
- **tb-streamer can't reach Temporal.** Server logs the connection error. `MULTI_AGENT_FLOW` requires Temporal — start it before tb-streamer.
- **HMAC misconfig.** Webhook receiver returns 401. Worker logs the 401 and gives up after its retry window. No events reach the UI.
- **tb-streamer restart.** Per-session dedupe map is empty on restart; one duplicate UI event per in-flight Temporal activity retry. See `tb-multi-agent/docs/plans/postgres-dedupe.md` for the durable-dedupe upgrade path.

## Architecture context

- Spec: `tb-multi-agent/docs/superpowers/specs/2026-06-03-tb-multi-agent-mode-design.md`
- Webhook transport: `tb-multi-agent/signed-http-webhook-guide.md`
- Deferred upgrades: `tb-multi-agent/docs/ROADMAP.md`
