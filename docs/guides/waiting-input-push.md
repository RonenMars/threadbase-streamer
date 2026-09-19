# Waiting-for-input push

The notification the away-from-desk workflow depends on: the agent finished its turn, and it is the user's move.
They put the phone down expecting to be told.

Tracked as [#528](https://github.com/RonenMars/threadbase-streamer/issues/528).

## Why Expo and not APNs

`ApnsClient` signs its own pushes with an APNs `.p8` and targets `${bundleId}.push-type.liveactivity`.
Apple issues those keys per developer team, and a key signs only topics for bundle ids that team owns — so a self-hosted streamer's key cannot sign for the published app, no matter how it is configured.
Anything built on that path works for the maintainer and nobody else.

Expo already holds the app's APNs and FCM credentials, uploaded once by whoever built it, and mobile already registers an Expo token (`getExpoPushTokenAsync()` → `ExponentPushToken[...]`).
So any streamer can deliver with a plain POST and no Apple credential at all:

```
POST https://exp.host/--/api/v2/push/send
Content-Type: application/json

[{ "to": "ExponentPushToken[...]", "title": "...", "body": "...", "data": { ... } }]
```

Self-hosting is the primary deployment, so ordinary notifications go through Expo.
Live Activities stay on direct APNs because ActivityKit cannot use the relay — different token kind, different topic, p8 required.

## Auth

Sends are **unauthenticated by default**, and `THREADBASE_EXPO_ACCESS_TOKEN` adds `Authorization: Bearer <token>` when set.

Expo's enhanced-security mode restricts senders to holders of an access token issued for that Expo project.
Only the project owner can issue one, and a self-hoster does not own the project — so requiring a token would lock out exactly the deployment this transport exists to serve, and turning enhanced security on for the project would break every self-hosted streamer at once.

The residual exposure is that anyone holding a device's push token can send that device a notification.
The token is only handed to streamers the user paired, it carries no session content, and the streamer never echoes one back (`GET /api/push/health` deliberately omits it).
The env var is there so a deployment that *does* own the Expo project can tighten this; the token is never logged.

## Trigger

`WaitingInputNotifier.onStatusChange` hooks the same `onStatusChange` funnel in `server.ts` that `LiveActivityNotifier` uses.
That callback is where every status transition of both runners lands, so it covers all three `markReady` detectors — prompt-marker, screen-marker and the timeout fallback — without knowing any of them exist.

Per-turn, not per-status:

| Edge | Effect |
|---|---|
| `waiting_input → running` | Opens a turn (the user sent a prompt) |
| `running → waiting_input` with an open turn | **Notifies**, and closes the turn |
| `running → waiting_input` with no open turn | Nothing — boot/resume ready, or a second detector firing for a turn already closed |
| `→ idle` | Drops any open turn; a dead PTY answers nobody |

The open-turn set is what makes the double-send impossible: a second `markReady` for one turn finds the turn already deleted.
It is also why starting a session never notifies the user about the session they just started.

`PTYManager` guards the same case one layer down, verified rather than assumed: all three `markReady` call sites require `status === "running"`, and `markReady` itself sets `waiting_input`, clears `pendingReady` and cancels the fallback timer — so the timeout fallback cannot fire after a marker already settled the turn.
The notifier's own guard still earns its place: it covers the Codex runner and any future detector through the same funnel.

## Always notify for a closed turn

A push goes out for every closed turn, including when a WebSocket client is still subscribed to that session.
Suppression-while-watched used to skip those as noise when the phone was already on the session screen, but the same check also silenced the phone whenever a desktop browser or a second device held a subscription — worse than a duplicate banner.
`sessionSubscribers` still drives hold-when-idle and fan-out; it no longer gates waiting-input push.

## Payload


This is a privacy decision, not a formatting one.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "<projectName>",
  "body": "Waiting for your input",
  "data": { "sessionId": "...", "serverId": "..." }   // serverId omitted for tokens registered without one
}
```

That is the whole payload.
`sessionId` and `serverId` are what mobile's `sessionRouteFromNotificationData` needs to route the tap to the session. `serverId` is the id the app files *this* server under, sent by the app as `serverId` in `POST /api/push/register` and echoed back per token — not the streamer's hostname, which the app has no entry for. One phone registers the same push token with every server it has paired, so each server's row carries a different id. A token with none (an app that predates this) gets no `serverId` and the app falls back to its default server; `projectName` is what makes the notification actionable when several sessions are live.

**Deliberately absent: `lastOutput` and `sessionName`.**
`lastOutput` is raw PTY output, so any session that prints a token or an env var would put it in a notification; `sessionName` is derived from the user's first message, which is prompt content.
Carrying both is exactly the divergence [threadbase-mobile#636](https://github.com/RonenMars/threadbase-mobile/issues/636) is open about on the Live Activity path — this path must not repeat it.

The published policy (`threadbase-mobile` `docs/privacy-policy/proposed-privacy-policy.md:51`) says:

> To deliver notifications, your streamer also sends a notification payload through Expo's push service.
> Threadbase is designed so these payloads do not include prompts, terminal output, credentials, or conversation content.

This payload matches that text as written, and the transport sentence — "through Expo's push service" — becomes true of this path for the first time.
It also survives a rewrite of that paragraph: no wording of "excludes prompts, terminal output, credentials and conversation content" can be violated by a payload carrying none of them.
`__tests__/expo-push.test.ts` asserts the absence of both fields, so a later addition fails a test rather than a policy review.

Adding *any* session content here is a maintainer decision that changes legal copy in two repos.
Change the policy text first.

## Failure handling

Expo returns one ticket per message, positionally matched to the request array, so a batch is not all-or-nothing.

- `status: "ok"` → `recordSuccess`.
- `details.error === "DeviceNotRegistered"` → the app is gone or the token rotated: `recordFailure` **and** `revoke`, which drops the row out of `listDeliverable()`.
  Retrying it forever would make `GET /api/push/health` read "failing" when the truth is the device no longer exists.
  This mirrors `LiveActivitySender` expiring a dead APNs token rather than inventing a second policy.
- Any other ticket error (`MessageRateExceeded`, `MessageTooBig`, …) → `recordFailure` only.
  The repository's own `FAILURE_STREAK_LIMIT` retires a token that keeps failing.
- A request-level rejection (`!res.ok`) → `recordFailure` for every token in the chunk, and no eviction: the response says nothing about any individual device.
- A network error → `recordFailure` with `SendError`, logged at error.
  A push must never fail a session transition, so the notifier swallows and logs rather than propagating.

Tokens are batched 100 per request (Expo's cap) and `listDeliverable()` returns Expo-kind rows only, so an ActivityKit token can never reach the relay.

## What is not here

- **No quiet hours.** Mobile owns that setting client-side today.
- **No per-device targeting.** Every device paired with this streamer is notified; `expo` tokens carry no session scope, and the streamer has no model of which device is interested in which session.
- **No kill switch.** With no registered token the sender makes no request at all, which is the off state for a streamer nobody has paired a phone to.
