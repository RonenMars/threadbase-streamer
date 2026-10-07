# Provider session states

How the streamer decides that a live session is `running`, `waiting_input` or `idle`, for each of the four coding-agent CLIs it drives: Claude Code, Codex, Cursor and Copilot CLI.

This document covers status only.
How a gate or question is parsed into a card is described in the sibling document on question parsing; here a card matters only for what it does to status.

## Reading this document

Code is the authority, and every behavioural claim cites `path:line` plus a greppable anchor in backticks, because line numbers drift.
Line numbers were read on 2026-10-06 against these trees:

| Tree | Commit | Used for |
|---|---|---|
| `main` | `58352e8d` | Claude Code, Codex, Cursor, shared machinery |
| Copilot branch (unmerged) | `abe0f7d4` | Copilot CLI only |
| `fix/provider-turn-state` (unmerged) | `d99041e4` | Pending changes, always labelled as pending |

Each claim carries an evidence tag:

- **[code]** — read in the source at the cited line.
- **[code, branch]** — read in the source of an unmerged branch.
- **[code, derived]** — follows from the cited code by reasoning, but no test or capture reproduces it.
- **[doc]** — stated in an existing repository document, not re-read in code here.
- **[transcript, date]** — reported in an earlier investigation and not re-checked here against a live CLI.
- **[unknown]** — nobody has established it.

## 1. Overview

### 1.1 The shared vocabulary

A live session has exactly one of three statuses: `running`, `waiting_input`, `idle` (`src/types.ts:11`, `SessionStatus`). **[code]**

- `running` — the agent is assumed to be working, or the process is still booting.
- `waiting_input` — the agent is at its prompt and the next move is the user's.
- `idle` — there is no PTY; the process exited or the streamer put it on hold.

Every transition also records how it was derived, in `statusSource` (`src/types.ts:54`, `StatusSource`). **[code]**

| `statusSource` | Meaning | Confidence |
|---|---|---|
| `spawn` | Initial state at process start | observed |
| `prompt-marker` | A provider prompt marker appeared in the stream | observed |
| `screen-marker` | The marker was found by re-reading the rendered screen | observed |
| `turn-signal` | The provider signalled a turn started late, or ended | observed |
| `user-input` | The streamer wrote input, so the session is running by construction | observed |
| `process-exit` | The process exited | observed |
| `shutdown` | The streamer terminated the PTY (hold) | observed |
| `timeout-fallback` | No marker appeared; a timer elapsed | inferred |
| `quiet-fallback` | The PTY fell silent; the runner assumed | inferred |

Confidence is computed from the source, never stored (`src/types.ts:78`, `confidenceForSource`). **[code]**

### 1.2 Machinery every runner shares

One runner class per provider implements `SessionRunner`, and `LiveSessionManager` routes by provider (`src/live-session-manager.ts`, `new PTYManager(options)`). **[code]**

- **Spawn state.** Every runner creates the session as `status: "running"`, `statusSource: "spawn"` (`src/pty-manager.ts:391`, `src/codex-pty-runner.ts:263`, `src/cursor-pty-runner.ts:157`). **[code]**
- **Geometry and screen.** The PTY is 120×40 and each session owns a headless xterm that renders the stream, so detectors read the screen a user would see rather than raw bytes (`src/pty-shared.ts:18`, `PTY_COLS`; `src/pty-shared.ts:162`, `createScreen`). **[code]**
- **Boot gating.** Claude, Codex and Cursor keep a `pendingReady` set and a `queuedInputs` map: input sent before the first readiness is queued, not written (`src/pty-manager.ts:580`, `src/codex-pty-runner.ts:474`, `src/cursor-pty-runner.ts:237`). **[code]**
- **One funnel to `waiting_input`.** Each of those three runners has a single `markReady(sessionId, session, source, reason)` that sets `waiting_input`, records the source, and on the first call flushes the queue and fires `onReady` (`src/pty-manager.ts:1491`, `src/codex-pty-runner.ts:1248`, `src/cursor-pty-runner.ts:531`). **[code]**
- **Quiet re-check.** Each of those three re-runs detection 500 ms after the last chunk, because a blocked TUI may never emit another one (`QUIET_DETECT_MS = 500` at `src/pty-manager.ts:101`, `src/codex-pty-runner.ts:68`, `src/cursor-pty-runner.ts:31`). **[code]**
- **Input flips to `running`.** `sendInput` and `sendKeys` move `waiting_input → running` with `statusSource: "user-input"`; `sendRawKeys` (navigation keys) never changes status (`src/pty-manager.ts:515`, `:558`, `:601`). **[code]**
- **Exit.** `handleExit` sets `idle` / `process-exit` for any exit code, and diagnoses an instant failure (non-zero exit, under 2 s, no output) as `project_dir_missing` or `instant_exit` (`src/pty-manager.ts:1534`, `src/codex-pty-runner.ts:1332`, `src/cursor-pty-runner.ts:560`). **[code]**
- **Hold.** `putOnHold` kills the PTY and sets `idle` / `shutdown` (`src/pty-manager.ts:761`, `src/codex-pty-runner.ts:697`, `src/cursor-pty-runner.ts:367`). **[code]**

### 1.3 What the server does with a status change

Every runner reports through one `onStatusChange` callback (`src/server-wiring.ts:473`). **[code]**

