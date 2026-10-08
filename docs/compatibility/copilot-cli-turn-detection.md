# Copilot CLI: turn detection

Why a Copilot session is always reported as `running`, and what a detector has to do about it.

Open work is tracked in [#1038](https://github.com/RonenMars/threadbase-streamer/issues/1038); this file carries the diagnosis and the plan, not the status.

Verified 2026-10-06 against Copilot CLI 1.0.92.

The runner described here arrives with #1002 and is not on `main` until that merges.

---

## Symptom

A Copilot session shows as working for its whole life. It never reaches `waiting_input`, so the client never stops its spinner and the "finished" push never fires.

## Cause

`CopilotPtyRunner` (`src/copilot-pty-runner.ts`) has no turn detection. It assigns `status` in two places only:

- `status: "running"` with `statusSource: "spawn"` at launch;
- `session.status = "idle"` on process exit or hold.

Its `onData` handler writes to the screen and records `lastOutput`; `sendInput` does not touch status. The class comment says so on purpose: "Without a captured readiness/turn signal we retain `running` until exit or hold." The runner shipped without a signal because no raw capture of a Copilot turn existed to derive one from.

## What Copilot paints

From the raw PTY captures `__tests__/fixtures/turn-signals/copilot-1.0.92-{turn,gate,ask}.json`, recorded with `scripts/capture-pty.ts` and pinned by `__tests__/pty-capture-fixtures.test.ts`. Those files arrive with #1036 and are not on a branch that predates it.

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

## Plan

1. Mirror the Cursor runner's shape: mark the turn busy when the status row shows `Working`, and settle to `waiting_input` with `statusSource: "turn-signal"` once the output is quiet and the row no longer shows it. `turn-signal` is the only source `WaitingInputNotifier` pushes on.
2. Match `Working` on the status row of the rendered screen only. It is an ordinary word and can appear in a reply.
3. Hold the turn open while a card footer is on screen (`enter to select · esc to cancel`, or `enter accept · ctrl+d decline · esc cancel`).
4. Set `running` with `statusSource: "user-input"` in `sendInput`, and settle boot on the first idle footer.
5. Replay the three fixtures through the runner in `__tests__/turn-signal-replay.test.ts`: the plain turn is the positive control, and the two card captures are the cases that must stay `running`. Revert the marker once and watch both go red.
6. Confirm on a device that a real turn goes `running` then `waiting_input` and sends one "finished" push.

Keep the change to status detection. Surfacing the trust card, the permission card or the `ask_user` form as question cards is a separate change, and would flip `structuredQuestions` / `permissionGates` in `COPILOT_CAPABILITIES`.

## Not established

- Whether the status row keeps repainting through a long tool call. The captures are of short turns, and the answer decides how long the quiet check has to be.
- Whether Copilot CLI 1.0.91 paints the same status row. Only 1.0.92 was captured.
