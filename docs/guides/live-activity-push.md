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
}
```

Two constraints are easy to get wrong and fail silently, because an ActivityKit decode failure produces no server-side error — the surface simply stops updating:

- **`startedAt` is epoch milliseconds, and is the session's start.** iOS renders its own ticking elapsed timer from it. Never send a precomputed elapsed value, and never push per-second updates. A renewal must carry the original value through unchanged, or the user's visible timer resets to zero.
- **`status` has exactly two values.** `idle` has no representation; a session that is no longer live gets an `end` event instead of an update.

The whole payload must stay under APNs' 4 KB limit, which is what `lastOutput`'s 90-character bound is for.

## What triggers a send

`onStatusChange` in `server.ts` is the single funnel every status transition passes through, for both the Claude and Codex runners, so hooking there covers every path.

- `running` ↔ `waiting_input` sends an `update`.
- Any non-renderable status (session ended) sends an `end` and expires the session's activity tokens locally, which is what stops a later renewal from resurrecting a finished session.
- An unchanged status sends nothing. Live Activity pushes are rate-limited by iOS, so re-pushing the same status spends budget for no visible change.

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