- It mirrors `status`, `statusSource`, `statusUpdatedAt`, `failureReason` and `failureCode` into `SessionStore`, records the transition in the durable registry, and emits on the status bus (`src/server-wiring.ts:617`, `sessionStatusBus.emit`). **[code]**
- **Start request.** `POST /api/sessions/start` waits up to `START_READY_TIMEOUT_MS` (10 000) for the first settle: `waiting_input` answers 200, `idle` answers 502 with the failure reason, a timeout answers 202 pending (`src/api/handlers/sessions.handlers.ts:118`; `src/server.ts:3043`, `waitForStartupOutcome`). **[code]**
- **Lifecycle.** With no PTY attached, `statusSource: "shutdown"` reads as `resumable` and a recorded `failureReason` reads as `failed` (`src/session-store.ts:304`, `lifecycle:`). **[code]**
- **Grace hold.** An explicit `hold_session` arms a timer (default `DEFAULT_PTY_GRACE_PERIOD_MS`, 270 000); a `running` session defers it, up to `GRACE_MAX_DEFERS` (4) times, then is held anyway (`src/server.ts:180`, `:186`, `:1321`). **[code]**
- **Idle reaper.** Every `IDLE_REAP_SWEEP_MS` (5 min) a PTY silent for `IDLE_REAP_AFTER_MS` (6 h) is held, and a `running` session is always skipped (`src/server.ts:198`, `:201`, `:1272`). **[code]**

### 1.4 What decides a "finished" push

`WaitingInputNotifier` listens to the same funnel (`src/services/push/waitingInputNotifier.ts:199`, `onStatusChange`). **[code]**

- A turn opens on `waiting_input → running` (`:206`, `openTurn.set`). **[code]**
- The first `waiting_input` of a session (boot or resume) opens nothing, so it never notifies (`:237`, `skip_no_open_turn`). **[code]**
- "Finished" is scheduled only when the closing transition has `statusSource === "turn-signal"`; any other source logs `skip_unconfirmed_end` and sends nothing (`:242`). **[code]**
- The push waits `TURN_DONE_SETTLE_MS` (2 000) and is cancelled if the session leaves `waiting_input` or a gate or question opens (`:70`, `:203`, `:296`). **[code]**
- A session that goes `idle` with a `failureReason` before ever reaching `waiting_input` gets one "failed" push (`:224`). **[code]**

The consequence that drives most of this document: **a provider whose runner cannot emit a `turn-signal` end can never send "finished".**

## 2. Claude Code

Runner: `PTYManager` in `src/pty-manager.ts`.

### Boot/readiness signal

- A prompt marker in a chunk, `╭` or `❯`, settles boot as `prompt-marker` (`:64`, `CLAUDE_PROMPT_MARKERS`; `:960`). **[code]**
- On quiet, the rendered screen is re-read for the same markers and settles as `screen-marker` (`:1400`, `recheckReadyFromScreen`; `:1435`). **[code]**
- Silence alone never settles boot, because `--resume` replays the transcript and can sit quiet for seconds before the TUI reads stdin (`:1270`, `pendingReady.has`). **[code]**

### Turn-start signal

- `sendInput` flips to `running` / `user-input` and calls `openTurnOnSubmit` (`:601`, `:610`, `:1359`). **[code]**
- If the session has ever emitted a turn signal (`progressSeen`), the turn is opened optimistically as `submitted` (`:1361`, `:1363`). **[code]**
- The provider's own busy signal is the terminal title (OSC 0 or 2) carrying a spinner glyph `◐ ◓ ◑ ◒`, or OSC 9;4 with a non-zero state (`:79`, `CLAUDE_TURN_SIGNAL_RE`; `:1312`, `trackProgress`). **[code]**
- A busy signal moves the open turn to `working` (`:1337`). **[code]**
- OSC 9;4 is parsed but, per the code comment and its fixture, Claude Code 2.1.280 never emits it into the streamer's PTY (`:73`; `__tests__/turn-signal-replay.test.ts:70`). **[code]**

### Turn-end signal

- An idle signal — title glyph `✳`, or OSC 9;4;0 — moves a `working` turn to `ending`; it does not settle the session by itself (`:1337`). **[code]**
- The end is settled on the next quiet check: if no gate is on screen, the turn closes and `markReady` runs with `turn-signal` (`:1405`, `:1429`). **[code]**
- While any turn is open, prompt markers are ignored, because the `❯` input box stays painted for the whole turn (`:960`, `!this.turnOpen.has`; `:1434`). **[code]**
- An idle signal on a turn still `submitted` is ignored, so a title repaint cannot pass for a turn that never began (`:1334`). **[code]**

### Fallbacks and timers

| Constant | Value | Role | Cite |
|---|---|---|---|
| `QUIET_DETECT_MS` | 500 ms | Re-run readiness and prompt detection after the last chunk | `:101` |
| `CLAUDE_READY_FALLBACK_MS` | 8 000 ms | Flat boot backstop, armed at spawn; settles as `timeout-fallback` | `:130`, `:1445` |
| `TURN_START_GRACE_MS` | 3 000 ms | How long a `submitted` turn waits for a busy signal before lapsing | `:85`, `:1365` |
| `LATE_TURN_START_MS` | 30 000 ms | Window in which a busy signal after a guessed end reopens the turn | `:92`, `:1349` |
| `SCRAPE_THROTTLE_MS` | 300 ms | Ceiling on unsolicited screen scrapes for gate detection | `:118` |
| `SUBMIT_DELAY_MS` | 16 ms | Quiet step before `\r` | `:162` |
| `SUBMIT_MAX_WAIT_MS` | 500 ms | Cap on waiting for quiet before `\r` | `:168` |

