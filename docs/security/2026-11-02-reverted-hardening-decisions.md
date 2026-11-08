# The three hardening fixes reverted by #220

**Date:** 2026-11-02
**Subject:** M4, M5 and L1 from [docs/plans/2026-06-24-security-hardening.md](../plans/2026-06-24-security-hardening.md), shipped in #213 and reverted wholesale by #220 to green `main`.
**Raised by:** #485.
**Status:** M4 fixed. M5 and L1 accepted, with the assumption each one rests on.

None of the three was ever re-landed.
This file records what became of each, so a reverted security PR is not carried silently.

## M4 — progress webhook replay: fixed

**Before.** `isWithinSkew` returned `true` when the timestamp header was absent, and the signature covered only the body.
A captured request therefore replayed indefinitely on `POST /internal/sessions/:id/progress`.

**Now.** `X-Timestamp` is required, the signature is `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`, and the window is `agentConfig.webhook.timestampSkewSeconds`.
There is no body-only fallback.
The contract is in [docs/multi-agent-mode.md](../multi-agent-mode.md#progress-webhook-signing).
Tests: `__tests__/agent/progress-route.test.ts` (missing, unparseable, stale, future, body-only and refreshed-header replay all give 401).

**Reach.** The route only answers under `MULTI_AGENT_FLOW`, which is off by default.
The worker that signs these requests is a separate repo and moves to the same contract on its own schedule; until it does, multi-agent mode will reject its events with 401.

## M5 — `answerKeys` broadcast without sanitization: accepted, defense in depth

**Why accepted.** Sanitizing the broadcast would not remove a capability anyone holds.
`permissionAnswerKeys` (`src/services/questions/permissionAnswerKeys.ts`) already throws on a non-integer or negative index, so the streamer never builds a hostile `answerKeys` string itself.
Separately, mobile sends raw keystrokes through `/input` by design, so an authenticated client can already write arbitrary bytes to the PTY.
The fix would defend against a client that already has that authority.

**Stops being acceptable when** a client that must not write arbitrary bytes can still receive or relay `answerKeys`: a read-only audience on the same WebSocket, or `/input` narrowed to structured answers only.
Either change makes the broadcast the one path left that carries bytes, and it should be validated then.

## L1 — `hold_session` and `subscribe_session` have no ownership check: accepted

**Why accepted.** One server is one user, and every paired client is a device of that user.
Both frames are capability-checked per frame (`hold_session` needs `session:control`, `subscribe_session` needs `history:read`), but neither asks whether *this* client owns *that* session id.
That is the same property recorded in [2026-08-15-paired-device-authority.md](./2026-08-15-paired-device-authority.md): a paired device sees and controls everything on the machine.
A `clientId` → `sessionId` map in `src/ws-hub.ts` would enforce a boundary the product does not have.

**Stops being acceptable when** the streamer serves more than one user: a shared or multi-tenant server, or devices paired to the same server for different people.
At that point both frames need an ownership check, and the `subscribe_session` comment ("the seam any future per-project scoping hangs off") is where it goes.
That change would also have to cover `session_list`, which is unicast whole.
