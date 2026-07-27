# Mobile: the per-turn "Finished" state

This documents the tb-mobile implementation that consumes the per-turn Live Activity contract described in [`live-activity-push.md`](./live-activity-push.md).
That document's "what's needed to use `sessionName` and the per-turn 'Finished' state" section is the spec this satisfies — the "Render a distinct 'Finished' visual state on the `end` event" item is done for the foreground path; the rest is noted below.

Repo: `tb-mobile`. Files: `services/live-activity.ts`, `services/live-activity.android.ts`, `widgets/SessionLiveActivity.tsx`, `types/live-activity.ts` (unchanged), plus tests in `__tests__/unit/services/live-activity*.test.ts`.

## Two independent paths, same contract, two implementations

Live Activities update two ways, and they are separate code paths on the mobile side, not one:

- **Foreground, over the existing session WebSocket.** `services/live-activity.ts`'s `reconcile()` is called on every `session_update` message. This is what this document covers.
- **Background, over APNs push.** ActivityKit decodes the push payload natively; there is no JS involved. This is what `liveActivityNotifier.ts` (streamer-side) drives, and what `live-activity-push.md` documents.

Both must agree on what a turn boundary means, because the same session can be foregrounded one moment and backgrounded the next, mid-turn. The mobile implementation below was built to mirror `LiveActivityNotifier`'s per-turn logic (`src/services/push/liveActivityNotifier.ts`) field for field: same edges, same "carry the last renderable status through the close" trick, same "any other terminal signal also closes with no distinction from a clean turn-close" behavior.

## The trigger: per-turn, not per-session

Read `src/services/push/liveActivityNotifier.ts`'s class doc comment first — it is the source of truth this port follows.
Summarized:

- A turn **opens** on `waiting_input → running` (the user sent a prompt).
- A turn **closes** on the matching `running → waiting_input` (the response finished) — this is what renders the "Finished" frame.
- A session's very first `running`, with no prior `waiting_input`, opens nothing. This is what keeps a freshly spawned or already-running session (e.g. the app opens onto one) from showing a surface before the user has asked for anything.
- Any other terminal signal on an open turn (the session dies mid-turn) also closes it. **This looks identical over the wire to a clean turn-close** — `endFor()` on the streamer side calls the same close path for both (see `liveActivityNotifier.ts:97` and `:109`), so mobile cannot and does not try to distinguish them. A session crashing mid-response also shows "Finished". This was a deliberate scope decision, not an oversight — see "Known gap" below.

Mobile's `Session` type has no `sessionName`, `statusSource` cannot be used to distinguish this (a session dying mid-turn from an unrelated cause is unrelated to how the *previous* status was derived), and there is no field on the wire that marks "this end is a crash, not a turn-close" — the streamer doesn't send one either. Building that distinction, if wanted later, needs a new field on both sides; nothing here assumes it will arrive.

## `services/live-activity.ts` — the port

`decideActions` used to be a snapshot-only function: given "what's tracked" and "the incoming state", decide start/update/end. It is now edge-aware — it also takes the **previous** status for the same key, mirroring the streamer's `openActivity` map:

```ts
export function decideActions(
  tracked: readonly TrackedActivity[],
  previousStatus: 'running' | 'waiting_input' | undefined,
  incoming: LiveSessionState | null,
  key: string,
): LiveActivityAction[]
```

`TrackedActivity` gained a `turnOpen: boolean` field. `LiveActivityAction`'s `end` variant gained an optional `finalState?: LiveSessionState` — the "Finished" frame to render, when there is one:

```ts
export type LiveActivityAction =
  | { type: 'start'; key: string; state: LiveSessionState }
  | { type: 'update'; key: string; state: LiveSessionState }
  | { type: 'end'; key: string; finalState?: LiveSessionState }
```

The reconciler (`reconcile()`) now tracks `previousStatus` per key in a module-level map, independent of the `handles` map that tracks actually-started activities — a session can sit at `waiting_input` with no activity on screen (turn not open) for a while before the user prompts it, and that prior status is still what turns the next `running` into an open edge.