- When the start grace lapses, the turn is dropped and readiness is re-read from the screen, which settles as `screen-marker` — a guessed end (`:1366`–`:1369`). **[code]**
- A busy signal within 30 s of the submit, on a session already settled to `waiting_input`, puts it back to `running` with `turn-signal` (`:1344`, `resumeLateTurn`). **[code]**
- A session that has never emitted a turn signal keeps marker-only readiness (`:1361`; `__tests__/pty-ready-detection.test.ts:497`). **[code]**

### Behaviour while a gate/question is open

- Claude's title goes idle when a permission gate paints, in a chunk that precedes the gate itself (`:1406`, comment in `recheckReadyFromScreen`). **[code]**
- At the quiet check, an `ending` turn with a gate, picker, startup-choice gate or `Enter to select` footer on screen becomes `held`, and the session stays `running` (`:1410`–`:1420`; `__tests__/turn-signal-replay.test.ts:172`). **[code]**
- When the gate leaves the screen, a `held` turn re-enters the start grace through `openTurnOnSubmit` (`:1422`). **[code]**
- A busy signal re-opens a `held` turn as `working` (`:1333`). **[code]**
- A startup gate (workspace trust) paints its own `❯`, so boot settles to `waiting_input` with the gate still on screen; the quiet path rescans once so the card is still broadcast (`:1247`–`:1266`). **[code]**
- A card answered through `sendKeys` closes the card at once, without waiting for the screen (`:548`, `isPermissionAnswer`). **[code]**

### Submit mechanics that affect state

- The prompt is written as a bracketed paste, then `\r` in a separate write once the PTY has been quiet for 16 ms or 500 ms have passed (`:152`, `buildPasteBytes`; `:631`, `writeSubmit`). **[code]**
- Input sent during boot is queued and counted in `promptCount`, with no status change (`:580`–`:599`). **[code]**
- The queue is flushed by `markReady`, after the status is already `waiting_input` (`:1527`, `:686`). **[code]**

### Exit/failure

- Any exit sets `idle` / `process-exit` (`:1539`). **[code]**
- Non-zero exit within 2 s and no output sets `failureCode` `project_dir_missing` or `instant_exit` (`:1545`). **[code]**
- A missing CLI is refused before the spawn with 503, so it does not reach this path in normal operation (`CLAUDE.md`, "A missing provider CLI is refused before the spawn"). **[doc]**

### `statusSource` values and the "finished" push

- Emitted: `spawn`, `prompt-marker`, `screen-marker`, `turn-signal`, `user-input`, `timeout-fallback`, `process-exit`, `shutdown`. **[code]**
- Never emitted: `quiet-fallback` (zero occurrences in `src/pty-manager.ts`). **[code]**
- "Finished" can fire: the signalled end at `:1429` is `turn-signal`. **[code]**
- "Finished" does not fire for an end reached by the lapsed start grace or by a marker (`screen-marker`, `prompt-marker`). **[code]**

### Known bugs/gaps

- **Boot-queued prompt runs as `waiting_input`.** A prompt queued during boot is flushed after `markReady` set `waiting_input`, and the flush neither flips the status nor opens a turn (`:686`, `flushQueuedInputs`). The first turn is therefore reported as `waiting_input` throughout and sends no "finished". **[code, derived]**
- **Gate answered into an immediate end sends no "finished".** After a `held` turn's gate closes, an end with no further busy signal lapses to `screen-marker`. **[code, derived]**
- **`sendKeys` opens no turn.** A key sent while `waiting_input` flips to `running` with no start grace and no watch (`:515`); recovery depends on a later chunk carrying a marker. **[code, derived]**
- **No agent phase.** `claudePhase` returns `null` (`src/services/questions/parseAgentPhase.ts:56`). **[code]**
- **Nothing bounds a stuck turn.** A turn whose idle signal never arrives stays `running`; only the grace-defer cap or a process exit ends it. **[code, derived]**

## 3. Codex

Runner: `CodexPtyRunner` in `src/codex-pty-runner.ts`.
Screen predicates live in `src/services/questions/codexScreen.ts`.

### Boot/readiness signal

- The word `Ready` in the status bar (last non-blank rendered line), with nothing busy on screen, settles boot as `prompt-marker` (`:1071`; `codexScreen.ts:318`, `codexScreenShowsReady`). **[code]**
- Quiet alone never settles boot: the compose `›` is already painted during `Starting` (`:1067`–`:1074`). **[code]**
- During boot only, the text `already has an active writer` or `-32600` fails the start: `idle` / `process-exit` with `failureCode: "codex_active_writer"`, and `onReady` never fires (`:941`; `:1296`, `failStartup`). **[code]**
- A Codex resume or fork waits `CODEX_STARTUP_TIMEOUT_MS` (4 000) for that outcome before answering (`src/api/handlers/sessions.handlers.ts:145`). **[code]**

