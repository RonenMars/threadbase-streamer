# Concurrent access to a live session — client contract

**Status:** describes existing behavior (2026-09-18); nothing changed by this doc.

A session managed by the streamer can be reached two structurally different ways while it is live. They have opposite safety profiles.

## Another WebSocket client (safe — the supported path)

Opening the same session from a second Threadbase client — web, another mobile device, a second tab — just adds another subscriber to the same PTY. `ws-hub.ts` unicasts a `terminal_replay` (from the 64KB ring buffer) to the new subscriber on connect, then both clients receive the same `terminal_output` / `session_update` broadcasts going forward. No JSONL is touched twice, no busy check runs, no `409`.

Two consequences to be aware of, not protected against:

- **Every subscriber is a peer, not a read-only viewer.** If two clients send input at once, keystrokes interleave into the same PTY — a UX problem, not a data-corruption one.
- **A WebSocket disconnect arms nothing.** Switching from one client to another (or losing connectivity on one) never kills the session — see "Grace/hold" in the Session lifecycle section above. Only an explicit `hold_session` message starts the grace-kill timer.

## A second process outside the streamer (unsafe for Claude, refused for Codex, unverified for Cursor)

This is different: running `claude --resume`, `codex resume`, or `cursor-agent resume` directly in a terminal, on the same or a different machine, while the streamer's own PTY already owns that conversation.

- **Claude Code**: no protection. Claude has no writer lock — two `claude --resume` processes on the same conversation both append to the same JSONL and neither complains. This is exactly why the streamer's own `POST /api/sessions/resume` runs a heuristic busy check (`services/sessions/conversationBusy.ts`: JSONL mtime within `RESUME_BUSY_WINDOW_MS`, a discovered process resuming the same id, or a discovered process in the same project dir) — but that check only guards the streamer's own resume path. A raw CLI invocation bypasses it entirely: "a one-directional pre-flight guard — nothing stops an external terminal attaching after the streamer holds the PTY."
- **Codex**: Codex enforces a single writer per rollout itself, so a second `codex resume` is refused by Codex (`already has an active writer (code -32600)`), not silently corrupted. The streamer surfaces this as `409 CONVERSATION_BUSY` / `reasonCode: "CODEX_SESSION_ACTIVE"` when going through its own API; `force` cannot bypass it since the lock is Codex's, not the streamer's heuristic. Recovery is `POST /api/sessions/:id/fork`, a genuinely separate conversation. Full contract: [docs/compatibility/codex-collision-and-fork.md](codex-collision-and-fork.md).
- **Cursor**: not verified. No writer-lock behavior for `cursor-agent resume` is documented here yet — check against the current `cursor-cli` before relying on either outcome.

See "Resume is collision-checked" and "Codex resume is authoritative, not optimistic" in the Session lifecycle section of the top-level `CLAUDE.md` for the mechanics behind the busy check.
