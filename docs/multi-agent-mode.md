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