### Turn-start signal

- `sendInput` flips to `running` / `user-input`, clears `turnBusy` and records the submit time in `awaitingStart` (`:497`–`:504`). **[code]**
- The busy signal is the terminal title leading with a braille spinner glyph, or the word `Working` in the status bar (`:109`, `CODEX_TITLE_RE`; `:110`, `CODEX_TITLE_BUSY_RE`; `:1083`, `turnBusyNow`). **[code]**
- Seeing it while `running` adds the session to `turnBusy` and cancels the submit watch (`:1100`–`:1104`). **[code]**
- Codex CLI 0.156.1 spins its title and has no `Working`/`Ready` in its status bar (`:103`; `__tests__/turn-signal-replay.test.ts:92`). **[code]**

### Turn-end signal

- The turn has ended when the title no longer carries the spinner; if no title was ever seen, when `Ready` is back on the status bar (`:1106`, `turnEnded`). **[code]**
- The end requires that the turn was seen busy and that no gate, approval or picker card is open, and settles as `turn-signal` (`:1109`–`:1118`). **[code]**
- The end is decided on the same detection pass that sees the signal drop; there is no deferred settle like Claude's `ending` state. **[code]**

### Fallbacks and timers

| Constant | Value | Role | Cite |
|---|---|---|---|
| `QUIET_DETECT_MS` | 500 ms | Re-run screen detection after the last chunk | `:68` |
| `CODEX_READY_FALLBACK_MS` | 8 000 ms | Flat boot backstop; re-arms while the screen is busy or not yet idle | `:77`, `:347` |
| `CODEX_SUBMIT_STALE_MS` | 2 000 ms | After `\r`, recover a submit that never showed a busy signal | `:95`, `:572` |
| `LATE_TURN_START_MS` | 30 000 ms | Window in which a busy signal after a guessed end reopens the turn | `:101`, `:1087` |
| `CODEX_SUBMIT_DELAY_MS` | 16 ms | Quiet step before `\r` | `:85` |
| `CODEX_SUBMIT_MAX_WAIT_MS` | 500 ms | Cap on waiting for quiet before `\r` | `:89` |
| `CODEX_STARTUP_TIMEOUT_MS` | 4 000 ms | Resume/fork wait for ready-or-failed (env `THREADBASE_CODEX_STARTUP_TIMEOUT_MS`) | `sessions.handlers.ts:145` |

- The boot fallback settles as `timeout-fallback` at once if the PTY produced no output; otherwise only when the screen is not busy and shows `Ready` or a compose prefix (`:354`, `:369`–`:379`). **[code]**
- The boot fallback re-arms without a cap (`:370`, `:376`). **[code]**
- Submit-stale has two paths: a timer that reads the screen and re-arms while Codex is still `Starting` (`:583`, `trySubmitStaleRecovery`), and an in-pass check (`:1119`–`:1129`). Both settle as `quiet-fallback` with reason `submit-stale`. **[code]**
- A busy signal within 30 s of the submit, on a session already settled, puts it back to `running` with `turn-signal` (`:1085`–`:1097`; `__tests__/turn-signal-replay.test.ts:284`). **[code]**

### Behaviour while a gate/question is open

- Four card kinds are detected on every pass, each over the `permission` transport: trust/hooks gates, command approvals, usage or rate-limit screens, and numbered pickers (`:961`, `:980`, `:989`, `:1022`). **[code]**
- A gate, approval or picker on screen blocks the signalled turn end, so the session stays `running` (`:1109`, `cardOpen`). **[code]**
- Composer input sent while a gate, approval or picker is open is queued, and flushed when the card leaves the screen (`:474`–`:479`, `:973`, `:985`, `:1027`). **[code]**
- A remembered trust/hooks answer is written automatically, with no card (`:1208`–`:1218`). **[code]**
- A usage or rate-limit screen is the exception: it settles a `running` session to `waiting_input` / `quiet-fallback` (reason `usage-limit`) and sets `failureReason` on a live session (`:1145`, `:1155`–`:1158`). **[code]**
- That `failureReason` is cleared when the limit screen leaves (`:1003`–`:1014`). **[code]**
- The soft "usage limit reset available" tip is elevated to a card only when a submit is stuck `running` without a busy signal (`:994`–`:999`). **[code]**

### Submit mechanics that affect state

- Input is written as plain bytes with no bracketed paste, then `\r` once the PTY is quiet for 16 ms or 500 ms have passed (`:516`, `writeSubmit`). **[code]**
- The submit watch is armed only after the `\r` is written (`:564`). **[code]**
- `startFresh` passes the system prompt as Codex's positional prompt, which Codex runs as an opening turn during boot (`:296`–`:310`). **[code]**

### Exit/failure

- Any exit sets `idle` / `process-exit`, with the same instant-exit diagnosis as Claude (`:1332`–`:1351`). **[code]**
- `failStartup` removes the session before the callback and sends `SIGINT` in case Codex sits on its error screen (`:1320`–`:1324`). **[code]**

### `statusSource` values and the "finished" push

