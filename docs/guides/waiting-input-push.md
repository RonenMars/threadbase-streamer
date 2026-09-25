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

For Claude, `running → waiting_input` means the turn really ended: readiness follows Claude's OSC 9;4 turn signal, not the `❯` input box that stays painted all turn (see `CLAUDE.md` → Session lifecycle).
Before that, the push fired about 50 ms after every submit.

### Mid-turn prompts

A permission gate or an AskUserQuestion menu keeps the turn open, since Claude holds its turn signal across both, so the turn-end push cannot cover them.
`WaitingInputNotifier.onPrompt` pushes once when one opens, wired from `onPermissionChange` / `onLiveQuestion` in `server-wiring.ts`.
Repaints and cursor moves of the same prompt are not new prompts; the next push waits until that prompt closes (`gate === null`, `onLiveQuestionGone`) or the turn ends.
Codex usage-limit cards travel the same permission path, but `describeGate` (`notificationCopy.ts`) recognises them and they go out as their own `limited` kind: "Codex hit its usage limit", with the reset time when the screen shows one.
It also reads what an ordinary gate asks for from the gate's own chrome — Claude's `Bash command` title, Codex's command-approval heading, Claude's "Do you want to make this edit?" prompt — and anything it does not recognise stays "needs your approval".

## Always notify for a closed turn

A push goes out for every closed turn, including when a WebSocket client is still subscribed to that session.
Suppression-while-watched used to skip those as noise when the phone was already on the session screen, but the same check also silenced the phone whenever a desktop browser or a second device held a subscription — worse than a duplicate banner.
`sessionSubscribers` still drives hold-when-idle and fan-out; it no longer gates waiting-input push.

## Payload


This is a privacy decision, not a formatting one.

```json
{
  "to": "ExponentPushToken[...]",
  "title": "✅ <projectName> · <branch>",             // ✋ permission, 💬 question, ❌ failed, ⏳ limited; default branches omitted
  "subtitle": "Claude finished",                       // iOS only; Android gets it at the head of the body
  "body": "Worked for 12 min.",
  "data": { "sessionId": "...", "kind": "turn_done", "serverId": "..." },   // serverId omitted for tokens registered without one
  "sound": "default",
  "priority": "high",
  "threadId": "<sessionId>",
  "collapseId": "<sessionId>",
  "tag": "<sessionId>"
}
```

That is the whole payload.
`sound` is what makes the push audible on iOS at all; Expo plays nothing when it is omitted, which it was until this change.
`priority: "high"` delivers immediately on Android rather than in a batch.
`threadId` stacks one session's pushes together on iOS, and `collapseId`/`tag` let the newer push replace the older banner, so a "needs your go-ahead" that has been answered gives way to "finished".
`data.kind` (`turn_done`, `permission`, `question`, `failed`, `limited`) is additive; mobile routes on `sessionId` and ignores it today.

Beyond which session and which agent, the copy carries only metadata the streamer measured or classified itself (`AttentionFacts`): the turn's length in minutes, what kind of action a gate asks for ("run a command", "edit a file" — our words, never the command), how many options a single question offers, the session's `failureCode`, and a usage limit's reset time.
Naming the kind of action was a deliberate call: it is not a prompt, output or conversation content, though it does say what sort of thing the agent wants to do.
What each kind says, and the research behind it: [docs/design/notification-copy.md](../design/notification-copy.md).

The body is written per recipient token in the language its app registered (`locale` in `POST /api/push/register`, else the first `Accept-Language` tag, which iOS sends on every request; migration 025).
The copy lives in `src/services/push/notificationCopy.ts` for the languages tb-mobile ships (en, he, ar, ru); anything else gets English.
The non-English strings are machine-written and want a native review.
The agent name comes from the session's provider (Claude, Codex, Cursor) and is not session content.
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

## Notification preferences

What the phone's Settings → Notifications screen controls is enforced here, per token, at send time.
Before this the toggles lived only in the app, so none of them changed what was sent.

- **Storage.** `push_tokens.notification_prefs` (migration 026), one JSON blob validated by `NotificationPrefsSchema` (`src/schemas/notification-prefs.schema.ts`).
  `NULL` means the client never sent any, and that is read as everything on, so a released app keeps receiving exactly what it did.
  A stored blob that no longer parses is read the same way: failing open is deliberate, because a corrupt row must not silently mute the one push the user is waiting for.
- **Shape.** `{ waitingInput, sessionFailed, quietHours?: { enabled, tz, default: {from, to}, days?: { mon..sun: {from, to} | null } } }`.
  `waitingInput` gates the "agent needs you" kinds (`turn_done`, `permission`, `question`, `limited`).
  `sessionFailed` gates the failure push.
- **Quiet hours** drop the push; nothing is sent, and the token's delivery health is untouched.
  They are evaluated in `tz`, the phone's IANA zone, so "22:00" means the user's 22:00 and not the server's.
  A window that ends before it starts runs overnight and belongs to the day it *starts* on: Friday 22:00–08:00 covers Saturday until 08:00 and uses Friday's entry.
  A weekday in `days` replaces `default` for the window starting that day, and `null` means no quiet hours that day.
  `from === to` is an empty window, not 24 hours.
- **Per token.** `ExpoPushSender.send(message, { event })` filters rows one by one, so one device's quiet hours never mute another phone.
  `ExpoPushOutcome.suppressed` counts what was skipped, separately from `attempted`.
- **Routes.**
  `POST /api/push/register` accepts an optional `notificationPrefs` and keeps the stored ones when a later registration sends none.
  `PATCH /api/push/preferences` `{ token, prefs }` changes them without re-registering, which matters because a re-register resets `failure_streak` and `revoked_at` and would wipe the delivery health the health screen reports.
  It answers 404 `TOKEN_NOT_FOUND` for an unknown token, and for another device's token, so a client whose token is not registered yet learns its preferences were not stored.
  `POST /api/push/test` `{ token }` sends one real push to a token the caller owns and returns `{ ok, attempted, succeeded, state }`.
  It ignores preferences on purpose: a test muted by the user's own quiet hours would answer "does delivery work?" with silence.
- **Capability.** `push.preferences` on `GET /api/info` and `/api/push/health` is true when the server enforces preferences, so a client can tell an older server from one where the feature is off.

### The failure push

A session that dies before it ever reached a prompt — the process exits at once, or Codex refuses to start — gets one `failed` push: "*Claude* could not start", with a next step picked by `failureCode` (`project_dir_missing`, `instant_exit`, `codex_active_writer`; anything else reads "Open the session for details.").
The text never carries `failureReason`, which embeds project paths; that is why every runner's instant-exit diagnosis sets a code beside it.
It fires only on a session's first idle after it was never ready: a Codex session that hit a usage limit keeps its `failureReason` and goes idle when closed much later, and that is not a failed start.
Codex usage-limit screens arrive as a `limited` push instead.

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

- **No silent delivery.** Quiet hours drop a push rather than sending it without sound; that mode is tracked in RonenMars/threadbase-streamer#949.
- **No "session completed", "diff ready" or badge count.** The streamer has no event for the first two, and a badge count cannot be kept right across devices and servers, so the mobile toggles for them were removed rather than left inert.
- **No per-device targeting.** Every device paired with this streamer is notified; `expo` tokens carry no session scope, and the streamer has no model of which device is interested in which session.
- **No kill switch.** With no registered token the sender makes no request at all, which is the off state for a streamer nobody has paired a phone to.
