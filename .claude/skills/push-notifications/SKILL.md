---
name: push-notifications
description: tb-streamer push delivery: the waiting-for-input Expo notification and the iOS Live Activity APNs path — triggers, payload contract shared with tb-mobile, suppression rules, and dead-token handling. Use when touching notifications, push tokens, Live Activities, or the content-state shape.
---

# Push Notifications

Moved out of the repo root `CLAUDE.md` so it loads on demand rather than in every session.
## Waiting-for-input push

The one notification the away-from-desk workflow depends on: the agent finished its turn and it is the user's move. `WaitingInputNotifier` + `ExpoPushSender` (`src/services/push/`) send it through Expo's relay with a plain `POST https://exp.host/--/api/v2/push/send` — **no Apple credential**, one code path for iOS and Android.

That transport choice is structural, not a preference. An APNs `.p8` signs only topics for bundle ids its developer team owns, so a self-hosted streamer can never push to the published app; Expo holds the app's APNs and FCM credentials, so any streamer can. Self-hosting is the primary deployment, which is why ordinary notifications go through Expo and only Live Activities go direct to APNs.

- **Trigger** — the same `onStatusChange` funnel Live Activities use, on the `running → waiting_input` edge of a turn the user opened (`waiting_input → running`). Boot/resume ready opens no turn and notifies nothing, and a second ready detector firing for one turn finds the turn already closed.
- **Suppressed while watched** — no push when a WebSocket client is subscribed to that session. Mobile subscribes while the session screen is open and the socket dies on backgrounding, so this is the "the user is already looking" signal.
- **Payload** — `title: projectName`, `body: "Waiting for your input"`, `data: { sessionId, serverId }` (mobile routes the tap from those two). Deliberately **no `lastOutput` and no `sessionName`**: raw terminal output and a prompt-derived title are exactly what the privacy policy says notifications exclude — see [docs/guides/waiting-input-push.md](docs/guides/waiting-input-push.md) before adding a field.
- **Dead tokens** — an Expo ticket of `DeviceNotRegistered` revokes the token, mirroring how `LiveActivitySender` expires a dead APNs one. Every other error only counts toward the failure streak. Tickets are per-token in one batched response, so one dead device never silences the rest.

## iOS Live Activity push

Gated by the `liveActivityPush` [feature flag] (see the feature-flags skill), **off by default** — `APNS_KEY` alone no longer brings this up, and a box with credentials configured logs `live_activity.disabled` at boot until the flag is set.

`APNS_KEY` enables direct-to-APNs Live Activity pushes (Lock Screen / Dynamic Island surfaces for running sessions). ActivityKit **cannot** go through Expo's relay — different token type, `.push-type.liveactivity` topic, p8 credential — so this path uses `node:http2` directly and never `expo-server-sdk`.

Three token kinds now arrive from one device and are not interchangeable: `expo` (relay, ordinary notifications), `liveactivity_start` (push-to-start, app-wide), `liveactivity_update` (per-activity, short-lived). `PushRepository.listDeliverable()` is Expo-only — that query is what keeps the ordinary notification fan-out from handing an ActivityKit token to Expo.

The content-state shape is a **contract shared with tb-mobile** (decoded by a Swift `Codable` struct). An ActivityKit decode failure is silent — the surface just stops updating — so changing a field name or type requires a coordinated tb-mobile change. `startedAt` is epoch **milliseconds** and iOS renders its own ticking timer from it: never send a computed elapsed value, and carry the original value through a renewal or the user's timer visibly resets to zero.

`LiveActivityNotifier` is **per-turn, not per-session**: a push fires on the `waiting_input → running` edge (turn starts) and the matching `running → waiting_input` edge (turn — including sub-agents — ends), not on every status transition. A fresh session's first `running` has no prior `waiting_input`, so booting/idling never opens an activity. `sessionName` (derived from the first user message, `src/utils/deriveSessionName.ts`) is included in content-state and mobile should fall back to `projectName` when it's unset.

Capability is reported to clients on `GET /api/info` and `GET /api/push/health` as an additive `push` object (`liveActivity`, `notifications`, `liveActivityReason`), built by `describePushCapability()` in `src/api/routes/misc.routes.ts`. `liveActivity` comes from the server's own wiring state (`liveActivityNotifier !== null`) rather than a re-read of the environment, because credentials alone do not enable it — the sender is only built when the push token store opened too. `available` on `/api/push/health` deliberately still means "the token store opened", not "credentials are present": released mobile builds render it verbatim as "Push store is available / unavailable (registration cannot persist)", so retargeting it would make every credential-less server tell users their registrations do not persist.

Full contract, env vars, failure handling: [docs/guides/live-activity-push.md](docs/guides/live-activity-push.md).