- Emitted: `spawn`, `prompt-marker` (boot only), `turn-signal`, `user-input`, `quiet-fallback`, `timeout-fallback`, `process-exit`, `shutdown`. **[code]**
- Never emitted: `screen-marker`. **[code]**
- "Finished" can fire: the end at `:1113` is `turn-signal`. **[code]**
- "Finished" does not fire for `submit-stale` or `usage-limit` ends. **[code]**

### Known bugs/gaps

- **`sendKeys` arms no recovery.** A key sent while `waiting_input` flips to `running` with no `awaitingStart` and no submit watch (`:398`–`:402`). A key that starts no turn (an arrow, Esc) leaves the session `running` until a later chunk lets the in-pass check fire. **[code, derived]** A fix is pending on `fix/provider-turn-state` (section 7).
- **Boot-queued prompt runs as `waiting_input`.** Same shape as Claude: the flush follows `markReady` and neither flips the status nor sets `awaitingStart` (`:617`, `:1281`). **[code, derived]**
- **No deferred settle.** If Codex drops its title spinner when an approval card paints, and the card paints in a later chunk, the end fires before the card is seen. **[unknown]** — no capture of a current Codex approval screen exists.
- **No re-open after a card.** If the title went idle while a card was open, the pass after the card closes settles the turn as `turn-signal`; `awaitingStart` is already consumed, so a continuing turn is not reopened. **[code, derived]**, reachable only if the previous item is true.
- **In-pass submit-stale ignores `cardOpen`** (`:1119`). An earlier investigation judged it unreachable because `turnBusy` is set before a card can appear. **[transcript, 2026-10-04]**
- **Agent phase is status-bar only.** `codexPhase` reports `working` from the status bar word (`src/services/questions/parseAgentPhase.ts:42`), which a build with no `Working` in its bar never shows. **[code, derived]**
- **Codex 0.160.0 opens a shared-daemon home screen** when launched without a prompt; whether the streamer's launch lands on it is unchecked. **[transcript, 2026-10-04]**

## 4. Cursor

Runner: `CursorPtyRunner` in `src/cursor-pty-runner.ts`.

### Boot/readiness signal

- Boot settles when the output buffer contains the bracketed-paste enable sequence `ESC[?2004h` and the PTY has then been quiet for 500 ms (`:38`, `CURSOR_BOOT_MARKER`; `:506`–`:509`). **[code]**
- That settle is recorded as `quiet-fallback` with reason `quiet:boot`, so a normal Cursor boot reports `inferred` confidence (`:508`). **[code]**
- Cursor paints nothing for roughly 8–11 s after spawn, and until the compose box is up the PTY is in cooked mode, where `\r` is eaten as a line ending (`:33`, comment; `__tests__/cursor-pty-runner.test.ts:178`). **[code]**
- The spawn passes `--trust`, which skips the workspace-trust prompt (`:122`, `baseArgs`). **[code]**

### Turn-start signal

- `sendInput` flips to `running` / `user-input` and clears `turnBusy` (`:245`–`:251`). **[code]**
- The busy signal is the text `ctrl+c to stop` in a chunk's stripped output while the session is `running` (`:51`, `CURSOR_TURN_BUSY_TEXT`; `:488`). **[code]**
- The test is made on one chunk, with no carry-over across a chunk boundary (`:488`). **[code]**

### Turn-end signal

- On quiet, if the turn was seen busy and the hint is no longer on the rendered screen, the turn ends as `turn-signal` with reason `turn-signal:busy-hint-cleared` (`:514`–`:520`). **[code]**
- The spinner repaints about every 250 ms during a turn, so quiet is rare mid-turn; the missing hint is what proves the end (`:512`, comment). **[code]**

### Fallbacks and timers

| Constant | Value | Role | Cite |
|---|---|---|---|
| `QUIET_DETECT_MS` | 500 ms | Quiet check for boot and turn end | `:31` |
| `CURSOR_READY_FALLBACK_MS` | 8 000 ms | Boot backstop; re-arms until the boot marker is seen | `:32`, `:194` |
| `CURSOR_READY_MAX_WAIT_MS` | 60 000 ms | Hard cap on boot; settles even without the marker | `:40`, `:199` |
| `CURSOR_SUBMIT_STALE_MS` | 2 000 ms | After `\r`, recover a submit that never showed the hint | `:46`, `:304` |
| `CURSOR_SUBMIT_DELAY_MS` | 16 ms | Step between Ctrl+U, text and `\r` | `:44` |
| `CURSOR_SUBMIT_MAX_WAIT_MS` | 500 ms | Cap on waiting for the echo before `\r` | `:45` |

- The boot backstop settles as `timeout-fallback`, including when the marker is already in the buffer at the moment the timer fires (`:204`). **[code]**
- Submit-stale is a timer only and never reads the screen; it settles as `quiet-fallback` with reason `submit-stale` (`:307`–`:315`). **[code]**
- There is no late-start recovery on `main`: the hint only counts while `running` (`:488`). **[code]**

### Behaviour while a gate/question is open

- The runner has no gate or question detection, and holds no `onPermissionChange` callback at all (`:68`–`:72`). **[code]**
- Capabilities declare `permissionGates: false` and `structuredQuestions: false` (`src/services/providers/capabilities.ts:124`, `CURSOR_CLI_CAPABILITIES`). **[code]**
- What Cursor paints during a tool approval, and whether the busy hint leaves the screen while it waits, is **[unknown]**.

