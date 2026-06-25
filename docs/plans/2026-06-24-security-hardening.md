# Security Hardening Plan — tb-streamer API

_Audited: 2026-06-24. Scope: tb-streamer server surface as exposed to tb-mobile._

## Threat Model

Single-user, self-hosted server. Primary threats:
- Local network MITM (shared LAN, coffee shop)
- Persistent credential leak (key captured from logs or WS URL)
- Lateral movement on the server host via `localNoAuth`
- Compromised client injecting arbitrary keystrokes via `answerKeys`

---

## HIGH

### H1 — `localNoAuth` is a full auth bypass
**Location:** `src/middleware/auth.middleware.ts:32-38`

When `localNoAuth=true`, any process on the same machine — including browser JavaScript hitting localhost — can call any API endpoint without credentials. `/api/sessions/:id/input` accepts arbitrary keystroke sequences, so this is a direct PTY takeover vector.

**Fix:** Remove the flag entirely, or restrict it to a single explicitly allowlisted token path. At minimum: gate behind explicit opt-in, log a prominent `[WARN] localNoAuth is enabled — all localhost requests are unauthenticated` on startup.

---

### H2 — No API key rotation or expiry
**Location:** `src/auth.ts`, `src/middleware/auth.middleware.ts`

A leaked key (from proxy logs, a captured WS URL, a compromised device) is valid permanently. One pair event = permanent credential.

**Fix:**
- Add `POST /api/auth/rotate` — generates a new key, persists it, returns it.
- On the mobile side, detect `401` mid-session and prompt re-pair (see mobile plan).
- Expose a "Revoke and re-pair" flow to close the leaked-key window without waiting for mobile to handle 401.

---

## MEDIUM

### M1 — API key in WebSocket query param
**Location:** `src/middleware/auth.middleware.ts:49-53`, `src/routes/ws.routes.ts`

`wss://host/ws?key=tb_abc...` is a durable log entry in any proxy, Cloudflare, or server access log. The mobile client already sends `{ type: 'auth', token }` as its first WS message (`services/ws-client.ts:69` in tb-mobile) — use that as the sole auth path.

**Fix:**
- On WS upgrade, accept the connection without validating `?key=` immediately.
- Require a `{ type: 'auth', token }` message within 5 seconds; disconnect if absent or invalid.
- Drop `?key=` as an accepted auth path for WebSocket connections (keep for SSE if needed).
- HTTP endpoints keep `Authorization: Bearer` (not logged by most proxies).

### M2 — CORS wildcard `*`
**Location:** `src/middleware/cors.middleware.ts:5`

Any origin can make cross-origin requests. Combined with `?key=` in URLs, a page that obtains the key can issue authenticated API calls from the browser.

**Fix:** Restrict to an explicit origin allowlist. For the local streamer, valid origins are the Expo dev server (`localhost:8081`, `localhost:19006`). For Fly.io deployment, no browser-originated requests are expected — safe default is to disallow all cross-origin requests (`null` origin or empty allowlist).

### M3 — No rate limiting on session start / input / resume
**Location:** `src/routes/sessions.routes.ts`

An authenticated client or a buggy mobile reconnect loop can spawn unlimited PTY sessions or flood `/api/sessions/:id/input`, exhausting host resources.

**Fix:** Rate-limit using the same `Map`-based counter already in `server.ts:1007-1018`:
- `POST /api/sessions/start`: 10/min per client
- `POST /api/sessions/:id/input`: 500/min per sessionId

### M4 — `isWithinSkew` with missing timestamp header returns `true`
**Location:** `src/routes/progress.routes.ts:64-68`

The HMAC timestamp check is optional — if `X-Timestamp` is absent, the skew check passes. This allows replay attacks on the progress webhook.

**Fix:** Make `X-Timestamp` required. Return `401` if absent or unparseable.

### M5 — `answerKeys` keystroke injection
**Location:** `src/services/questions/detectPermissionGate.ts`, broadcast in `server.ts`

The streamer tells mobile what keystroke bytes to forward to the PTY as a permission answer. A misbehaving or compromised server path could set `answerKeys` to arbitrary bytes; the client forwards them verbatim.

**Fix (server-side):** Constrain `answerKeys` to an explicit allowlist when constructing permission messages: `y\r`, `n\r`, `\x03`, digit + `\r`. Reject or sanitize anything outside that set before broadcasting.

---

## LOW

### L1 — `hold_session` / `subscribe_session` accept any sessionId
**Location:** `server.ts:476-485`

Any authenticated WS client can call `hold_session` on a sessionId they don't own, immediately killing its PTY grace timer.

**Fix:** Track which `clientId` subscribed to which `sessionId` in `WSHub`. Only allow `hold_session` from the registered subscriber of that session.

### L2 — `exchangeAttempts` map never pruned
**Location:** `server.ts:1007-1018`

Sustained scanning from many IPs accumulates map entries indefinitely.

**Fix:** On insertion, `setTimeout(() => map.delete(ip), 5 * 60 * 1000)` to TTL-evict after 5 minutes.

### L3 — `/healthz` leaks version string
**Location:** `src/routes/health.routes.ts:8`

Version disclosure aids fingerprinting.

**Fix:** Return only `{ ok: true }`. Version is already available on the authenticated `GET /api/info`.

### L4 — WS broadcast has no client isolation
**Location:** `src/ws-hub.ts:49-67`

All authenticated WS clients receive all events for all sessions. This is acceptable for a single-user local server but becomes a risk if multiple devices pair to the same server.

**Note:** Not a fix item unless multi-user support is planned. Document as a known design constraint.

---

## Implementation Order

| # | Change | Effort |
|---|--------|--------|
| 1 | Gate / remove `localNoAuth` (H1) | Small |
| 2 | `POST /api/auth/rotate` endpoint (H2) | Medium |
| 3 | WS auth via first-message only, drop `?key=` (M1) | Medium |
| 4 | Restrict CORS to explicit origins (M2) | Tiny |
| 5 | Rate-limit session start / input (M3) | Small |
| 6 | Require `X-Timestamp` on progress webhook (M4) | Tiny |
| 7 | Constrain `answerKeys` to allowlist (M5) | Small |
| 8 | TTL-evict `exchangeAttempts` entries (L2) | Tiny |
| 9 | Remove version from `/healthz` (L3) | Tiny |
| 10 | `hold_session` ownership check (L1) | Small |
