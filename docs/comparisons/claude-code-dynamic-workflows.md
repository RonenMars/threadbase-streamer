# @threadbase-sh/streamer multi-agent mode vs. Claude Code dynamic workflows

A reference for anyone wondering how [Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) relate to this server's `--multi-agent-flow` mode.

## PTY mode isn't comparable

The streamer's default mode spawns a `claude` Code session inside a PTY and streams its terminal I/O over WebSocket. Dynamic workflows are a *runtime feature inside* a Claude Code session — exactly the kind of session PTY mode hosts. Asking whether dynamic workflows could replace PTY mode is a category error: dynamic workflows don't host processes, broadcast to WebSocket clients, cache conversation history, or pair mobile devices. PTY mode just keeps relaying terminal output while Claude does whatever it does inside the session, dynamic workflows included.

The interesting comparison is with the *other* mode.

## What multi-agent mode is

When `--multi-agent-flow` (or `MULTI_AGENT_FLOW=true`) is set, the streamer stops routing user input through `node-pty` and instead hands each turn off to a Temporal-orchestrated pipeline in [`tb-multi-agent`](../../../tb-multi-agent/). One `session-<id>` orchestrator workflow runs per session, spawning `turn-<id>` child workflows per user message; activities call Claude and webhook the streamer when results land. PTY mode is unreachable from a multi-agent-mode process.

See [`docs/multi-agent-mode.md`](../multi-agent-mode.md) for the full mode reference (env vars, failure modes, links to the design spec).

## What Claude Code dynamic workflows are

A runtime feature inside an interactive Claude Code session. When triggered, Claude writes throwaway orchestration scripts that fan out tens-to-hundreds of parallel subagents in one session, with verification loops, adversarial cross-checking, progress checkpointing, and iterative convergence. Triggered by a developer in the CLI (or by the `ultracode` setting at effort `xhigh`).

## Short comparison

| Dimension | Claude Code dynamic workflows | Streamer multi-agent mode |
|---|---|---|
| **Trigger** | Developer in a Claude Code session | HTTP turn from a streamer client (web/mobile) |
| **Orchestrator** | Claude-written scripts, scoped to one session | Temporal workflows (`session-<id>` + `turn-<id>` children) |
| **Durability** | Session-scoped checkpoint/resume | Event-sourced; survives streamer + worker crashes |
| **Result delivery** | In-session output | Signed webhook back to the streamer → WebSocket fan-out |
| **Best for** | One-off deep analysis in a developer's session | Reliably processing every user turn from a hosted client |

For the full comparison (retry policy, multi-tenancy, cost profile, observability, "could one replace the other"), see [`tb-multi-agent/docs/comparisons/claude-code-dynamic-workflows.md`](../../../tb-multi-agent/docs/comparisons/claude-code-dynamic-workflows.md). The streamer is the *front door* in multi-agent mode; the Temporal pipeline that does the orchestration lives in `tb-multi-agent`, and that's where the deep table belongs.

## What's streamer-specific in this mode

Things that change at the streamer boundary when `--multi-agent-flow` is on — these aren't covered by the tb-multi-agent doc:

- **Request path.** User input no longer reaches `PTYManager`. It's converted into a Temporal signal/start against the `agent-tasks` queue.
- **Result path.** Activities call back via signed webhook (see `tb-multi-agent/signed-http-webhook-guide.md`); the streamer relays each event over the existing WebSocket layer. Clients don't see `terminal_output` — they see structured turn events.
- **Per-session dedupe.** An in-memory dedupe map suppresses duplicate webhook deliveries from Temporal activity retries. Cleared on streamer restart, so expect at most one duplicate UI event per in-flight retry across a restart. Durable-dedupe upgrade path: `tb-multi-agent/docs/plans/postgres-dedupe.md`.
- **Reachability.** The streamer must reach Temporal to start workflows; the worker must reach the streamer to deliver webhooks. If the webhook hop fails, the answer is still queryable via Temporal (`getSessionStage`) and the frontend reconciles on WebSocket reconnect.
- **What `IdleSweeper` and `reconcile.ts` do.** Nothing for multi-agent sessions — they target PTY-managed sessions. Multi-agent session liveness lives in Temporal.

## References

- Multi-agent mode reference: [`docs/multi-agent-mode.md`](../multi-agent-mode.md)
- Full pipeline comparison: [`tb-multi-agent/docs/comparisons/claude-code-dynamic-workflows.md`](../../../tb-multi-agent/docs/comparisons/claude-code-dynamic-workflows.md)
- Claude blog post: <https://claude.com/blog/introducing-dynamic-workflows-in-claude-code>
