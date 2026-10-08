# Copilot CLI: turn detection

Why a Copilot session used to be reported as `running` for its whole life, and how the runner reads a turn now.

What is still open is tracked in [#1038](https://github.com/RonenMars/threadbase-streamer/issues/1038); this file carries the diagnosis and the design, not the status.

Verified 2026-10-06 against Copilot CLI 1.0.92.

---

## Symptom

A Copilot session showed as working for its whole life. It never reached `waiting_input`, so the client never stopped its spinner and the "finished" push never fired.

## Cause

`CopilotPtyRunner` (`src/copilot-pty-runner.ts`) shipped in #1002 with no turn detection. It assigned `status` in two places only:

- `status: "running"` with `statusSource: "spawn"` at launch;
- `session.status = "idle"` on process exit or hold.

Its `onData` handler wrote to the screen and recorded `lastOutput`; `sendInput` did not touch status. The class comment said so on purpose: "Without a captured readiness/turn signal we retain `running` until exit or hold." The runner shipped without a signal because no raw capture of a Copilot turn existed to derive one from.

## What Copilot paints

From the raw PTY captures `__tests__/fixtures/turn-signals/copilot-1.0.92-{turn,gate,ask}.json`, recorded with `scripts/capture-pty.ts` and pinned by `__tests__/pty-capture-fixtures.test.ts`.

| Moment | Bottom status row | Notes |
|---|---|---|
| Folder trust (fresh directory) | replaced by the card | `Do you trust the files in this folder?`, footer `↑/↓ to navigate · enter to select · esc to cancel` |
| Idle, empty compose box | `← open sidebar · Interactive · Manual Approval · …` | the only moment `open sidebar` shows |
| Idle, text typed | `Interactive · Manual Approval · @ files · # issues` | `open sidebar` is gone |
| Turn running | `Working` with a spinner glyph | on screen within tens of milliseconds of Enter |
| Permission card open | replaced by the card | `Do you want to run this command?`, same footer as trust |
| `ask_user` form open | replaced by the form | `Copilot needs information.`, footer `enter accept · ctrl+d decline · esc cancel` |

Four consequences for a detector:

- **There is no title signal.** Every terminal title ends in `GitHub Copilot` and only names the session. Claude and Codex can be read from the title; Copilot cannot.
- **Read the rendered screen, not the chunk.** `Working` is painted with cursor moves and never appears as a contiguous string in a raw chunk. The Cursor runner's `lastOutput.includes(...)` check would never match here.
- **Idle means "busy is absent".** The idle footer changes as soon as the user types, so it cannot be the idle signal.
- **A card looks like the end of a turn.** With a permission card or an `ask_user` form open, neither `Working` nor `open sidebar` is on screen. Ending the turn on "busy absent and quiet" would report "finished" while Copilot waits on the user, the defect #1037 records for Cursor.

## What the runner does

Added in #1054. Every name below is a constant or a reason string in `src/copilot-pty-runner.ts`.

| Moment | What is read | Result |
|---|---|---|
| Boot | bottom row contains `open sidebar` after a quiet check | `waiting_input`, `statusSource: "prompt-marker"`, reason `boot:idle-footer`; `onReady` fires |
| Submit | `sendInput` | `running`, `statusSource: "user-input"` |
| Turn running | bottom row matches `COPILOT_BUSY_ROW` (`<spinner> Working`), checked as each chunk lands | the turn is marked busy; a session in `waiting_input` goes back to `running` with `turn-signal` |
| Card open | a `COPILOT_CARD_FOOTERS` match in the bottom three rows | the quiet check does not settle; the session stays `running` |
| Turn ends | 500 ms quiet (`QUIET_DETECT_MS`), no busy row, no card footer, and the turn was seen busy | `waiting_input`, `statusSource: "turn-signal"`, reason `turn-signal:busy-row-cleared` |
| Submit that starts no turn | no busy row within `COPILOT_SUBMIT_STALE_MS` (2 s) | `waiting_input`, `statusSource: "quiet-fallback"`, reason `submit-stale` |

Each settle is logged as `copilot.ready` with its reason.

The busy row is only matched on the bottom row, and the card footers only in the bottom three, because both are ordinary text a reply can contain.

`__tests__/turn-signal-replay.test.ts` replays the three captures through the runner: the plain turn ends once with `turn-signal`, and the two card captures stay `running` while the card is open.

Surfacing the trust card, the permission card or the `ask_user` form as question cards is a separate change, tracked in #1047, and would flip `structuredQuestions` / `permissionGates` in `COPILOT_CAPABILITIES`.

## Not established

- Whether the status row keeps showing `Working` through a long tool call. The captures are of short turns, and a row that blanks mid-turn with no card open would end the turn early.
- Whether a real turn sends exactly one "finished" push on a device.
- Any terminal size other than 120x40. A client can resize the PTY, and a wrapped card footer could fall outside the bottom three rows.
- Whether Copilot CLI 1.0.91 paints the same status row. Only 1.0.92 was captured.
