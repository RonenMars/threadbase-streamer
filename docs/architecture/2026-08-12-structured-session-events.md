# Structured Session Events

**Date:** 2026-08-12
**Status:** Proposed
**Scope:** tb-streamer (session runtime, WS contract), tb-mobile (state derivation), tb-scanner (conversation model)

---

## Problem

The streamer drives each agent as a terminal application and recovers its state by parsing what that terminal painted. A TUI is a *rendering* of a structured event stream, so every state we report is the lossy inverse of something the vendor already computes — and we compute it a second time, from pixels, with no schema and no contract.

This is not an abstract concern. It is the shared cause of an entire class of defect, and the cost is visible in the amount of code that exists only to undo rendering:

| Subsystem | Repo | Exists only because we parse a rendering |
|---|---|---|
| `services/questions/detectPermissionGate.ts` | streamer | recover "a gate is open" from a footer + option block |
| `services/questions/detectShellPrompt.ts` | streamer | recover an unstructured prompt from the rendered tail |
| `codexScreenShowsReady` / `codexScreenBlocksComposer` (`src/codex-pty-runner.ts:195-221`) | streamer | recover "is the agent busy" from a status-bar word |
| `lib/terminalChrome.ts` | mobile | strip the chrome so the transcript reads as text |
| `utils/parseQuestionBlock.ts` | mobile | recover a question from rendered option rows |
| `lib/renderConfidence.ts` | mobile | report how much to *trust* the parse |

`renderConfidence` is the tell. It exists to tell a user that the client is unsure it read the screen correctly, which is only a meaningful thing to say when the screen is the source of truth.

### The state we publish is constructed, not observed

`SessionStatus` is `running | waiting_input | idle` (`src/types.ts:9`). `running` is set when the streamer *writes bytes* — at spawn (`src/pty-manager.ts:363`, `:448`, `statusSource: "spawn"`) and on input (`:486`, `:531`, `statusSource: "user-input"`). It is never set by observing the agent do anything. The session leaves `running` only when a prompt marker is matched, or when a timer expires (`markReady`, `src/pty-manager.ts:1176`).

We were honest enough about this to record it: `StatusSource` distinguishes `prompt-marker` from `timeout-fallback` and `quiet-fallback`, and `confidenceForSource` (`src/types.ts:56`) maps the two timer paths to `inferred` rather than `observed`. So one `running` currently covers all of: the model reasoning, tokens streaming, a tool executing, the process booting, a gate blocking on the user, and a wedged TUI. Nothing on the wire separates them.

### Measured fragility, 2026-08-12

Two live Claude turns and two live Codex turns were captured off a running streamer and replayed frame by frame. Every one of the following broke a rule that looked correct when written:

- **Chunks are differential repaints.** 48–70 bytes carrying one spinner glyph and a digit or two of a counter. Per-chunk text is unusable; only the rendered grid carries meaning.
- **The turn verb is randomized.** `Worked for 5s`, `Brewed for 5s`, `Moseying…`, `Roosting…` all observed from one session. Any rule matching the word breaks between two consecutive turns.
- **`❯` is the composer and is always on screen.** Treating it as an idle marker reported the turn finished three times mid-response.
- **A frame sampled mid-repaint is torn.** The status line is present but its closing paren is not yet painted, so absence of a marker is not evidence of absence.
- **Claude repaints the status line via absolute `CSI H`,** targeting rows ~31-40. Codex repaints its status bar at the bottom.
- **Codex's `Working` never clears under Claude's rules.** `• Working (5s • esc to interrupt)` satisfies a Claude in-progress marker while Codex paints no `<verb> for <N>s` line, so an end-of-turn match never fires.

Each of these is individually fixable. The pattern is that fixing them individually produces the next one, because the input is a picture of the state rather than the state.

## What the providers already expose

Both vendors publish the stream their own TUI renders. Verified 2026-08-12.

### Codex

`codex app-server` (marked `[experimental]` in `codex-cli 0.147.0 --help`) speaks JSON-RPC 2.0 over stdio, and self-describes: `codex app-server generate-json-schema --out <dir>` emits 39 schema files, 191 definitions. The relevant notifications:

| Notification | Carries |
|---|---|
| `TurnStartedNotification` / `TurnCompletedNotification` | turn boundaries, with `threadId` and a `Turn` |
| `ReasoningTextDeltaNotification`, `ReasoningSummaryTextDeltaNotification` | the reasoning phase, streamed |
| `AgentMessageDeltaNotification` | assistant text, streamed |
| `ItemStartedNotification` / `ItemCompletedNotification` | tool-call lifecycle |
| `CommandExecutionOutputDeltaNotification` | live command output |

Every delta carries `threadId` **and** `turnId`, so attribution to a turn requires no inference. It also ships the enum this design needs: `TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"`.

### Claude Code

Two channels, with different costs:

- **Hooks** fire once per turn and work with the *interactive* CLI, so they cost no architectural change: `UserPromptSubmit` (before Claude processes the prompt), `Stop` (Claude finished responding), `StopFailure` (turn ended on an API error), plus `SessionStart` / `SessionEnd` per session.
- **`--output-format stream-json` with `--include-partial-messages`** yields `thinking_delta` and `text_delta`, which is the reasoning-versus-writing distinction. It requires `--print`, which this server never passes — the same constraint that made `--max-budget-usd` a silent no-op and got it removed from the flag registry.