### Submit mechanics that affect state

- Each submit is three writes: Ctrl+U on its own, then the text, then `\r` (`:258`, `writeSubmit`). **[code]**
- Ctrl+U needs its own read because Cursor discards a whole read that starts with it (`:272`, comment). **[code]**
- `\r` waits until Cursor has echoed the text (a chunk newer than the text write) and gone quiet, or 500 ms (`:291`, `lastChunk > writeAt`). **[code]**
- This matters for state: a `\r` that beats the echo still runs the turn but leaves the prompt in the compose box, which hides the busy hint, so the turn ends by `submit-stale` instead of `turn-signal` (`:288`, comment; `__tests__/cursor-pty-runner.test.ts:101`). **[code]**
- Queued inputs are flushed one at a time, each waiting on the previous `\r` (`:320`, `flushQueuedInputs`). **[code]**

### Exit/failure

- Any exit sets `idle` / `process-exit`, with the same instant-exit diagnosis as Claude (`:560`–`:578`). **[code]**

### `statusSource` values and the "finished" push

- Emitted: `spawn`, `user-input`, `quiet-fallback` (boot and submit-stale), `timeout-fallback`, `turn-signal`, `process-exit`, `shutdown`. **[code]**
- Never emitted on `main`: `prompt-marker`, `screen-marker`. **[code]**
- "Finished" can fire: the end at `:520` is `turn-signal`. **[code]**
- "Finished" does not fire for a `submit-stale` end. **[code]**

### Known bugs/gaps

- **No late-start recovery.** If submit-stale fires before the hint shows, the session sits in `waiting_input` for the whole turn and sends no "finished" (`:488`, `:314`). **[code, derived]** A fix is pending (section 7).
- **`sendKeys` can strand `running`.** A key sent while `waiting_input` flips to `running` and arms no watch; the quiet check returns early without `turnBusy` (`:213`, `:514`). A key that starts no turn leaves the session `running` with no recovery path. **[code, derived]** A fix is pending (section 7).
- **Boot confidence is mislabelled.** The observed compose box is reported as `quiet-fallback` / `inferred` (`:508`). **[code]** A relabel is pending (section 7).
- **Hint split across chunks.** A hint cut by a chunk boundary is never seen, so that turn ends by `submit-stale` (`:488`). **[code, derived]**
- **Possible false end during an approval.** If an approval repaint removes the hint, the quiet check fires a `turn-signal` end mid-turn. **[unknown]**
- **Boot-queued prompt runs as `waiting_input`.** Same shape as Claude and Codex (`:555`, `:320`). **[code, derived]**
- **No agent phase.** The runner never sets `subStatus` (`:619`). **[code]**
- **A hung turn is unbounded.** On Cursor 2026.10.01 a one-word prompt sat on `Working` for 137 s with no answer; the runner would hold `running` indefinitely. **[transcript, 2026-10-04]**

## 5. Copilot CLI (unmerged branch)

**Everything in this section describes an unmerged branch (commit `abe0f7d4`, "add Copilot live terminal support") and is not on `main`.**
Runner: `CopilotPtyRunner` in `src/copilot-pty-runner.ts` on that branch.
The runner's header states the design: without a captured readiness or turn signal it keeps `running` until exit or hold (`:28`–`:34`). **[code]**

### Boot/readiness signal

- None. There is no `pendingReady`, no input queue, no `markReady` and no `onReady` call anywhere in the runner. **[code]**
- The fresh-start route answers 200 immediately for Copilot instead of waiting for readiness (`src/api/handlers/sessions.handlers.ts:2713` on the branch, "Live-v1 Copilot has no verified TUI readiness detector"). **[code]**

### Turn-start signal

- None. `sendInput` does not change status (`:132`–`:142`). **[code]**

### Turn-end signal

- None. Status changes only in `finish`, which is reached from process exit and from hold (`:189`). **[code]**

### Fallbacks and timers

- None. The runner defines no timing constants; its only constants are `OUTPUT_BUFFER_MAX` and `INPUT_HISTORY_MAX` (`:25`–`:26`). **[code]**

### Behaviour while a gate/question is open

- No detection of any kind; trust and auth prompts are answered by the user in the raw terminal (`:30`–`:33`). **[code]**
- Capabilities declare `permissionGates: false` and `structuredQuestions: false` (`src/services/providers/capabilities.ts`, `COPILOT_CAPABILITIES`, on the branch). **[code]**

### Submit mechanics that affect state

- Input and `\r` are one write, `${input}\r`, with no bracketed paste, no quiescence wait and no echo wait (`:134`). **[code]**
- Because there is no boot queue, input sent before the TUI is reading goes straight to the PTY. **[code, derived]**
- `sendKeys` is an alias of `sendRawKeys` (`:144`). **[code]**

### Exit/failure

- Exit sets `idle` / `process-exit` through `finish` (`:121`). **[code]**
- A non-zero exit within 2 s sets `failureCode: "instant_exit"`; unlike the other runners it does not require empty output and never reports `project_dir_missing` (`:117`–`:120`). **[code]**
- Hold sets `idle` / `shutdown`, removing the session before the kill so a late exit cannot finalise it twice (`:177`–`:187`). **[code]**

### `statusSource` values and the "finished" push

