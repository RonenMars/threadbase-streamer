# iOS Live Activity push (APNs)

Live Activities are the Lock Screen and Dynamic Island surfaces tb-mobile shows for a running session.
They update two ways: over the existing WebSocket while the app is foregrounded, and by push when it is not.

The push path is what this document covers.
It is the only way to do two things the WebSocket cannot: update a Live Activity while the app is fully suspended, and renew an activity past iOS's ~8 hour cap without the user opening the app.

## Why this is not Expo push

The streamer already sends ordinary notifications through Expo's relay.
ActivityKit cannot use it.
A Live Activity update needs a different token type, a `.push-type.liveactivity` APNs topic, and a p8 signing credential — so this path talks HTTP/2 to APNs directly and does not involve `expo-server-sdk`.

Three token types now arrive from the same device, and they are not interchangeable:

| `kind` | What it is | Lifetime |
|--------|-----------|----------|
| `expo` | Expo relay token, for ordinary notifications | Long-lived |
| `liveactivity_start` | ActivityKit push-to-start token, app-wide | Long-lived |
| `liveactivity_update` | ActivityKit per-activity update token | Short-lived, issued after an activity starts |

Sending one to the wrong transport fails only at send time, with nothing at registration time to explain it.
`kind` is therefore stored explicitly rather than inferred from the token's shape, and `listDeliverable()` returns Expo tokens only.

## Configuration

**The `liveActivityPush` feature flag gates the whole surface, and it is off by default.**
Credentials alone no longer bring this up: `initLiveActivityPush()` checks the flag before it reads the environment, so a box with a valid p8 configured logs `live_activity.disabled` at boot and constructs no sender.
Turn it on with `THREADBASE_FEATURE_LIVE_ACTIVITY_PUSH=1`, `--feature liveActivityPush=true`, or `feature_flags: {"liveActivityPush":true}` in `server.yaml`, then restart — feature flags resolve once, at boot.

The flag governs the client half too.
tb-mobile reads it over `GET /api/config/feature-flags` and, when it is off, skips its own local ActivityKit path — and the Android ongoing-notification equivalent — so one switch turns the feature off end to end.
That coupling is deliberate: the client half on its own starts an activity locally from WebSocket frames, which means it only updates while the app is foregrounded, freezes the moment the app backgrounds, and expires silently at iOS's ~8h cap.
Half the feature is worse than none of it.
A server too old to serve `/api/config/feature-flags` reads as off, on the grounds that it is also too old to have been asked — and it is the one case where surfaces stop appearing without anyone choosing that, so tb-mobile logs `liveActivity.legacyServer` when it happens.
From the phone the absence looks identical to a server that answered `false`; that log line is what separates "upgrade the streamer" from "check the flag".

Turn the flag on where a `liveactivity_start` token is actually registered; without one, the push half has nothing to send to and only the degraded local path remains.