The symmetry across providers is the important part: **turn boundaries are available without giving up the terminal, and intra-turn phase is not.** That is not a coincidence. The TUI is a rendering of the stream, and the structure is exposed when you ask for the stream instead of the rendering.

## Design

A provider-agnostic session event model becomes the source of truth. The terminal becomes one optional view of it rather than the channel state is recovered from.

```
Claude (SDK / hooks) ─┐
                      ├─> runner adapter ─> domain events ─> WS ─> clients
Codex (app-server)  ──┘                          │
                                                 └─> durable log ─> history
```

### The event model

Normalized, provider-independent, and the only thing a client consumes:

`TurnStarted`, `Reasoning(delta)`, `Message(delta)`, `ToolCallStarted`, `ToolCallCompleted`, `PermissionRequested`, `PermissionResolved`, `TurnCompleted(status)`, `UsageLimited`, `Error`.

Both providers map onto this nearly mechanically, which is the evidence that it is the right seam rather than an invention of ours.

### Where each repo lands

**tb-streamer** already has the shape. `SessionRunner` is an interface with provider-keyed implementations, and `MULTI_AGENT_FLOW` is precedent for a runner that is not a PTY. This adds `SdkRunner` (Claude) and `AppServerRunner` (Codex) beside `PtyRunner`, and demotes PTY to the compatibility runner. `SessionStatus` stops being constructed: `running` becomes a consequence of `TurnStarted`, not of us having written bytes.

**tb-mobile** stops emulating a terminal in order to know things. Chat renders domain events; the terminal view keeps raw bytes as a fidelity view. The client-side derivation stack goes away rather than being repaired.

**tb-scanner** becomes the historical projection of the same model. Today live state and history are two independent derivations — a screen scrape and a JSONL tail — that can and do disagree. One model for both removes that class of drift.

### Runners are interchangeable over a conversation

This is what makes the migration incremental rather than a rewrite. Claude `--resume` appends to the same `<conversationId>.jsonl` and keeps the same `sessionId` field (verified against Claude Code v2.1.215, recorded in `CLAUDE.md`), and Codex threads behave equivalently. The conversation is the durable artifact; a runner is a way of advancing it. A session can therefore hand off between a PTY runner and a structured runner without losing history, and a provider can migrate one at a time.

## Costs

These are the decisions, and they are not all technical.

**1. The live-TUI-on-two-devices property.** Today a phone attaches to the same terminal session you can walk back to your desk and keep typing in. A structured runner means the agent is not a terminal session, and the handoff costs a restart. This is a product decision about what the streamer *is*, and it should be made explicitly rather than fallen into.

**2. Feature lag.** The TUI gets capabilities first. `PATCH /api/sessions/:id/model` currently works by typing `/model <x>` into a live PTY (`src/api/routes/`, see `CLAUDE.md` "Model & effort") because there is no other channel. That mechanism has no structured equivalent yet.

**3. Surface stability.** `codex app-server` is `[experimental]`; its sibling `codex mcp-server` is not. Claude's Agent SDK is stable, but the partial-message events are newer than the rest of it.

**4. Two runners is a real maintenance cost.** Keeping PTY as a fallback doubles the compatibility matrix for as long as both exist. The migration should have a defined end, not an indefinite dual-track.

**5. Released clients cannot be force-updated.** Every wire change is additive: new event types alongside `terminal_output`, which keeps flowing. See `docs/compatibility/tb-mobile.md`.

## Sequencing

1. **Claude turn boundaries via hooks.** Small, stable, no architectural change, and it replaces `timeout-fallback` guessing with ground truth. The first piece of session state that stops being inferred.
2. **`AppServerRunner` for Codex as the pilot.** Its protocol is richer and better specified than its status bar, it is self-contained, and it validates the event model against a real provider before Claude's larger surface.
3. **Fix the event model from those two,** and publish it additively on the WS contract.
4. **Then decide the TUI question** with a working structured runner in hand, rather than in the abstract.

## Known limits

Intra-turn phase (reasoning versus writing) is not obtainable on Claude without a headless runner. A screen-scraped approximation was built and withdrawn on 2026-08-12: it read the rendered grid tail, which works only while the grid is shorter than roughly 46 rows, and the client seeds that grid with the replayed transcript before any live frame lands. Measured against real captures, it produced the full phase timeline at seeds of 0/20/35 lines and **no transitions at all** at 41/45/60/100. It is recorded here so the approach is not re-attempted without that constraint in hand.

## Reference

- Issue (streamer): https://github.com/RonenMars/threadbase-streamer/issues/535
- Issue (mobile): https://github.com/RonenMars/threadbase-mobile/issues/649
- Issue (scanner): https://github.com/RonenMars/threadbase-scanner/issues/64
- `docs/architecture/2026-07-24-durable-session-runtime.md` — the runner/lifecycle model this builds on
- `docs/compatibility/tb-mobile.md` — the additive-only constraint
- `docs/multi-agent-mode.md` — existing precedent for a non-PTY runner