- Emitted: `spawn`, `process-exit`, `shutdown`. **[code]**
- "Finished" cannot fire: the session never reaches `waiting_input`, so no turn ever opens or closes in the notifier. **[code, derived]**
- The "failed" push can fire for an instant exit, since the session never reached a prompt and carries a `failureReason`. **[code, derived]**
- No `session_ready` frame is ever broadcast, since `onReady` is never called. **[code, derived]**

### Known bugs/gaps

- **Status is stuck on `running`.** A live session answered two prompts and returned to an empty `❯` while still reporting `running` with `statusSource: "spawn"` and `statusUpdatedAt` equal to its start time; the mobile app showed "Working" throughout. **[transcript, 2026-10-06]** This matches the code. **[code]**
- **The idle reaper can never release it.** The reaper skips every `running` session, so a Copilot PTY lives until its process exits or a hold lands (`src/server.ts:1272`). **[code, derived]**
- **A hold is always deferred to the cap.** `hold_session` on a session that reads `running` defers `GRACE_MAX_DEFERS` times before holding (`src/server.ts:1321`). **[code, derived]**
- **A hold latched on `waiting_input` can never trigger** (`src/server.ts:450`, `holdWhenIdle`). **[code, derived]**
- **Candidate turn signal, unverified.** Mid-turn Copilot painted a `◎ ○ ◉ ●` spinner with `Working` and an `esc interrupt` hint, absent at the idle `❯` prompt; the one dump this came from mixed repaint frames. **[transcript, 2026-10-06]**
- **Whether Copilot sets a terminal title or any OSC turn signal** is **[unknown]**; no PTY capture of a Copilot turn exists in the repository.
- **Tests cover I/O, hold and exit only**, not status transitions (`__tests__/copilot-pty-runner.test.ts` on the branch). **[code]**

## 6. Comparison matrix

Values are for `main`, except the Copilot column, which is the unmerged branch.

| | Claude Code | Codex | Cursor | Copilot CLI (unmerged) |
|---|---|---|---|---|
| **Boot/readiness signal** | `╭` or `❯` in a chunk or on the screen | `Ready` in the status bar | `ESC[?2004h` seen, then 500 ms quiet | None; stays `running` |
| **Boot source recorded** | `prompt-marker` / `screen-marker` | `prompt-marker` | `quiet-fallback` (inferred) | `spawn` forever |
| **Turn-start signal** | Title spinner `◐◓◑◒`, or OSC 9;4 busy | Title braille spinner, or `Working` in the bar | `ctrl+c to stop` in a chunk | None |
| **Turn-end signal** | Title `✳` or OSC 9;4;0, settled on the next quiet check | Title spinner gone (or `Ready` back), same pass | Hint gone from screen, on quiet | None |
| **Optimistic turn open** | `submitted`, 3 s grace | `user-input`, 2 s submit-stale | `user-input`, 2 s submit-stale | n/a |
| **Boot fallback** | 8 s flat, `timeout-fallback` | 8 s, re-arms while busy, uncapped | 8 s, re-arms until marker, capped at 60 s | None |
| **Submit-never-started recovery** | Grace lapses → `screen-marker` | `submit-stale` → `quiet-fallback` (reads screen) | `submit-stale` → `quiet-fallback` (timer only) | None |
| **Late-start recovery (30 s)** | Yes | Yes | No (pending) | No |
| **Gate/question open** | Turn `held`; stays `running` | Card blocks the end; stays `running`; usage limit settles to `waiting_input` | No detection | No detection |
| **Input while a card is open** | Written | Queued until the card closes | Written | Written |
| **Submit bytes** | Bracketed paste, then `\r` after quiet | Plain text, then `\r` after quiet | Ctrl+U, text, then `\r` after echo | `text\r` in one write |
| **Boot input queue** | Yes | Yes | Yes | No |
| **`sendKeys` from `waiting_input`** | → `running`, no watch | → `running`, no watch (pending fix) | → `running`, no recovery (pending fix) | No status change |
| **Exit** | `idle` / `process-exit` | `idle` / `process-exit`; `failStartup` for the writer lock | `idle` / `process-exit` | `idle` / `process-exit` |
| **Instant-exit codes** | `project_dir_missing`, `instant_exit` | same, plus `codex_active_writer` | `project_dir_missing`, `instant_exit` | `instant_exit` only |
| **`statusSource` never emitted** | `quiet-fallback` | `screen-marker` | `prompt-marker`, `screen-marker` | all but `spawn`, `process-exit`, `shutdown` |
| **"Finished" push possible** | Yes | Yes | Yes | No |
| **Agent phase (`subStatus`)** | Always `null` | `working` from the status bar only | Never set | Always `null` |
| **Reapable when idle for 6 h** | Yes | Yes | Yes | No (never leaves `running`) |

## 7. Pending changes on `fix/provider-turn-state`

One commit, `d99041e4`, not merged; described here as pending, not current.
Its merge base is older than `main` at `58352e8d`, so it needs a rebase before it can land.