All credentials come from the environment.
No key, key id, or team id is committed, and neither the key nor any device token is ever logged.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APNS_KEY` | Yes | — | **Contents** of the p8 signing key (PEM). Not a path. Live Activity push stays off when unset. |
| `APNS_KEY_ID` | With `APNS_KEY` | derived from the key filename under launchd | Key id of the p8 above. The shim reads it from `AuthKey_<keyId>.p8`, so it normally needs no setting. |
| `APNS_TEAM_ID` | With `APNS_KEY` | — | Apple Developer team id. |
| `APNS_BUNDLE_ID` | With `APNS_KEY` | — | App bundle id. The APNs topic is this plus `.push-type.liveactivity`. |
| `APNS_HOST` | No | `api.sandbox.push.apple.com` | Set to `api.push.apple.com` for production. |

The default host is **sandbox**, because the app's `aps-environment` is still `development`.
A build signed for production will not receive sandbox pushes, and vice versa — a mismatch here is the most common reason pushes silently never arrive.

### Supplying the key

The signing key lives in 1Password, not on disk.
The operator exports it before starting the server:

```bash
export APNS_KEY="$(op read 'op://<vault>/<item>/AuthKey_<keyId>.p8')"
export APNS_KEY_ID="<keyId>"
export APNS_TEAM_ID="<teamId>"
export APNS_BUNDLE_ID="<bundleId>"
```

None of the identifiers have defaults in the source.
Baking one deployment's Apple account into the package would make it silently sign for the wrong team when someone else deploys it, and the APNs rejection that follows names none of that.
If `APNS_KEY` is set but an identifier is missing, the feature stays off and the log says which variable is absent.

### The supervised prod instance

launchd cannot read a file into an environment variable, and the plist is the wrong place for the key: it is world-readable (0644) and `scripts/deploy.sh` regenerates it on every deploy, so an embedded secret would be both exposed and silently wiped.

Instead, drop the key into the install dir and the launchd shim loads it at spawn time:

```bash
mv ~/Downloads/AuthKey_<keyId>.p8 ~/.threadbase/ && chmod 600 ~/.threadbase/AuthKey_<keyId>.p8
```

The shim globs `~/.threadbase/AuthKey_<keyId>.p8` rather than matching one hardcoded filename, and **derives `APNS_KEY_ID` from the filename** — Apple embeds the key id there.
That makes a rotation a drop-in: replace the file, restart, no code or config change.
It also removes a failure mode, since the key and the id it is announced under can never disagree; a mismatch is rejected by Apple as a bare `InvalidProviderToken` that says nothing about the cause.

An explicit `APNS_KEY` or `APNS_KEY_ID` in the environment still wins.
With several `AuthKey_*.p8` files present the newest by mtime is used and the ambiguity is logged — remove stale keys after a rotation.
Only the path and key id are logged, never the key contents.

The key must be **Team Scoped (All Topics)**.
A key scoped to the bundle id alone cannot sign the `.push-type.liveactivity` topic.
It covers both Sandbox and Production, so the same key works with either `APNS_HOST`.

When `APNS_KEY` is unset the server logs one line at info and runs normally with the feature off.
This is the expected state on a developer machine and in CI — a missing optional push credential must never stop the server from booting.

## Content-state contract

This shape is shared with tb-mobile, which decodes it into a Swift `Codable` struct (`types/live-activity.ts` on the mobile side).

```ts
{
  sessionId: string
  serverId: string
  projectName: string
  status: 'running' | 'waiting_input'
  startedAt: number   // epoch MILLISECONDS
  lastOutput: string  // truncated to 90 chars
  serverLabel?: string
  sessionName?: string  // user-visible title; see below
}
```

Two constraints are easy to get wrong and fail silently, because an ActivityKit decode failure produces no server-side error — the surface simply stops updating:

- **`startedAt` is epoch milliseconds, and is the session's start.** iOS renders its own ticking elapsed timer from it. Never send a precomputed elapsed value, and never push per-second updates. A renewal must carry the original value through unchanged, or the user's visible timer resets to zero.
- **`status` has exactly two values.** `idle` has no representation; a session that is no longer live gets an `end` event instead of an update.

The whole payload must stay under APNs' 4 KB limit, which is what `lastOutput`'s 90-character bound is for.

**`sessionName`** is a user-visible title, derived server-side from the first line of the session's first user message (mirrors `@threadbase-sh/scanner`'s own `deriveSessionNameFromFirstMessage`, capped at 80 chars — see `src/utils/deriveSessionName.ts`). It is absent from the very first push of a turn if the title hasn't been derived yet (a race that resolves within the same turn — see below) and absent for good on a session that somehow never received a user message. Mobile should fall back to `projectName` when `sessionName` is unset, the same fallback already used elsewhere in this codebase (see `deriveProjectChatTitle`).

## What triggers a send

`onStatusChange` in `server.ts` is the single funnel every status transition passes through, for both the Claude and Codex runners, so hooking there covers every path. The notifier is **per-turn**, not per-session: it tracks whether a turn is currently open per session id, keyed off the specific status *edge*, not the status alone.

- **`waiting_input → running`** (the user sent a prompt) opens a turn and sends an `update`. This is the first push of a Live Activity's *content* — the Activity itself is still created client-side (foreground or a local trigger); the server cannot create one remotely today (see the push-to-start caveat below).
- **`running → waiting_input`** (the response — including any sub-agents, which are invisible to this signal since they run entirely inside the same `running` span — finished) closes the turn and sends an `end`.
- A session's **very first `running`** (right after spawn, before any prompt) has no prior `waiting_input`, so it opens nothing — this is what keeps a freshly booted or idling session from showing a Live Activity before the user has asked for anything.
- A **same-status re-emit** on an already-open turn (e.g. a `lastOutput` refresh) sends nothing **unless** `sessionName` has just become available and hasn't been sent yet, in which case one `update` carries the name so mobile can retitle the surface mid-turn. This exists because deriving the title races the turn itself — the first message is submitted and the turn opens before the title is necessarily attached to the in-memory session.
- Any non-renderable status while a turn is open (session ended) sends an `end` and expires the session's activity tokens locally, which is what stops a later renewal from resurrecting a finished session. If no turn was open (a session dies before or between turns), nothing is sent — there is no activity to close.

### Push-to-start is not wired to turn-open (yet)

Apple's ActivityKit push has two channels: the per-activity update token (`update`/`end` only) and the app-wide push-to-start token (`start`), which is the only way to create a new Activity remotely. This document's `update`/`end` flow above is entirely the per-activity channel — the server never attempts to create an Activity, only to update or end one mobile already has. `liveActivityRenewal.ts`'s `startReplacement()` is the one place today that fans out to the push-to-start token, and it currently sends `event: "update"` rather than `event: "start"` on that channel — worth fixing (Apple's push-to-start payload expects `start`), but that is a pre-existing bug distinct from the per-turn retiming described here, tracked separately.

Sends are fire-and-forget: a push must never delay or fail a session transition.
Failures are logged with session and activity context, never swallowed.

## Failure handling

APNs rejections fall into two categories that need opposite treatment:

- **Dead token** (`BadDeviceToken`, `DeviceTokenNotForTopic`, `Unregistered`, `ExpiredToken`) — expired locally and no longer a delivery target. Retrying one fails forever and makes the health report read "failing" when the truth is the device or activity is gone.
- **Transient** (503, timeouts) — the failure is recorded but the token is kept, because the device is still there.

One rejected token never stops the others: a single dead device would otherwise silence every other device watching the same session.

`GET /api/push/health` reports per-token state, including `expired` as distinct from `failing`.
It never echoes a token back.

## Renewal past the 8-hour cap

iOS ends a Live Activity roughly 8 hours after it starts, so a long session loses its surface mid-session unless the activity is replaced.
A renewal fires 30 minutes before each activity's `staleDate`: it sends an `end` for the old activity and asks the device to start a replacement.

**The original `startedAt` is carried through unchanged.**
This is the single most important property of the renewal path.
iOS renders its own ticking elapsed timer from that value, so a renewal that stamps a fresh start makes the user's visible timer reset to zero — a regression that is completely invisible server-side and only shows up on someone's Lock Screen.
`push_tokens.started_at` persists the original precisely so a restart cannot lose it, and the renewal prefers it over the session's own `startedAt` (which a resume can move forward).

### Why not Temporal

The repo depends on `@temporalio/client`, but it is reachable only under `MULTI_AGENT_FLOW`, where the PTY path this feature observes does not run.
Wiring renewal through Temporal would make Live Activities require a Temporal server in the default configuration.

Instead each activity's deadline is persisted (`push_tokens.stale_date`) and timers are re-armed on boot.
An in-process `setTimeout` alone is insufficient — it dies with the process, and a restart inside an 8-hour window would silently drop every pending renewal.

### Restart and idempotency

- Deadlines are read from the DB on every tick, so an activity registered after boot needs no re-arming.
- Firing is gated by `claimRenewal()`, a conditional `UPDATE ... WHERE renewed_at IS NULL`. It succeeds exactly once per row, so a timer re-armed after a restart mid-window cannot double-send.
- Timers sleep in bounded hops (max 1 hour) rather than one long sleep, which avoids `setTimeout`'s 2^31 ms overflow and limits drift across a laptop suspend.
- The timer is `unref`'d, so a pending renewal never holds the process open at shutdown.

### What is not renewed

A session that ended inside the renewal window is **not** resurrected.
The scheduler re-checks the live session store at fire time rather than trusting the stored row, and a session that is gone or no longer `running`/`waiting_input` has its token expired instead.
A device that never registered a push-to-start token still gets the `end`; the replacement simply cannot be started remotely, and the next foreground WebSocket update recreates it.

## tb-mobile: what's needed to use `sessionName` and the per-turn "Finished" state

The server-side pieces above (per-turn `update`/`end` timing, the new `sessionName` field) are ready to consume. Status of each item mobile needs:

- **Render a distinct "Finished" visual state on the `end` event** — **done**, for the foreground WebSocket path. `services/live-activity.ts`'s reconciler now mirrors `LiveActivityNotifier`'s per-turn open/close edges and renders the carried-through `waiting_input` as "Finished" rather than an ongoing state. See [`live-activity-mobile-finished-state.md`](./live-activity-mobile-finished-state.md) for the full port. The background/push path (ActivityKit decoding the payload directly while the app is suspended) needs no separate mobile code — it already renders from the same `LiveActivityContentState` this document defines — but was not independently verified on-device as part of this change.
- **Render a title from `sessionName`, falling back to `projectName`.** Not built. Same pattern as `deriveProjectChatTitle` on the server side. Since `sessionName` can arrive on a second `update` shortly after the turn opens (see the race note above), the Activity's title view needs to handle a `nil → non-nil` transition mid-turn, not just read it once at Activity creation.
- **Create the Activity client-side**, still — the server has no reliable way to create one remotely today. `event: "start"` is a distinct APNs push-to-start concept the renewal path uses for its own 8-hour-cap replacement, not a general "server tells mobile to start now" mechanism; see the push-to-start caveat above. A regular `update` pushed to a session with no registered `liveactivity_update` token is simply a no-op (`LiveActivitySender.send` finds zero tokens and returns early) — it does not create anything.
