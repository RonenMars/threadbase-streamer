# Milestone B — Multi-agent mode for tb-streamer

**Shipped:** 2026-06-04
**PRs:** [#17 — multi-agent wiring](https://github.com/RonenMars/threadbase-streamer/pull/17), [#18 — Plan 3.5 HTTP endpoints](https://github.com/RonenMars/threadbase-streamer/pull/18)
**Squash commit on main:** `1316f4a`

## What shipped

Multi-agent mode is a new runtime path in tb-streamer, gated behind the `MULTI_AGENT_FLOW` env var. When the flag is OFF (the default), tb-streamer behaves exactly as before — PTY-driven Claude Code sessions are unchanged. When the flag is ON, the same HTTP and WebSocket surface is served, but user input is routed to a Temporal-orchestrated worker (see the companion repo `threadbase-multi-agent-orchestration`) instead of node-pty.

The two modes are mutually exclusive within a process. There is no fallback between them at runtime; the flag is read once at startup.

## Why it matters

PTY mode binds Threadbase to whatever Claude Code's interactive terminal can do. Multi-agent mode lets us:

- Run a worker → reviewer → sign-off pipeline per turn, with structured stages instead of "free-form terminal output."
- Persist conversation history as JSONL on the streamer (still the source of truth) but compose signals to the worker from that durable record, not from in-memory state.
- Replace the LLM provider in the worker without touching the streamer, the mobile app, or the wire format.
- Observe turn-level metrics that don't exist in PTY mode (input/output tokens, durations, reviewer overrules, rework attempts).

## User-visible changes

For mobile clients and any external consumer of tb-streamer's HTTP/WS surface:

- **`POST /api/sessions/start`** — request body may be empty `{}`. Response shape (`{sessionId, conversationId, status}`) is unchanged from PTY mode.
- **`POST /api/sessions/:id/input`** — accepts `{text: string}`. Returns `{turnId, status: "queued"}` immediately; turn progress arrives over the WebSocket.
- **`POST /internal/sessions/:id/progress`** — new internal endpoint, HMAC-signed via `X-Progress-Signature`. Receives stage transitions and assistant output from the worker. Not for client consumption.
- **WS message shapes are additive** — existing `session_update` and `agent_output` messages gain optional `stage`, `reworkAttempt`, and `turnId` fields. Existing single-turn consumers ignore them safely.

When `MULTI_AGENT_FLOW` is unset, none of these endpoints' behavior changes is observable — clients see exactly what PTY mode produced before.

## Operator-facing additions

- **CLI flag** `--multi-agent-flow` on `threadbase-streamer serve` (or `MULTI_AGENT_FLOW=true` in env).
- **Required env when the flag is on:** `PROGRESS_HMAC_SECRET` (shared with the worker), `TEMPORAL_ADDRESS` (defaults to `localhost:7233`), `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`.
- **Payload-size guard** at 1.5 MB per signal (75% of Temporal's 2 MB single-payload ceiling). The streamer refuses input with `SESSION_HISTORY_FULL` (HTTP 413) before the worker even sees it. Trajectory warnings log every 5 turns starting at turn 20.
- **Session-busy semantics:** if a turn is already in flight, a second `POST .../input` returns 429 with `retryAfterMs` (default 1000 ms). Two-layer race defense: HTTP check at ingress + orchestrator queue downstream.
- **Conversation storage** — `~/.threadbase/conversations/<sessionId>.jsonl`, same path as PTY mode. Both modes write the same JSONL shape so the cache, search, and mobile history work uniformly.

## Breaking changes

**None.** PTY mode is unchanged when `MULTI_AGENT_FLOW` is off (the default).

## Migration notes

- Existing PTY-mode deployments don't need any changes. The prod launchd plist stays as-is.
- To run a process in multi-agent mode, add `MULTI_AGENT_FLOW=true` and `PROGRESS_HMAC_SECRET=…` to the env, and run a worker (see the `threadbase-multi-agent-orchestration` repo) against the same secret.

## Architecture, in one paragraph

A streamer process in multi-agent mode owns the HTTP/WS surface and the JSONL conversation store. User input becomes a Temporal signal sent to a long-lived per-session orchestrator workflow, which dispatches a child turn workflow per message. The turn workflow calls `processTask` (LLM call) and `reviewTask` (reviewer LLM call), and emits HMAC-signed progress webhooks back to the streamer at each stage transition. The streamer broadcasts those events to mobile clients over WebSocket and persists the final answer to JSONL — the round-trip closes when the streamer writes the assistant turn and the orchestrator releases the session lock.

## Deferred to Milestone C

The Plan 3.5 brainstorm panel identified that the current approach of embedding full conversation history in every `UserInputSignal` will hit Temporal's hard limits (2 MB single-payload, 4 MB Event History transaction, 50 MB total per workflow) on long conversations. The payload-size guard above is a deliberate fail-fast — it surfaces the problem with a structured error instead of letting the workflow blow up. The actual redesign (deltas-only signals + workflow-held conversation state) is documented in the spec and is the focus of Milestone C.

## Notable fixes inside this milestone

- **HMAC body-read fix** — Hono's `c.req.arrayBuffer()` returns 0 bytes when the request arrives through `@hono/node-server`, so the streamer was hashing empty bytes and rejecting every webhook with 401. Now reads from the underlying Node `IncomingMessage` stream (mirrors `/api/__update`), falls back to `arrayBuffer()` in the in-memory test harness where `c.env.incoming` is absent.
- **CI fix** — `tb-streamer` CI now builds the `vendor/agent-types` submodule before running typecheck, so `@threadbase/agent-types` resolves correctly in CI.

## How to verify

The end-to-end smoke covered in `docs/superpowers/specs/2026-06-04-plan-3.5-multi-agent-ws-wiring.md` exercises: session create → user input → worker call to Anthropic → progress webhooks → WebSocket broadcast → JSONL write. Final smoke run (2026-06-04) was green: all 10 progress webhooks returned 200, JSONL was written with the assistant's response.

## Testing

73 test files, **548 passed, 4 skipped, 0 failures** on the merged main as of 2026-06-04.
