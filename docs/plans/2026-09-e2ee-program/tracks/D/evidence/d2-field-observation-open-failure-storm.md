# D2 field observation — a second device storms `POST /api/e2ee/open`, 2026-09-02 11:40–11:46 IDT

Rig: isolated streamer `v1.73.0` on `:8790`, `--feature e2ee=true`. Two paired iPhone rows.

## What was observed

Counted from the rig log, `path=/api/e2ee/open`:

| status | count |
|---|---|
| 200 | 10 |
| 400 | 168 |
| 429 | 43 |

400s per minute: 26, 22, 28, **30, 30**, 29, 3 — i.e. the source is pinned at the ceiling and the excess comes back as 429.

The storming client's UA is `CFNetwork/3860.700.1 Darwin/25.6.0`; the D2 device is `Darwin/25.5.0`. It is the second (iPhone 17 Pro) device, whose stored pairing no longer matches this scratch rig. The D2 device kept opening contexts successfully throughout (`e2ee.context_opened` at 08:42:47, 08:42:48, 08:44:23).

## Three separate readings

**1. The failure budget works, confirmed in the field.** `OPEN_SOURCE_FAILURE_LIMIT = 30` per source per minute (`src/api/rate-limit.ts`) held exactly: 30/minute of failed handshakes admitted, the rest refused 429, and a healthy device on a different LAN address was unaffected. This is the first live-fire confirmation of that constant.

**2. The tunnel case is the one to worry about, and the code already says so.** `rate-limit.ts` warns that behind a Cloudflare tunnel every request arrives from `127.0.0.1`. On LAN the two devices had separate addresses and separate budgets. Through `tb-secured.rbv1000.win` they would share one, and this single misconfigured device would have consumed the whole fleet's budget — the exact scenario the comment describes, now with a real device producing it rather than an adversary.

**3. Client-side hypothesis, not yet confirmed.** `E2EE_HANDSHAKE_FAILED` is classified non-retryable on the client (`services/e2ee/context.ts:80`), and both consumers honour it: `ws-client.ts:231` returns without scheduling a reconnect, and `sealedFetch` throws `EnvelopeError(..., retryable=false)` (`services/authed-fetch.ts:381`). Yet the requests continue indefinitely. The likely explanation is the layer *above* — screen-level polling/refetch re-issues the query on its own schedule, and nothing consults `retryable` to stop polling a server that has hard-refused. Unconfirmed: it needs the 17 Pro's own client log, which was not captured.

## Server-side gap — narrower than first written, and now fixed locally

The route is not silent in general: `e2ee.open_replayed` and `e2ee.open_refused` (unknown or revoked device) both write a line on `origin/main`. The gap is specific — **the `readMessage1` failure branch wrote nothing**, and that is the branch a device pinned to a different server identity hits on every attempt, forever. 168 refusals left only HTTP request lines.

That also identifies the cause here without needing the phone: a 400 rather than the unknown-device 403 means the handshake itself failed, i.e. the 17 Pro is pinned to a server identity that is not this scratch rig's. It is pointed at a hostname that now routes to the D2 rig, and it will recover on its own once that hostname points back.

Fixed locally on `feat/e2ee-open-refusal-log` (not pushed): the handshake-failure branch logs `e2ee.open_refused` with `reason: "handshake"`, the existing unknown-device line gains `reason: "unknown_device"`, and the post-handshake bad-payload branch logs too. The uncharged branches — malformed body, both `429`s — stay deliberately silent, because a line there is an unbounded disk write an unauthenticated caller controls; a test pins that silence.

## Not a stop-work trigger

No plaintext frame, no key, token or ticket in any log or capture. Recorded rather than acted on: the user asked that the 17 Pro be left connected.
