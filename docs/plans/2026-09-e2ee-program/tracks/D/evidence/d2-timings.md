# D2 timing measurements — 2026-09-02 ~18:05 IDT

Instrument: `d2-timings.ts` (in this folder), run with `npx tsx` from the streamer worktree against the live rig on `:8790` (v1.73.0 + the local chain, e2ee on). It pairs a scratch device with a real Noise `IKpsk1` exchange over the real public endpoint, opens real contexts, and times what the server does. Nothing is stubbed; the streamer's own `noise.ts` and `record.ts` supply the client side, exactly as its tests do.

Kept with the evidence rather than shipped in the streamer: it is a measuring instrument for this track, not a product script.

## 1. WebSocket first-sealed-frame deadline

Constant under test: `WS_FIRST_FRAME_DEADLINE_MS = 10_000` (`src/ws-hub.ts:44`).

| Run | Behaviour | Result |
|---|---|---|
| Silent socket — spends a ticket, upgrades, never sends a frame | evicted | **closed after 10 009 ms** |
| **Positive control** — same, but sends one valid sealed frame on open | kept | **survived past 25 s** (test ceiling) |

The constant holds to 9 ms, and the control is what makes it meaningful: the server is not closing sockets on age, it is closing the ones that spent a ticket and never authenticated under it. A thief who steals a ticket and cannot seal gets ten seconds and nothing else.

## 2. REST context lifetime — provisional versus promoted

Constants: `TICKET_TTL_MS = 30_000`, `REST_CONTEXT_TTL_MS = 24 h` (`src/e2ee/context.ts`). Every context starts **provisional** and is collected at the ticket TTL unless something authenticates under it; msg2 advertises that provisional deadline rather than the 24 h one, which is the point of §8/§12.

Two REST contexts opened seconds apart, one used immediately and one never used:

| t | Context used immediately | Context never used |
|---|---|---|
| t+4 ms | `200` sealed | — |
| t+20 s | `200` sealed | — |
| t+35 s | `200` sealed | **`409 E2EE_CTX_UNKNOWN`** |

Each is the other's control, and the pair is the whole rule in one run: the used context was promoted past the 30 s provisional deadline by its own first authenticated request and is still answering at 35 s; the untouched one was collected on schedule and answers the recoverable code — `E2EE_CTX_UNKNOWN`, not the hard `E2EE_DEVICE_REVOKED` — which is what tells a client to re-handshake rather than surface a failure.

## What these do NOT measure

The client's **10 s REST drain** (`REST_DRAIN_MS`, `services/e2ee/rest-session.ts`). That window is client-side state: on rollover the app keeps the retired context object alive for ten seconds so in-flight responses still decrypt, then destroys it. The server never sees a "draining" context — it holds both until their own TTLs — so no server-side probe can observe the boundary. Row 5's device run covers what matters operationally: across a real foreground rotation, **no request failed**.

Two bugs of mine on the way to these numbers, recorded because the first one looked like a finding for a minute:

- Sending the wall-clock wait as `X-TB-Seq` produced `E2EE_SEQUENCE_VIOLATION`, not a lifetime result. The header must equal the frame's own counter, read from the record header at byte 21.
- The first attempt reused one context for the whole run, so the promotion hid the provisional deadline entirely — the "never used" context had to be opened separately to see it.
