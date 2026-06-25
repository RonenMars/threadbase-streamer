# Design note — idle-session Expo notifications (Part 2)

**Status:** proposed, not implemented. Separate PR/milestone from the grace-timer fix.

## Goal

Periodically detect streamer-managed sessions that have been sitting in
`waiting_input` for a long time (user walked away mid-conversation) and send the
user an Expo push notification suggesting they stop the session — with a deep
link that calls the existing `POST /api/sessions/:id/stop`.

This is **additive** to the grace timer, not a replacement:

- **Grace timer** (`server.ts:startGraceTimer`) = resource reclamation. Holds an
  *abandoned* PTY after `ptyGracePeriodMs` (4.5 min) of no WS subscriber. Now
  gated to never interrupt a `running` session (see grace-timer fix).
- **Idle-notification sweep** (this note) = a UX nudge for sessions the user left
  parked at the prompt. Different trigger, different goal. Keep both.

## Trigger

A periodic job (every ~5 min) scans the in-memory `SessionStore` for sessions
where:

- `status === "waiting_input"`, AND
- `now - lastActivityAt > IDLE_NOTIFY_THRESHOLD_MS` (default 10 min), AND
- not already notified for this idle stretch (per-session notify-state).

For each match, send one Expo push to the device(s) registered for that server.

## Pieces required

1. **Persistent push-token store (SQLite).** Sessions are in-memory, but push
   tokens must survive restarts. This is the one place a new SQLite table IS
   justified (unlike a temp-conversation table). Schema roughly:
   `push_tokens(token PRIMARY KEY, client_id, platform, created_at, last_seen)`.
   Fed by the existing `POST /api/push/register` endpoint (currently registers a
   token; wire it to persist here).

2. **Expo send service.** Call Expo's push API
   (`https://exp.host/--/api/v2/push/send`) with the registered tokens. Handle
   Expo receipts / `DeviceNotRegistered` to prune dead tokens. New module, e.g.
   `src/services/notifications/expoPush.ts`.

3. **Sweep job.** `setInterval` (~5 min) over `SessionStore`, applying the
   trigger above. Lives alongside server lifecycle (start in `server.listen`,
   clear in `server.close`). Env-tunable: `IDLE_NOTIFY_SWEEP_MS`,
   `IDLE_NOTIFY_THRESHOLD_MS`, default off via `IDLE_NOTIFY_ENABLED`.

4. **Per-session notify-state.** Track which sessions were already notified for
   the current idle stretch so the 5-min sweep doesn't spam every cycle. Reset
   when the session transitions out of `waiting_input` (user came back / sent
   input). In-memory (Map keyed by sessionId) is fine — it's ephemeral like the
   session.

5. **Notification payload + deep link.** Title/body suggesting "Session X has
   been idle 12m — stop it?" with a data deep link the app routes to the session
   and offers a Stop action → `POST /api/sessions/:id/stop` (plumbing already
   exists from #122).

6. **Mobile side (separate tb-mobile PR).** Register for push, handle the
   notification tap → deep-link to the session, wire the Stop action. Register
   token via `POST /api/push/register`.

## Backward-compat / safety

- Default **off** (`IDLE_NOTIFY_ENABLED` unset) — opt-in, no behavior change for
  existing deployments.
- Additive: new table, new optional env vars, no changes to existing endpoints
  or response shapes (tb-mobile compat rules satisfied).
- A session has no inherent "owner user" — notifications target all tokens
  registered for that server instance. Acceptable for the single-user
  self-hosted model; revisit if multi-user.

## Why not fold this into the grace-timer fix

The grace fix is a bug (don't SIGINT a running session). This is a feature with
its own persistence, an external API (Expo), a sweep loop, and a mobile change.
Bundling them would violate one-concern-per-PR and drag a focused bug-fix into a
multi-file feature review.
