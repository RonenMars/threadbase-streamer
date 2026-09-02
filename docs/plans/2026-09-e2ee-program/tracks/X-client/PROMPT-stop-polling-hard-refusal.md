# Brief — the client keeps polling a server that hard-refused the handshake

**Status: not implemented, deliberately.** This is a prompt for a later session, written while the evidence was fresh (2026-09-02). Nothing in it has been built.

**Update, same day, 15:30 — CONFIRMED with a reproduction.** D2 row 8 revoked a paired device while the app was open and reproduced the storm on demand: 10 × 403 then 60 × 429 in under two minutes, still going. Full evidence and the mechanism in `tracks/D/evidence/d2-row8-revocation-and-the-429-laundering.md`. Step 1 below is therefore already done for the *trigger*; what remains unidentified is only which layer above the transport issues the retry.

**The mechanism, which this brief originally guessed at and now does not have to:** a permanent refusal launders itself into a retryable one. `403 E2EE_DEVICE_REVOKED` is non-retryable and is surfaced accurately ("This device is not paired for encryption"). Something above the transport retries it anyway. Those retries charge the server's per-source failure budget, so the server starts answering 429 — and `services/e2ee/context.ts:212-214` maps 429 to `E2EE_TRANSIENT`, which **is** retryable. The client then believes a permanent condition is temporary and retries forever, while the on-screen text degrades to the false "The server is busy; retrying shortly".

So the fix has two halves, and the second one alone is not enough:
1. a non-retryable verdict for a server must survive a later 429 — that 429 is the limiter reacting to our own retries, not new information;
2. the retry above the transport must consult `retryable` at all, since it fires before any 429 exists.

Repo: `threadbase-mobile`. Local-only for now; no branch, no PR.

## What was observed

During D2 device evidence, a second paired iPhone (UA `CFNetwork/3860.700.1 Darwin/25.6.0` — the 17 Pro, not the D2 device) held an isolated streamer `v1.73.0` rig at its failure ceiling for six straight minutes: 168 × `POST /api/e2ee/open` → 400, 43 × 429, pinned at exactly 30 failures per minute. It never gave up on its own. Full counts and the log slice: `tracks/D/evidence/d2-field-observation-open-failure-storm.md`.

The device's stored pairing no longer matched that scratch rig, so every handshake failed the same way — a permanent condition, retried indefinitely.

## Why this is odd

The client already classifies this correctly at the transport layer, and both consumers honour it:

- `services/e2ee/context.ts:80` — `retryable` is true only for `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT`, so `E2EE_HANDSHAKE_FAILED` is non-retryable by construction.
- `services/ws-client.ts:231` — `if (error instanceof OpenError && !error.retryable) return`, with no `_scheduleReconnect()`. The socket layer genuinely stops.
- `services/authed-fetch.ts:381` — `sealedFetch` throws `EnvelopeError(code, message, path, /* retryable */ false)`.

So the requests are almost certainly not coming from the retry paths. They are coming from something **above** them that re-issues the request on its own schedule and never reads `retryable` — screen-level polling, a refetch interval, a focus/foreground refetch, or React Query's own retry defaults on the queries that call `authedFetch`.

## Step 1 — confirm before building anything

Do not implement against this hypothesis. Confirm the layer first:

- Reproduce: pair a device to a rig, then invalidate the pairing server-side (rebuild the rig's device rows, or revoke) and leave the app on a polling screen.
- Capture the client's own log (`POST /api/__client-log` reaches the rig, or Metro's console). The earlier storm was diagnosed from the *server* side only, which is exactly why the layer is still a guess.
- Identify the concrete caller: which hook, which query key, which interval.

If the storm turns out to originate inside the transport layer after all, this brief is wrong — write up what actually happened and stop.

## Step 2 — the shape of the fix, once confirmed

Smallest change that makes a permanent refusal permanent:

- One place remembers that this `serverId` hard-refused, and the polling layer consults it. Prefer whatever per-server state already exists over a new store.
- It must clear on the events that could genuinely fix the condition: re-pairing, a pin change, the user retrying explicitly. It must not clear on a mere foreground or a network blip, or the storm returns with extra steps.
- The user must see it. A server stuck in this state should say so, not sit silently on a spinner that never resolves. Check what the existing pairing-error surfaces already offer before adding one.
- Never fall back to the URL credential, and never downgrade to plaintext — the existing comment at `ws-client.ts:229-231` states this and it stays true here.

## Verification bar (program standard)

- Real objects on the production path — the real classifier and the real polling caller, not a stubbed seam for the transition under test.
- Positive control: a `retryable` refusal (`E2EE_CTX_UNKNOWN`, `E2EE_TRANSIENT`) still retries; prove the harness sees a retry happen.
- Negative control: with the guard removed, the test observes the repeated calls — the storm must be visible before the fix suppresses it.
- Falsifiability mutation per rule, reported as `<file>::<test>` plus the verbatim assertion.

## Related, not the same thing

The server-side gap is separate and is being fixed in the streamer: 168 refused handshakes emitted no `e2ee.*` event at all, so a device stuck this way is undiagnosable server-side. That fix does not remove the need for this one — it only makes the next occurrence visible.
