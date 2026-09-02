# D2 row 6 — reconnect fetches a fresh ticket (PASS), and the idle churn found underneath it

Rig `:8790`, v1.73.0, e2ee on. Phone connected, one idle session (`waiting_input`, no output).

## Row 6 — PASS

Owner toggled Wi-Fi off ~5 s and back on. Server-side sequence at 12:26:19–20 UTC:

```
12:26:19  CONTEXT_OPENED rest   POST /api/e2ee/open 200
12:26:20  CONTEXT_OPENED ws     POST /api/e2ee/open 200
12:26:20  GET /ws 200
```

A new handshake, a new ticket, a genuinely new WS context. No ticket reuse and no attempt to resume the dead context, which is what `NONCE-DESIGN.md` §6 requires — a key is never replaced inside a context, a new key is a new context.

## The finding: the socket redials every ~45 s with nobody touching the phone

`GET /ws` upgrades from 12:15 to 12:26, no user action for most of it:

```
12:15:15 12:16:11 12:17:25 12:18:11 12:18:56 12:19:42 12:20:09
12:22:24 12:23:10 12:23:55 12:24:41 12:26:20
gaps (s): 56, 74, 46, 45, 46, 27, 135, 46, 45, 46, 99
```

The 45–46 s cadence is not noise. `hooks/useTerminalStream.ts:25` defines `WS_SILENCE_TIMEOUT_MS = 45_000`, and `resetSilenceTimer()` (same file, ~line 186) calls `wsManager.forceReconnect(serverId)` when no WS traffic arrives inside that window, then re-arms itself. Its comment states the reason: iOS silently kills TCP without firing `onclose`.

The timer cannot distinguish **"no traffic because the socket is dead"** from **"no traffic because the session is idle"**. On an idle session it fires forever.

## Why this matters more now than it did before E2EE

Before E2EE a silent redial cost one socket dial. Now each one costs a full `POST /api/e2ee/open` — two Diffie-Hellmans server-side on a public, pre-authentication endpoint — plus a context and ticket allocation.

Measured over 688 s of this session:

> **35 context opens in 688 s = 3.1 per minute**, against `PAIR_EXCHANGE_LIMIT = 5` opens per device per minute (`src/api/rate-limit.ts`).

**62 % of a device's per-minute budget is consumed while the user does nothing.** The remaining headroom is under two opens per minute, and a foreground, a lazy REST open and a genuine reconnect can legitimately arrive as three in one burst — which the rate-limit comment itself names as the case the single-flight is meant to absorb.

This is the mechanism behind the 429 storm recorded this morning (`STATUS.md`, 07:35 IDT): the storm was not an anomaly on top of a quiet baseline, it was a busy baseline plus a little more.

## What the fix probably is (not implemented, not this track's call)

The timer should be reset by **any** inbound frame, not only session output — the server already sends `host_pressure` and `session_list` frames that prove the socket is alive — or the server should send a periodic ping and the client should treat that as liveness. Then silence would mean silence. Raising `OPEN_SOURCE_FAILURE_LIMIT` or the per-device limit would only mask it.

Worth its own mobile issue with this evidence attached. It is a client-side defect that E2EE made expensive, not an E2EE defect.

## Not verified here

Whether the old socket is genuinely dead at each redial, or whether the client is discarding a live one. Distinguishing those needs a client-side log alongside the server's, and the answer does not change the cost measured above.