`apply()`'s `end` branch, when given a `finalState`, calls `expo-widgets`' `LiveActivity.end('default', finalState)` instead of `end('immediate')`. `'default'` is what leaves the Activity visible for the OS's normal post-end grace period so the checkmark is actually seen; `'immediate'` (unchanged for the no-`finalState` case — LRU eviction) removes it at once, since there is nothing to show.

`toLiveState()` is unchanged and still exported: it maps one `Session` snapshot to a `LiveSessionState | null`, with no knowledge of turns. `isTerminal()` is unchanged too.

## `widgets/SessionLiveActivity.tsx` — rendering

The widget receives `status: 'running' | 'waiting_input'` — the same two-value `LiveActivityStatus` the streamer's `LiveActivityContentState` already defines (`src/services/push/liveActivityContentState.ts:19`). No new status value was added on either side.

The rendering insight: **given the reconciler above, `waiting_input` never reaches the widget as an ongoing state.** `decideActions` only ever delivers `waiting_input` as the `finalState` passed to `end`. So the widget renders `status === 'waiting_input'` as "Finished" (checkmark, `#0969da` / `#58a6ff` light/dark — matches `constants/theme.ts`'s `status.completed` token) rather than literally "Waiting for input". `running` renders as before ("Running", ticking timer).

This mirrors the streamer's own comment at `liveActivityNotifier.ts:183`: *"Carry the last renderable status through the end event: the content state is required by the payload, and `idle` has no encoding mobile understands."* Mobile's widget is the consumer of exactly that carried-through `waiting_input`.

## `services/live-activity.android.ts` — the Android equivalent

Android has no Live Activity; a running session is an ongoing ("sticky") ["Live sessions" channel]notification instead. The same per-turn edges apply, ported the same way (`previousStatus` map, `turnOpen` on the tracked handle). A closed turn does not dismiss the notification outright — it re-posts it once more as a **non-sticky, auto-dismissing** notification carrying "Finished" in the body, so the user gets an equivalent of the checkmark frame instead of the notification just vanishing.

## Tests

`__tests__/unit/services/live-activity.test.ts`'s `decideActions` suite now exercises every edge explicitly: no-op on first `running`, open on `waiting_input → running`, update on a same-status re-emit with an open turn, no-op on a same-status re-emit with no open turn, close-with-`finalState` on `running → waiting_input`, no-op on that edge with no open turn, close-with-no-`finalState` on a non-renderable session, cap eviction on open, and slot-freeing on close.

`__tests__/unit/services/live-activity.android.test.ts` drives the same edges end-to-end through `reconcile()`, using an `openTurn()` helper that reconciles `waiting_input` then `running` — mirroring how a real turn actually opens rather than starting a session directly at `running`.

Both suites pass; `npx eslint` and `npx tsc --noEmit` are clean on every touched file (only a pre-existing, unrelated `expo-widgets` module-resolution gap remains in this checkout, from the package not being installed there — confirmed clean against a sibling worktree that does have it installed).

## Known gap — not built here

**Crash mid-turn shows "Finished" too**, same as the streamer's own `end` path (see "The trigger" above). If this needs fixing later, it needs a field on the wire distinguishing a clean turn-close from a mid-turn death, added to `LiveActivityContentState` (streamer) and `LiveSessionState` (mobile) together — this repo's own contract-drift warning at the top of `liveActivityContentState.ts` applies.

**`sessionName`** (in `live-activity-push.md`'s contract, added on the streamer side) is not consumed by mobile — `types/live-activity.ts`'s `LiveSessionState` was not touched by this work. The banner still shows `projectName`. Out of scope for this change; a coordinated follow-up if wanted.

**Background push's `dismissal-date` is not set.** `LiveActivitySender.end()` (streamer) does not currently expose the `dismissalDate` parameter `buildActivityKitPayload` already supports (`liveActivitySender.ts` — `end()`'s signature only takes `sessionId`, `contentState`, `now`). ActivityKit's own default post-`end` grace period applies in its absence, which is what today's push-driven `end` already gets. Mobile's foreground path sets its own dismissal policy independently (`'default'`, see above) since `expo-widgets`' `LiveActivity.end()` takes a client-side policy, not a server-sent date — the two are unrelated knobs, not a shared one waiting to be wired up.
