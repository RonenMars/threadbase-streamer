# D2 row 8 — a revoked device's socket closes (PASS), and the retry loop it exposes

Rig `:8790`, v1.73.0, e2ee on. Device `3b41386d…` (the live iPhone 13 Pro) revoked through `POST /api/devices/:id/revoke` at 12:28:42 UTC while its socket was open and the app was in the foreground.

## Row 8 — PASS

```
12:28:42  ws    e2ee.frame_refused   revoked
12:28:42  http  POST /api/devices/3b41386d…/revoke → 200   {"ok":true,"alreadyRevoked":false}
12:28:42  e2ee  open refused: no live device holds that static key
12:28:42  http  POST /api/e2ee/open → 403
```

Same second. The live socket's next frame is refused with `revoked`, and the re-handshake gets `403 E2EE_DEVICE_REVOKED` — the hard failure, not the recoverable `E2EE_CTX_UNKNOWN`, exactly as `NONCE-DESIGN.md` §9/§10 require. Revocation is immediate and needs no restart.

## The finding: a permanent refusal is laundered into a retryable one

After the refusal the client retried without stopping. Counted from the revocation:

| Status | Count (12:28:42 → 12:30:33) |
|---|---|
| 403 `E2EE_DEVICE_REVOKED` | 10 |
| 429 | 60 |

Still going when the count was taken, ~2 minutes in, at roughly one attempt every 1.5 s.

**The loop is self-sustaining, and the rate limiter is what sustains it:**

1. Revoked → `403 E2EE_DEVICE_REVOKED`. Correctly classified non-retryable (`services/e2ee/context.ts:80`: `retryable` is true only for `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT`), and correctly surfaced — the Servers Status modal reads **"This device is not paired for encryption"**.
2. Something above the transport retries anyway — 5 × 403 within seven seconds. Neither `ws-client.ts:231` nor `sealedFetch` can be the source; both honour `retryable`.
3. Each refusal charges the per-source failure budget, so the server switches to **429**.
4. `services/e2ee/context.ts:212-214` maps **`status === 429` → `E2EE_TRANSIENT`**, whose `retryable` is **true**. The client now believes a permanent condition is temporary and retries indefinitely.

The diagnosis on screen degrades as this proceeds. The accurate "This device is not paired for encryption" is replaced, in the server detail modal, by **"The server is busy; retrying shortly"** — which is false, and describes a state the user could wait out. They cannot; only re-pairing fixes it.

## Why this is the same defect the 17 Pro showed this morning

`tracks/D/evidence/d2-field-observation-open-failure-storm.md` recorded a second device holding the rig at its failure ceiling for six minutes (168 × 400, 43 × 429, pinned at 30/min) with the cause unknown and the retry layer a hypothesis. Row 8 reproduces the same shape deliberately, with a known trigger, and identifies the mechanism that keeps it running. The hypothesis in `tracks/X-client/PROMPT-stop-polling-hard-refusal.md` is now **confirmed**, except for one detail noted there and still open: which layer above the transport issues the retry.

## What the fix has to address, in order of importance

1. **A 429 answering a request that already failed permanently must not reset the verdict.** Once `E2EE_DEVICE_REVOKED` (or any non-retryable code) has been seen for a server, a later 429 is the rate limiter reacting to our own retries — not new information. The permanent verdict has to survive it.
2. **The retry above the transport must consult `retryable`.** Step 2 happens before any 429 exists, so fixing only the mapping would slow the loop, not stop it.
3. **The error text must not regress.** "This device is not paired for encryption" is the true statement and should not be overwritten by a busy message.

Client-side; nothing here asks the streamer to change. The server behaved exactly as designed at every step, and its failure budget is what kept one broken device from costing the whole fleet.

## Screens (owner's device, 15:29–15:31 IDT)

- Hub banner: "Ronens-MacBook-Pro.local is unreachable. Some sessions may…" with **Retry** — generic, gives no hint of revocation.
- Servers Status modal: `http://192.168.68.125:8790` — **Unreachable**, "This device is not paired for encryption" (accurate).
- Settings → server detail: "The server is busy; retrying shortly" (misleading, and the state the loop settles into).
- The legacy `:8791` server stayed **Connected** throughout, which is the control: only the revoked pairing broke.