- **Cursor late start.** Adds `LATE_TURN_START_MS` (30 000) and a `resumeLateTurn`: a hint that arrives after submit-stale settled the turn puts the session back to `running` / `turn-signal`. **[code, branch]**
- **Cursor and Codex `sendKeys`.** Both set `awaitingStart` and arm the 2 s submit watch when a key flips `waiting_input → running`. **[code, branch]**
- **Cursor boot source.** `quiet:boot` is relabelled from `quiet-fallback` to `prompt-marker`. **[code, branch]**
- **Tests.** Adds cases to `__tests__/codex-pty-runner.test.ts`, `__tests__/cursor-pty-runner.test.ts` and `__tests__/turn-signal-replay.test.ts`, and extends the source guard in `__tests__/status-confidence.test.ts`. **[code, branch]**
- It does not touch Claude's `sendKeys`, the boot-queued-prompt gap, or anything Copilot. **[code, branch]**

## 8. Gaps and open questions

| # | Provider | Gap or question | Evidence |
|---|---|---|---|
| 1 | Copilot | No readiness, turn-start or turn-end detection; status is `running` from spawn to exit. | `src/copilot-pty-runner.ts:28`–`:34`, `:189` (branch) **[code]**; live session **[transcript, 2026-10-06]** |
| 2 | Copilot | No "finished" push, no `session_ready`, never reaped, hold always deferred to the cap. | `waitingInputNotifier.ts:242`; `src/server.ts:1272`, `:1321` **[code, derived]** |
| 3 | Copilot | Does Copilot emit a title or OSC turn signal, and is `esc interrupt` a clean busy marker? | No capture exists **[unknown]**; one mixed-frame dump **[transcript, 2026-10-06]** |
| 4 | Copilot | No boot queue and a single-write submit: is early input lost or mis-submitted? | `src/copilot-pty-runner.ts:134` (branch) **[unknown]** |
| 5 | Claude, Codex, Cursor | A prompt queued during boot is flushed after `waiting_input` is set, so its turn runs as `waiting_input` and sends no "finished". | `src/pty-manager.ts:686`, `:1527`; `src/codex-pty-runner.ts:617`, `:1281`; `src/cursor-pty-runner.ts:320`, `:555` **[code, derived]** — not reproduced; no test asserts the status after a flush |
| 6 | Codex, Cursor | `sendKeys` from `waiting_input` flips to `running` with no recovery. | `src/codex-pty-runner.ts:398`; `src/cursor-pty-runner.ts:213` **[code, derived]**; fix pending (section 7) |
| 7 | Claude | `sendKeys` from `waiting_input` opens no turn and arms no grace. | `src/pty-manager.ts:515` **[code, derived]**; not covered by the pending branch |
| 8 | Cursor | No late-start recovery; a slow turn start is reported `waiting_input` with no push. | `src/cursor-pty-runner.ts:488`, `:314` **[code, derived]**; fix pending |
| 9 | Cursor | Normal boot is reported as `inferred`. | `src/cursor-pty-runner.ts:508` **[code]**; relabel pending |
| 10 | Cursor | Busy hint tested per chunk, no boundary carry-over. | `src/cursor-pty-runner.ts:488` **[code, derived]** |
| 11 | Cursor | Does an approval repaint remove `ctrl+c to stop`, producing a false signalled end? | No capture of Cursor 2026.10.01's approval screen **[unknown]**; noted **[transcript, 2026-10-04]** |
| 12 | Codex | Does Codex drop its title spinner while an approval card waits, and does the card paint in a later chunk? | No capture of Codex 0.160.0's approval screen **[unknown]**; noted **[transcript, 2026-10-04]** |
| 13 | Codex | No deferred settle and no re-open after a card; both matter only if item 12 is true. | `src/codex-pty-runner.ts:1106`–`:1118`, `:1086` **[code, derived]** |
| 14 | Codex | Boot fallback re-arms with no cap. | `src/codex-pty-runner.ts:370`, `:376` **[code]** |
| 15 | Codex | Does the streamer's launch land on Codex 0.160.0's shared-daemon home screen, and what does readiness see there? | **[transcript, 2026-10-04]**, **[unknown]** |
| 16 | Codex | Agent phase depends on a status-bar word a spinner-only build does not paint. | `src/services/questions/parseAgentPhase.ts:42` **[code, derived]** |
| 17 | Claude | A gate answered into an immediate end settles by `screen-marker`, so no "finished". | `src/pty-manager.ts:1422`, `:1366` **[code, derived]** |
| 18 | Claude | No agent phase. | `src/services/questions/parseAgentPhase.ts:56` **[code]** |
| 19 | All | Nothing bounds a turn that never signals its end; only the grace-defer cap or an exit ends `running`. | `src/server.ts:1272`, `:1321` **[code, derived]**; Cursor hang **[transcript, 2026-10-04]** |
| 20 | All | Turn signals are pinned to specific CLI builds (Claude Code 2.1.280, Codex 0.156.1, Cursor 2026.09.23); behaviour on newer builds is unverified. | `__tests__/turn-signal-replay.test.ts:70`, `:92`, `:105` **[code]** |

## Related documents

- `CLAUDE.md`, "Session lifecycle" — the status diagram and the rationale for turn signals.
- `docs/streamer-state-model.md` and `docs/streamer-state-model-audit.md` — the wire contract and its audit.
- `docs/architecture/2026-07-24-session-state-confidence.md` — the design of `statusSource` and confidence.
- `docs/architecture/2026-07-24-durable-session-runtime.md` — grace hold and the idle reaper.
