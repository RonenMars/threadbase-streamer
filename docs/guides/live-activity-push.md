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
| `APNS_KEY_ID` | No | `BX4B6855WV` | Key id of the p8 above. |
| `APNS_TEAM_ID` | No | `GUW6BN8X57` | Apple Developer team id. |
| `APNS_BUNDLE_ID` | No | `com.ronenmars.threadbase` | App bundle id. The APNs topic is this plus `.push-type.liveactivity`. |
| `APNS_HOST` | No | `api.sandbox.push.apple.com` | Set to `api.push.apple.com` for production. |

The default host is **sandbox**, because the app's `aps-environment` is still `development`.
A build signed for production will not receive sandbox pushes, and vice versa — a mismatch here is the most common reason pushes silently never arrive.

### Supplying the key

The signing key lives in 1Password, not on disk.
The operator exports it before starting the server:

```bash
export APNS_KEY="$(op read 'op://Personal/Threadbase-p8-file-Notifications-APNs/AuthKey_BX4B6855WV.p8')"
```

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
