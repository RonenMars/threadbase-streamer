# Hold at next `waiting_input` after leave

**Date:** 2026-08-17
**Status:** Spec — not implemented
**Scope:** tb-streamer (WS hold path). Consumed by tb-mobile “Kill on idle” on in-app leave from a live session. Does **not** change app-backgrounding, `handleWsClose`, the 6 h idle reaper, or `POST /api/sessions/:id/stop`.

---

## Problem

Mobile wants three leave actions: Kill it, Leave it, Kill on idle.

Today the streamer has no “hold when this session next reaches `waiting_input`”:

| Primitive | What it actually does |
|---|---|
| `POST /api/sessions/:id/stop` | Immediate `putOnHold` (SIGINT). Empty unused sessions (`promptCount === 0` + no cache row) are forgotten (PR #645). |
| WS `{ type: "hold_session", sessionId }` | Arms `ptyGracePeriodMs` (default **270 s**), defers while `running` up to `GRACE_MAX_DEFERS` (4), then holds anyway. This is what mobile already sends on **app backgrounding**. |
| Idle reaper | Global, **6 h** of *agent* silence, never touches `running`. Not per-session, not a leave policy. |
| `handleWsClose` | Arms **nothing**. A dropped socket is not leave intent. |

Mapping Kill on idle onto `hold_session` would wait up to ~4.5 minutes (or cut after four defers) instead of holding at the end of the current turn. That is the gap.

## Goal

An explicit client intent: **keep the current turn; hold the PTY on the next `running → waiting_input` (or immediately if already settled).** No grace delay. No defer cap. Do not cut `running`.

## Non-goals

- Do not change the meaning of a bare `hold_session` (released apps, backgrounding).
- Do not arm anything on WebSocket close.
- Do not make the 6 h reaper per-session or configurable here.
- Do not add a REST route if the WS control verb already exists.
- Do not persist the latch across streamer restart (grace timers are also in-memory).
- Do not bump the pty-host protocol: `putOnHold` already maps to `kill` + `hold: true`; status-change events already reach the streamer.

## Wire

Additive optional field on the existing client → server frame:

```json
{ "type": "hold_session", "sessionId": "<id>", "when": "waiting_input" }
```

| `when` | Behaviour |
|---|---|
| omitted or `"grace"` | **Today.** `startGraceTimer(sessionId, ptyGracePeriodMs)`. |
| `"waiting_input"` | Arm the latch described below. |
| any other value | Ignore the frame (same as malformed JSON): do not hold, do not arm grace. Log at warn `pty.hold_when_unknown`. |

Unknown fields on old streamers are ignored, so a new mobile sending `when: "waiting_input"` to a server that predates this spec **degrades to grace**. That is acceptable: the PTY still holds, just later. Do not add a feature flag. An additive `GET /api/info` bit is optional later if mobile wants to hide the choice on old servers; v1 does not need it.

Capability: same as today — `session:control`. Read-only sockets are denied; do not fall through to grace.

## Latch

In-memory `Set<string>` on `StreamerServer` (same lifetime as `ptyGraceTimers`). Name it `holdWhenIdle`. Not a registry column.

### Arm (`when: "waiting_input"`)

1. Require `session:control`.
2. If there is no live PTY (`ptyManager.hasSession` is false): no-op. Same as a grace hold on an already-idle session.
3. **Last writer wins** against the grace timer: clear any `ptyGraceTimers` / `ptyGraceDeferCounts` for this id, then either hold or latch. A later bare `hold_session` clears the latch and starts grace. The two modes must not both be armed.
4. Read current status from the runner/store:
   - `waiting_input` or `idle` → `putOnHold` **now**. The leave is explicit; do **not** wait for a later edge. The leaving socket may still be subscribed for a frame — that must not block the hold (see *Return cancels*).
   - `running` → add `sessionId` to `holdWhenIdle`. Log `pty.hold_when_idle_armed`.
5. After a hold from this path, if the session is empty unused (`promptCount === 0` and no cache row), call the same `forgetSession` stop already uses. Otherwise History grows another 0-prompt stub.

### Fire

Single funnel: `onStatusChange` (the one in `server-wiring.ts` that already sees every runner, including pty-host).

When `session.status === "waiting_input"` (or `idle`) **and** `holdWhenIdle` has the id:

1. Delete the id from the set **first** (so the ensuing idle transition cannot re-enter).
2. If `hasSessionSubscriber(sessionId)` is true (an OPEN socket is subscribed): **cancel, do not hold.** Log `pty.hold_when_idle_cancel` with reason `subscriber`. Another client is watching; yanking the PTY would steal it.
3. Otherwise `putOnHold`, then the empty-forget check. Log `pty.hold_when_idle_fire`.

Do **not** fire on the first boot `waiting_input` of a fresh session. The set is empty unless a client armed it.

Do **not** use `GRACE_MAX_DEFERS`. A turn that never settles stays `running`; the 6 h reaper still skips `running`. Same bound as “Leave it”.

### Return cancels

`addSessionSubscriber` already cancels the grace timer because someone is looking. Also `holdWhenIdle.delete(sessionId)` there. Log `pty.hold_when_idle_cancel` with reason `subscribe`.

Clear the latch on `putOnHold` / process exit as well (stop, reaper, grace kill) so a held session cannot fire after resume unless the client arms again.

`POST /api/sessions/:id/input` from a non-subscriber does **not** cancel. If a second client prompts without subscribing, the latch still fires at the end of that turn. Subscribe is the “I am watching” signal; HTTP input is not. Document that; do not invent a third signal.

## Ordering mobile must keep

1. Send `{ type: "hold_session", sessionId, when: "waiting_input" }`.
2. Then navigate away (unsubscribe).

If the session is already `waiting_input`, step 1 holds immediately (step 4 of Arm). If it is `running`, step 1 latches and step 2 drops the subscriber so the later edge is allowed to fire.

Do not unsubscribe first and then send: a lost frame would leave the PTY running with no latch (indistinguishable from Leave it).

App backgrounding stays a **bare** `hold_session` (grace). This spec is in-app leave only.

## pty-host

No protocol change. The latch lives on the streamer. Host `status-change` already drives `onStatusChange`. `putOnHold` already becomes `kill` + `hold: true`. A streamer restart drops the latch (PTY may survive on the host); the session keeps running until the client re-arms or the 6 h reaper. Same durability as grace timers.

## Tests

- Already `waiting_input`: `when: "waiting_input"` holds immediately; no grace delay; PTY gone; empty unused is forgotten.
- `running` then `waiting_input`: holds on that edge, not before, not after a 270 s wait.
- `running`, then `subscribe_session`, then `waiting_input`: latch cancelled; session still live.
- `running`, latch armed, a *different* OPEN subscriber exists at the edge: cancel, do not hold.
- Bare `hold_session` after a latch: latch cleared, grace timer armed (and the reverse).
- Read-only principal: denied, no latch, no hold (`session:control`).
- Unknown `when`: no hold, no grace, warn log.
- Unknown session id: no-op.
- First boot `waiting_input` with an empty set: no hold.
- Codex and Claude runners both fire through `onStatusChange` (spy either runner’s `putOnHold` / status bus).

Do not require a pty-host protocol test. Do not touch Task Scheduler / `prod stop`.

## Mobile (separate PR, after or with this)

Kill on idle sends `when: "waiting_input"`. Kill it stays `POST /stop`. Leave it sends nothing. Empty unused discard (`promptCount === 0`) stays `POST /stop` with no modal. Backgrounding stays bare `hold_session`.

Old streamers: extra field ignored → grace. Product-acceptable degrade; call it out in the mobile PR body.

## Suggested issue

`P2: Hold a session at next waiting_input after leave`  
labels: `P2`, `enhancement`, `provider`, `ux`

Conventional commit: `feat(sessions): hold at next waiting_input when leave asks for idle kill`
