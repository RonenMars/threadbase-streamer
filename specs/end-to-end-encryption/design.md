# End-to-end encryption — Streamer design

**Date:** 2026-08-14
**Status:** Approved for implementation 2026-08-14 — see [plan.md](./plan.md), tracked in [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) and [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698).
**Scope:** tb-streamer. The client half is [mobile-design.md](./mobile-design.md).
**Seed:** [understanding.md](./understanding.md) (authoritative) · **Current state:** [context.md](./context.md)

Every section that changes existing behaviour states what the behaviour is **today**, with a `file.ts:line` citation, before saying what it becomes.
Decisions `understanding.md` left open are marked **[Assumption]** and carried into [dilemmas.md](./dilemmas.md) with their alternatives.

---

## 1. Trust model

### 1.1 Who holds plaintext

| Party | Plaintext? | Why |
|---|---|---|
| Mobile app process | **Yes** | It renders the terminal. It is one of the two ends. |
| Streamer process | **Yes** | It spawns the PTY, scrapes the rendered screen for gate detection (`src/pty-manager.ts` `detectGateScreen`), and writes a searchable index. It is the other end. |
| Claude / Codex processes | **Yes** | They *are* the workload. |
| Model provider | **Yes** | Per `understanding.md`; unchanged by this feature. |
| Streamer host OS / anyone running as that user | **Yes** | Holds the keys and the process memory. Stated as a limit, not a gap. |
| Cloudflare edge + `cloudflared` connector | **No** | The point of the feature. Today it holds all of it (`docs/guides/remote-access/cloudflare.md:109-113`). |
| Any TLS-terminating proxy, corporate middlebox, or reverse proxy | **No** | Same mechanism. |
| LAN observer on the `http://`/`ws://` path | **No** | Today this is fully cleartext (`tb-mobile/services/ws-client.ts:122`). |
| Anything reading the streamer's request log | **No** | Bodies are never logged today and must stay that way (`src/api/app.ts:109-118`). |
| A stolen or backed-up copy of `cache.db` / `runtime.db` | **No** (new) | Today: fully readable (`src/conversation-cache.ts:178-203`). |

### 1.2 What "end-to-end" means here, precisely

The ends are **the mobile app process** and **the streamer process**.
Encryption is application-layer and independent of TLS, so it holds identically over an `https://` Cloudflare tunnel, a plain `http://` LAN address, and any future ingress.

It is **not** the property where the server is a relay that never sees content.
The streamer must decrypt or it cannot do its job.
Every user-facing string, settings label, and privacy-policy line must therefore say *which* ends — "encrypted from your phone to your computer", never "we can't read your conversations", which would be false.

### 1.3 What survives each compromise

| Compromise | Outcome |
|---|---|
| Cloudflare edge, or a proxy on the path | Sees request paths, sizes, timing, and connection metadata. No content, no credential. |
| Passive LAN capture | Same. |
| Active MITM on an established connection | Every frame fails authentication; the connection closes. Cannot inject input into a session. |
| Active MITM during pairing, without the QR | Cannot complete the handshake — the server's static key is in the QR (§2.2). |
| Attacker who photographs the QR | Can pair *as a device* until the token is consumed or expires. Cannot impersonate the server to the real phone. See §2.5. |
| Stolen `cache.db` / `runtime.db` / a backup | Encrypted at rest (§5); useless without the key file. |
| Stolen laptop, streamer user's home dir readable | Key file is in that home dir. At-rest encryption does **not** help. Full-disk encryption does. Stated plainly. |
| Code execution as the streamer user | Total. E2EE raises the cost of a compromised *path* and a stolen *disk*, never of a compromised host. |
| Lost/stolen phone | Revoke that device (§4.4). Other devices unaffected. |

---

## 2. Pairing and key agreement

### 2.1 Today

`POST /api/pair/start` mints a single-use 180-second token (`src/pair-store.ts:26`, `:42-51`) and the CLI prints a QR encoding `threadbase://pair?url=<url>&token=<pt_...>&exp=<unix-seconds>` (`cli/index.ts:709`).
`POST /api/pair/exchange` is public (`src/api/middleware/auth.middleware.ts:23`), rate-limited per IP (`src/server.ts:1762-1766`), consumes the token (`src/server.ts:1783`), and returns the shared API key sealed to the client's X25519 public key using a **server-side ephemeral** sender keypair (`src/seal.ts:24-32`, called at `src/server.ts:1791`).
It also registers a device row and returns a per-device token (`src/server.ts:1813-1836`).

**The gap:** the QR carries no server key material, so the client opens the box with whatever `ephemeralPublicKey` the response happened to contain (`tb-mobile/services/pair-exchange.ts:175-183`).
The exchange authenticates the *client* (it must hold the pair token) but never the *server*.

### 2.2 The server identity key

The streamer gains one long-term X25519 keypair, its **server identity key** `(S_pub, S_priv)`.

- Generated on first boot, stored in `~/.threadbase/keys/server-identity.key`, mode `0600`, written tmp-then-rename — the same discipline `setConfigValue` already uses for `server.yaml` (`src/auth.ts:169-173`).
  Not in `server.yaml`: that file is a regex-parsed, hand-editable config (`src/auth.ts:142-173`) and a private key does not belong in something a user is invited to edit.
- Stable across restarts and across API-key rotation (`src/server.ts:1839-1856`). Rotating the bearer credential must not re-pair every device.
- `S_pub` is public and printable. `tb-streamer prod doctor` and a new `tb-streamer identity` command show its fingerprint so a user can compare it out of band.

### 2.3 The QR payload

**Today:** `threadbase://pair?url=<url>&token=<pt_...>&exp=<unix-seconds>` (`cli/index.ts:709`).

**Becomes:** the same, plus two additive parameters.

```
threadbase://pair?url=<url>&token=pt_<hex>&exp=<unix>&spk=<base64url(S_pub)>&v=1
```

- `spk` — the server identity public key, 32 bytes, 43 base64url characters. This is the whole fix: it makes the QR an authenticated out-of-band channel for the server's identity.
- `v` — envelope version. `v=1` means "this server speaks E2EE v1". Absent means a pre-E2EE server.
- Additive by construction: `parsePairUri` reads named parameters and ignores unknown ones (`tb-mobile/services/pair-exchange.ts:70-80`), so an old app scanning a new QR behaves exactly as it does today.

QR density: the payload grows by ~50 characters. `qrcode-terminal` at `{ small: true }` (`cli/index.ts:642`) must still render legibly in an 80-column terminal — this is a **verification item**, not an assumption, and it is the one thing that could force `spk` to become a truncated fingerprint instead of a full key.

### 2.4 Handshake: Noise `IK` over the pair token **[Assumption]**

**Pattern:** `Noise_IKpsk1_25519_ChaChaPoly_SHA256`.

- **`IK`** — the initiator (phone) already knows the responder's static key, from the QR. That is precisely the situation, and `IK` is the pattern designed for it: the responder is authenticated in the first message, and the initiator's static key is transmitted encrypted.
- **`psk1`** — the pair token is mixed in as a pre-shared key on the first message. It binds the handshake to *this* QR, so a valid handshake proves the initiator scanned *this* code, not merely that it reached the server.
- Adopting a specified pattern rather than hand-rolling `X25519 → HKDF` is the point. The transcript hash, the key-mixing order, and the identity-hiding properties are all decided by the pattern rather than by us.

**Message flow, replacing nothing:**

```
POST /api/pair/exchange          (existing endpoint, existing token consumption)
  body: { token, clientPublicKey, deviceName?, readOnly?,     ← unchanged fields
          e2ee: { v: 1, noise: base64(msg1) } }               ← additive

  msg1 = Noise IK message 1: e, es, s, ss  + psk(pair token)
         payload: { deviceName, capabilitiesRequested, clientIdentityPub }

  response: { ciphertext, nonce, ephemeralPublicKey,          ← unchanged, still sent
              publicUrl, machineName,                          ← unchanged
              deviceId, deviceToken, capabilities,             ← unchanged
              e2ee: { v: 1, noise: base64(msg2) } }            ← additive

  msg2 = Noise IK message 2: e, ee, se
         payload: { deviceId, rootKeyConfirm, serverVersion, e2eeRequired: true }
```

The existing sealed-API-key fields are **still returned**, unchanged, because `docs/compatibility/tb-mobile.md:115` flags changing that format as risky and because an old app must still pair.
A new app ignores them and uses the Noise result.

**Why reuse `/api/pair/exchange` rather than add `/api/e2ee/pair`:** the endpoint is already public, already rate-limited, already consumes the token exactly once, and already registers the device. A second endpoint would duplicate all four and create a second place for the token to be consumed.

### 2.5 Binding the device identity to the key

**Today:** the `devices` row stores `public_key` — the `clientPublicKey` from the exchange — plus `token_hash`, `capabilities`, and `revoked_at` (`src/db/runtime-migrations/003_create_devices.sql`).
The public key is recorded but nothing ever checks a signature against it; it was a sealing target (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:15`).

**Which database, because this section originally named the wrong one.** `devices` lived in `cache.db` as `src/db/migrations/011_create_devices.sql` when this design was written, and moved to `~/.threadbase/runtime.db` in the split; the cache-side table is still created for rollback and as the one-time copy source, but is never read or written after boot.
The distinction is load-bearing rather than cosmetic: `cache.db` is the file `tb-streamer cache clear` deletes and the integrity monitor rebuilds, because everything in it is regenerable from `~/.claude`/`~/.codex`.
A pinned static key is not.
Adding `e2ee_static_pub` to the cache side would mean a routine cache clear silently dropped every device's pinned key while leaving that device's *authentication* intact in `runtime.db` — so the devices keep working, unencrypted, with nothing anywhere reporting an error.
That is the worst available failure shape for this feature: it degrades security silently and looks healthy.
Add device columns to a **runtime** migration, never to `011`.

```sql
-- src/db/runtime-migrations/004_add_device_e2ee.sql
-- (additive; nothing altered, nothing backfilled)
ALTER TABLE devices ADD COLUMN e2ee_static_pub  TEXT;    -- base64, the Noise static key
ALTER TABLE devices ADD COLUMN e2ee_required    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN e2ee_version     INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_e2ee_static_pub
  ON devices (e2ee_static_pub) WHERE e2ee_static_pub IS NOT NULL;
```

Three consequences that matter:

1. **Authentication becomes possession of a key, not of a string.** A device is now identified by completing a handshake against `e2ee_static_pub`. The device token remains, as the credential an old client presents and as the fallback path.
2. **The unique index means one static key equals one device.** A re-pair from the same phone with the same static key updates the row rather than creating a second one, which is what keeps `GET /api/devices` from filling with ghosts.
3. **`e2ee_required` is the downgrade lock** (§6.3). It is set at pairing when both sides completed a Noise handshake, and once set it is never cleared by anything a client can send.

Rows that predate the migration have `e2ee_static_pub IS NULL` and `e2ee_required = 0` — they authenticate exactly as they do today. This is the same shape as the C5 migration's own compatibility story (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:136-138`).

### 2.6 What an attacker who photographs the QR can and cannot do

This is the question `understanding.md` asks by name, so it is answered as a table.

| Capability | Before this design | After | Why |
|---|---|---|---|
| Pair as a rogue device, if they reach the URL before the real phone and within 180 s | **Yes** | **Yes** | The token is the client's only proof, and a photo copies it. Unchanged, and unfixable with a QR alone. |
| ...and the legitimate phone then fails to pair | Yes | Yes | `consume()` is single-use (`src/pair-store.ts:60-62`), so the second attempt gets `401 Pair token used`. This is the **detection signal**, and today it is a bare 401 string. |
| Obtain the shared API key, i.e. full authority over every session and every device | **Yes** — `seal(this.apiKey, ...)` (`src/server.ts:1791`) with `legacyPrincipal()` carrying `admin` (`src/services/security/capabilities.ts:63-69`) | **No** (stage 2+) | The E2EE path returns only a device-scoped credential. §6.4. |
| Impersonate the streamer to the legitimate phone (MITM the exchange) | **Yes** — nothing authenticates the server | **No** | The phone requires the responder to prove possession of `S_priv` for the `spk` in *its own* QR. |
| Read traffic on an already-established pairing | No | No | Unchanged. |
| Use the photo after 180 s | No | No | TTL (`src/pair-store.ts:26`), and the mobile side rejects a stale `exp` before it even sends (`tb-mobile/services/pair-exchange.ts:95-99`). |
| Use a photo of an *old* QR after a new one was minted | No | No | `mint()` overwrites `this.current` (`src/pair-store.ts:45`), so at most one token is ever live. |

**Residual, stated rather than solved:** a photographed QR within the window still yields a paired device.
Three mitigations that do not require changing that fact:

- Every successful pairing writes a `pair.device_paired` log line carrying `deviceId`, `ip`, and the static-key fingerprint. Today the pairing log records `ip` and `ts` only (`src/server.ts:1799-1803`).
- A *failed* consume with reason `used` is logged at **warn** with an explicit "a pair token was replayed — if you did not just pair a device, revoke it" message. Today `consume()` failures produce a 401 with the reason in the body (`src/server.ts:1784-1787`) and no log at all.
- `GET /api/devices` already lists every device with `createdAt` (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:124`), so the recovery path — see the extra device, revoke it — exists and needs only to be surfaced.

---

## 3. Transport envelope

### 3.1 Today

WebSocket frames are `JSON.stringify(message)` on the raw socket (`src/ws-hub.ts:50`, `:76`, `:92`), carrying `terminal_output.data`, `terminal_replay.lines`, `user_message.text`, `permission.prompt` and the rest of the union in the clear (`src/types.ts:218-315`).
REST handlers write plain JSON directly to `c.env.outgoing` and return the `ALREADY_HANDLED` sentinel (`src/api/app.ts:41-42`).
Credentials travel as `Authorization: Bearer` or `?key=` (`src/api/middleware/auth.middleware.ts:54-57`).

### 3.2 What is encrypted and what is not

| Element | State | Why |
|---|---|---|
| WebSocket payload (the whole JSON message) | **Encrypted** | It is the highest-value stream and it is a single multiplexed connection to one authenticated device — nothing on the path needs to read it. |
| REST request body | **Encrypted** | |
| REST response body | **Encrypted** | |
| REST method and path | **Plaintext** | Mobile hard-codes every path (`docs/compatibility/tb-mobile.md:9-18`) and Hono routes on them (`src/api/app.ts:124-143`). Opaquing them means a parallel router and breaks every log, trace and proxy rule. Accepted residual. |
| Query parameters | **Plaintext** | `limit`, `offset`, `before_index` etc. are pagination (`docs/compatibility/tb-mobile.md:29-34`). They leak position, not content. |
| `?key=` on the WS upgrade | **Removed from the long-term credential** | Replaced by a single-use ticket, §3.5. |
| WS frame headers, TCP/TLS metadata, sizes, timing | **Plaintext** | Out of scope (context.md §5). |
| `/healthz` | **Plaintext** | Already public (`src/api/middleware/auth.middleware.ts:18`) and the menubar polls it every 5 s. |

**The metadata leak is real and is named:** an observer at the edge learns which endpoints a device calls, how often, with what pagination, and how large each response is — enough to infer session activity and rough conversation size. That is the price of keeping the path contract, and it is a deliberate trade, not an oversight.

### 3.3 AEAD, nonces, and the record layer **[Assumption]**

**AEAD: ChaCha20-Poly1305 (RFC 8439), 256-bit key, 96-bit nonce, 128-bit tag.**

- Node has it natively via `crypto.createCipheriv("chacha20-poly1305", ...)`. No new native dependency on the server.
- It is the cipher in the chosen Noise suite, so handshake and record layer use one primitive.
- Chosen over AES-256-GCM because the mobile side has no reliable hardware AES path in JS and a software AES-GCM is both slower and more prone to timing problems than ChaCha20.
- Chosen over XChaCha20-Poly1305 (24-byte random nonce) because a **counter** nonce turns nonce reuse into an assertable invariant rather than a birthday-bound argument. See dilemmas.md D-2 for the alternative.

**Nonce construction — never random:**

```
nonce[12] = direction[4] || counter[8]      (big-endian)

direction: 0x00000001  client → server
           0x00000002  server → client
counter:   starts at 0, increments by exactly 1 per sealed record, never reset
```

Separate keys *and* separate direction labels per direction, so a record can never be reflected back at its sender.
A sender that would exceed `2^64 - 1` refuses to send and forces a rekey. This is unreachable in practice; it is asserted so it cannot become a silent wrap.

**AAD binds the plaintext framing to the ciphertext.** The header travels in the clear and is authenticated, so an intermediary can neither rewrite a sequence number nor re-point a record at a different context:

```
AAD = version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)
channel: 0x01 websocket, 0x02 rest-request, 0x03 rest-response
```

### 3.4 Replay and reordering

The two channels have genuinely different properties and get different rules. Applying one rule to both is the mistake this section exists to prevent.

**WebSocket — strict monotonic, no window.**
A WebSocket runs over one TCP connection, so it is ordered and gap-free by construction.
The receiver requires `counter == expected` exactly. Anything else — a repeat, a gap, a reorder — is a protocol violation, not a network event: log `e2ee.sequence_violation` and close the socket with a policy code.
This makes replay structurally impossible on the highest-volume channel without any bookkeeping.

**REST — sliding window.**
HTTP requests can be concurrent, and mobile issues them concurrently (React Query). A strict counter would reject a perfectly legitimate out-of-order arrival.
The receiver keeps an RFC-6479-style 1024-bit sliding bitmap per context: accept a counter above the window (advance), accept one inside the window whose bit is clear (set it), reject one below the window or already set.
Responses do not need a window — each is bound to its request's counter in the AAD, and a response with the wrong counter is discarded by the client.

**Across contexts.** A record from an expired or unknown `ctxId` is rejected before decryption is attempted. Contexts do not survive a streamer restart (§4.2), so an old capture can never be replayed into a new run.

### 3.5 Establishing a transport context

**Today:** the WS upgrade authenticates by `?key=<apiKey>` because a browser/RN WebSocket cannot set headers (`src/api/middleware/auth.middleware.ts:56-57`, `tb-mobile/services/ws-client.ts:122`), and `/ws` requires `history:read` (`src/services/security/capabilities.ts:120`).

**Becomes:** a two-step that keeps the long-term credential out of every URL.

1. `POST /api/e2ee/open` — public (added to `PUBLIC_POST_PATHS`, `src/api/middleware/auth.middleware.ts:23`), carries Noise `IK` messages 1 and 2 using the *stored* static keys from pairing. Returns `{ ctxId, expiresAt }`. The device is authenticated by the handshake itself: the server looks the initiator's static key up in `devices.e2ee_static_pub` and refuses if the row is missing or `revoked_at` is set.
2. `GET /ws?ticket=<t>` — `t` is a single-use, 30-second ticket issued **inside** the encrypted `/api/e2ee/open` response and bound to `ctxId`. It authorizes exactly one upgrade and is consumed on use.

Consequences:

- `?key=` never carries the long-term credential again. The old form keeps working for pre-E2EE clients (`docs/compatibility/tb-mobile.md:88` requires it), but an E2EE-pinned device is refused if it presents one (§6.3).
- The existing `summarizeQuery` protection (`src/api/app.ts:53-57`) already reduces `?ticket=` to `ticket=_` in the request log, so a ticket cannot leak through the streamer's own logs. That behaviour is now load-bearing and needs a test that says so.
- Mobile's `{ type: 'auth', token }` first frame (`tb-mobile/services/ws-client.ts:179`) — which no server handler reads (`src/server-wiring.ts:607-671`) — is deleted rather than implemented.

### 3.6 Where the code changes

Two seams, chosen because they are the only two places every message already funnels through.

**WebSocket — `WSHub`.** `broadcast`, `broadcastToClients`, and `unicast` each do one `JSON.stringify` (`src/ws-hub.ts:50`, `:76`, `:91`) and every send in the codebase goes through them. Sealing happens there, per-socket, because each socket has its own context and counter.
The one wrinkle: `broadcast` currently serializes **once** and sends the same buffer to every client (`src/ws-hub.ts:50-63`) — an optimisation that was the point of `broadcastToClients` in the first place. Per-socket sealing means N seals for N sockets. At ChaCha20 speeds on a terminal-output chunk this is microseconds, but it is a real change to a hot path and must be measured, not assumed.
Sends that bypass the hub — `ws.send(JSON.stringify(...))` inline in `handleWsOpen` (`src/server-wiring.ts:598`, `:600`) and in the `subscribe_session` replay (`:621`, `:642`, `:659`) — must be routed through the hub first. That refactor is a prerequisite, not part of the encryption.

**REST — one middleware pair.** An unseal middleware ahead of `authMiddleware` in the `app.use("*")` chain (`src/api/app.ts:120-121`) that: reads `X-TB-Ctx` and `X-TB-Seq`, unseals the body, replaces it, and sets the resolved principal on the context. A seal middleware on the way out.
Handlers stay untouched — they keep writing plain JSON to `c.env.outgoing`. The seal wrapper intercepts the same `write`/`end` pair that `countResponseBytes` already patches (`src/api/app.ts:66-83`), so there is prior art for that interception in this codebase.

---

## 4. Key schedule

### 4.1 Today

There is no key schedule. One long-lived string (`src/auth.ts:25-27`) is presented on every request, rotated only by an explicit `POST /api/auth/rotate` (`src/server.ts:1839-1856`), which invalidates every device at once because they all hold the same value.

### 4.2 The hierarchy

```
S_priv / S_pub          server identity key      long-lived, on disk 0600, survives API-key rotation
D_priv / D_pub          device static key        long-lived, in the phone's Keychain/Keystore
        │
        └── Noise IK handshake (+ pair-token PSK at pairing)
                │
                ▼
            h_ss                                 handshake hash — the transcript, binds everything above
                │
                ├── k_c2s   client → server traffic key      per context
                └── k_s2c   server → client traffic key      per context
                │
                └── ctxId (16 B)                             opaque public context handle
```

Derivation is the Noise spec's own `Split()` — no bespoke HKDF ladder, because the transcript hash `h` already commits to both static keys, both ephemerals, the PSK, and the protocol name.
`ctxId` is `HKDF(h_ss, "tb-e2ee-ctx-id", 16)`, so it is derivable by both sides without an extra round trip and reveals nothing about the keys.

### 4.3 Lifetimes

| Key | Lifetime | Rotation trigger |
|---|---|---|
| `S_priv` | Machine lifetime | Manual only (`tb-streamer identity --rotate`), which **unpairs every device** and must say so before doing it. |
| `D_priv` | App-install lifetime | Reinstall, or explicit re-pair. |
| `k_c2s` / `k_s2c` | One transport context | 24 h wall clock, 1 GiB sealed, or an explicit rekey — whichever first. |
| Transport context | ≤ 24 h; destroyed on streamer restart, on socket close after a grace window, and on device revocation. | |
| WS ticket | 30 s, single use | — |
| Pair token | 180 s, single use (`src/pair-store.ts:26`, `:60-62`) | Unchanged. |
| Device token (legacy credential) | No expiry, revocation only (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:147`) | Unchanged. |

**Forward secrecy** comes from the ephemeral half of each `IK` handshake: recovering `S_priv` later does not decrypt a captured session, because `ee` contributed entropy that was never written down.
It does **not** protect against an attacker who holds `S_priv` *and* is active at handshake time — `IK` gives the responder no forward secrecy against a compromise-then-impersonate attacker. That is the standard `IK` caveat and is accepted, because the alternative (`XX`) costs the QR-based server authentication that §2.6 depends on.

**Rekey** is `Noise Rekey()` on both cipher states, triggered by whichever bound is hit first, plus one on every app foreground. Counters reset to 0 only as part of a rekey, never independently.

Grace/hold interacts here: a `hold_session` is an explicit message (`src/server-wiring.ts:669-671`) and a socket close deliberately arms nothing (`src/server-wiring.ts:684-689`). The transport context follows the socket, not the session — a phone that backgrounds and returns opens a **new** context and the session it was watching is untouched. Nothing about session lifetime changes.

### 4.4 Revocation

**Today:** `revoked_at` is checked per request, uncached, and takes effect on the device's next request (`src/db/runtime-migrations/003_create_devices.sql`, `docs/architecture/2026-07-24-device-identity-and-capabilities.md:112`). But a *live WebSocket* is authenticated once at upgrade (`src/api/app.ts:121` → `src/services/security/capabilities.ts:120`) and never re-checked, so revoking a device does not close its open socket.

**Becomes:** revocation is enforced at three points, because a long-lived encrypted socket makes the current single check insufficient.

1. **Handshake** — `/api/e2ee/open` refuses a static key whose row is missing or revoked. No new context.
2. **Per REST request** — unchanged in shape; the unseal middleware resolves the principal from `ctxId` and re-checks `revoked_at` on the same per-request basis the middleware uses today.
3. **Live sockets, new** — `POST /api/devices/:id/revoke` destroys every transport context for that device and terminates its sockets. `WSHub.dispose()` already has the `terminate()`-not-`close()` reasoning worked out for exactly this "do not wait for the peer" case (`src/ws-hub.ts:114-120`); revocation reuses it for one device's sockets.

Point 3 is a **behaviour change to revocation**, not merely to E2EE: it fixes a live socket outliving its revocation today. It is called out here because it is the kind of improvement that gets attributed to the wrong PR later.

---

## 5. At-rest encryption

### 5.1 Today

Everything the streamer writes is plaintext. Section 2.5 of context.md enumerates it; the load-bearing entries are `conversation_meta.first_message` / `last_message` / `preview` and `conversation_tail.messages_json` (`src/conversation-cache.ts:178-203`), `managed_sessions.session_name` and `.cmdline` (`src/db/runtime-migrations/001_create_managed_sessions.sql`), uploads under `<projectPath>/.threadbase-uploads/` (`src/uploads.ts:6`, `:60`), and pino logs under `~/.threadbase/logs/` (`src/logger.ts:39-41`).

### 5.2 Whole-database encryption, not field encryption **[Assumption]**

**Decision: SQLCipher-compatible page-level encryption via `better-sqlite3-multiple-ciphers`**, a drop-in replacement for `better-sqlite3` with the same API.

Field-level encryption was rejected for a specific reason, not a general one: `conversation_meta` is queried by `last_activity`, `project_path` and `file_path` with indexes on all three (`src/conversation-cache.ts:194-196`), and search runs `LIKE` over message text. Encrypting fields destroys both. Page-level encryption covers the tables, the indexes, the WAL, the SHM, the journal, and freed pages that still hold deleted rows — with zero query changes.

Scope: **`cache.db` and `runtime.db` both.** They are deliberately separate files with separate opens (`CLAUDE.md`, "db/runtime-store.ts"), and both hold content. Postgres is out of scope (dormant).

**Cost must be measured, not assumed.** The query-timing instrumentation is already on every statement at both `new Database()` sites (`src/db/query-timing.ts`), and the baseline is documented: p50 0.03 ms, p99 0.87 ms, max 1.83 ms over 3 600 read samples against a 22 MB cache. Page encryption adds per-page AES work on cold reads and is largely free on the page cache. The acceptance bar is the existing `THREADBASE_DB_SLOW_QUERY_MS` default of 35 ms staying a tripwire rather than becoming routine — if it starts firing, the design is wrong, not the threshold.

### 5.3 Where the database key lives

```
~/.threadbase/keys/db.key          32 bytes, 0600, tmp-then-rename
~/.threadbase/keys/server-identity.key   (§2.2, same directory, same mode)
```

An OS-keystore backend (macOS Keychain, Windows DPAPI, libsecret) is a **later** option behind a config key, not the first implementation. The honest reason: a keystore protects against another *user* on the box, and the streamer's own process must be able to read the key unattended at launchd/Task-Scheduler boot with no prompt — which on macOS means an ACL-granted keychain item that any code running as that user can also read. The security delta over a 0600 file, for the unattended-service case, is small enough that shipping the file first and the keystore later is the right order.

**What this defends and what it does not, stated without hedging:**

- **Defends:** a `cache.db` copied to a backup, a synced folder, a cloud drive, a support bundle, or off a stolen disk that was not full-disk encrypted. This is the realistic loss path and it is the one this closes.
- **Does not defend:** anything running as the streamer user, which can read the key file. Full-disk encryption is the control for a stolen machine; this is the control for a stolen *file*.

Never claim more than that in any user-facing string.

### 5.4 The rest of the at-rest surface

| Surface | Treatment |
|---|---|
| WAL / SHM sidecars | Covered by page-level encryption. No separate handling. Confirms `clear-cache`'s existing three-file deletion (`cli/index.ts:437`) stays correct. |
| Cache backups (`src/services/backup/backup.ts`) | A backup of an encrypted DB is encrypted. But a backup taken with the key alongside it is not a backup, it is a copy — the backup path must never write the key file into the backup directory. Explicit test. |
| Uploads | Encrypted at rest with a per-file key wrapped by the DB key, stored beside the file. **Except** that uploads live inside the user's own project tree (`src/uploads.ts:60`) so the agent can read them — encrypting them there would break the feature. Resolution: leave file contents as-is (they are the user's own files, in the user's own repo, which the agent must read) and encrypt only the streamer's *record* of them. See dilemmas.md D-4. |
| Logs | Not encrypted. Instead: keep content out of them. Redaction covers three headers today (`src/logger.ts:10-13`); the new envelope must not add a fourth leak. Terminal output is never logged today and must not start. |
| `server.yaml` | Still holds the API key in plaintext (`src/auth.ts:47`). Not moved — it is the credential a user is expected to read and paste. But see context.md Open question 4: its first creation lacks a `0600` mode. |
| Provider JSONLs (`~/.claude`, `~/.codex`) | Out of scope. Not ours. The cache is encrypted; its source is not, and saying otherwise would be false. |

---

## 6. Capability negotiation and `--no-e2ee`

### 6.1 Today

`GET /api/info` is the capability-discovery endpoint and already carries three boolean flags plus a `push` object (`src/api/routes/misc.routes.ts:141-166`). The pattern is established: absent means "older server, unknown", never "unsupported" (`docs/compatibility/tb-mobile.md:96`).
`GET /api/config/feature-flags` returns `{ registry, values }` and is read-only, admin-scoped (`src/server.ts:1865-1870`, `src/services/security/capabilities.ts:96`).
Feature flags resolve at boot only; precedence is `ServerConfig` → env → `--feature` → `server.yaml` → registry default (`src/feature-flags.ts`).

### 6.2 Discovery

Three surfaces, each for a different moment:

1. **The QR** — `v=1` and `spk=` (§2.3). This is discovery *before any connection exists*, and it is the only one an attacker cannot strip without also breaking the pairing, because the phone reads it off a photon path rather than a network.
2. **`GET /api/info`** — additive `e2ee` object, same contract as `push`:
   ```jsonc
   "e2ee": {
     "supported": true,        // this build speaks the envelope
     "enabled": true,          // and it is switched on right now
     "version": 1,
     "required": false,        // refuses plaintext from *any* client (stage 3)
     "reason": "disabled by --no-e2ee"   // present only when supported && !enabled
   }
   ```
   Absent ⇒ pre-E2EE server. A client must read that as "unknown", exactly as it does for `push`.
3. **`GET /api/config/feature-flags`** — the `e2ee` flag appears in the registry with its description, for the settings screen. Read-only, admin-scoped, unchanged in shape.

### 6.3 Downgrade prevention

`/api/info` is attacker-modifiable in the pre-E2EE world (it is plaintext JSON over a path an intermediary controls), so **discovery alone can never be the anti-downgrade mechanism**. Pinning is.

**The rule: once a pairing has completed a Noise handshake, both sides record it, and neither will ever speak plaintext on that pairing again.**

- Server side: `devices.e2ee_required = 1`, set inside the pairing transaction, never cleared by any client-reachable path. Clearing it requires re-pairing (which creates a new row) or an explicit admin action.
- Client side: the same bit stored beside the server record, in the Keychain-backed store (`tb-mobile/stores/servers.ts:109`), not in AsyncStorage.
- Enforcement, server: a request presenting a device token or API key whose `devices` row has `e2ee_required = 1`, without a valid `X-TB-Ctx`, is **`426 Upgrade Required`** with `{ code: "E2EE_REQUIRED" }`. Not 401 — 401 triggers mobile's re-auth UI (`docs/compatibility/tb-mobile.md:84`) and would send the user around a pairing loop that cannot fix the problem.
- Enforcement, client: a pinned server that answers `/api/info` with `e2ee.supported: false`, or that fails the handshake, is a **hard failure with a specific message**, never a silent fallback. This is the half that actually stops the attack, because a MITM's easiest move is to answer as an old server.

**The `--no-e2ee` interaction that must not be gotten wrong:** an operator who starts the server with `--no-e2ee` after devices have pinned it does **not** get a working plaintext connection for those devices. They get `426` on every request from them, and a boot-time warning that says exactly that, naming the count of pinned devices. Silently un-pinning would make the opt-out a downgrade oracle, which is precisely the property `understanding.md` asks to prevent.

### 6.4 `--no-e2ee`

**Startup-only, per `understanding.md`.** It is a `serve` flag, not a runtime toggle and not a `PUT` — matching how feature flags already work (boot-time resolution, `src/feature-flags.ts`) and how `ptyGracePeriodMs` already works.

- Registered on `serve` (`cli/index.ts:90` is where sibling flags live).
- Prints a **prominent, unmissable boot warning** through the console dest — the same `log.info(..., "console")` path the QR banner and `prod doctor` use (`src/logger.ts:37`) — naming: that transport encryption is off, that traffic is readable by anything on the path including the Cloudflare edge, and how many pinned devices will now be refused.
- Emits `e2ee.disabled` at **warn** with a reason, so a supervised instance leaves evidence in `~/.threadbase/logs/`.
- Reported to clients as `e2ee: { supported: true, enabled: false, reason: "disabled by --no-e2ee" }`.
- **Does not** disable at-rest encryption. Two different properties with two different threat models; one flag turning off both is the kind of coupling that gets an operator more than they asked for. At-rest gets its own `--no-db-encryption` if anyone ever needs it, and today nobody has asked.

There is deliberately **no** `server.yaml` key and **no** env var for it. The reasoning is `auto_resume_on_boot`'s, inverted: that setting is persisted precisely so the user is asked once and never again, whereas this one should require a deliberate act at every single boot. An operator who wants it permanently edits their launchd plist or Task Scheduler action, which is a visible, auditable change.

### 6.5 The feature flag

`e2ee` joins the registry (`src/feature-flags.ts`) with `default: false` at stage 0 and `default: true` from stage 2.
It is the kill switch, and it is distinct from `--no-e2ee`: the flag says "this build's E2EE code path is off", the CLI flag says "this operator chose plaintext for this run". Precedence puts the CLI flag last-word for the run, per the documented order.

---

## 7. Staged rollout

The constraint: `tb-mobile` cannot be force-updated (`docs/compatibility/tb-mobile.md:3`), so at every stage some clients speak E2EE and some do not, and the plaintext path must exist without being a downgrade oracle.

The resolution is that **plaintext acceptance is per-device, not per-server**. A device that has never proved it can do E2EE is served in plaintext; a device that has is never served in plaintext again. That single rule is what lets the two coexist for as long as it takes.

| Stage | Server default | Server accepts | Pins on pair? | Client behaviour | Exit criterion |
|---|---|---|---|---|---|
| **0 — capability** | flag off | plaintext only | no | New clients see `e2ee.supported: true, enabled: false` and stay plaintext. | Handshake, envelope, and at-rest all merged behind the flag with tests. QR grows `spk`/`v` (inert while the flag is off) so field QRs are already forward-compatible. |
| **1 — opt-in** | flag off, operators can enable | both | **yes**, when enabled | E2EE-capable clients use it where offered; old clients unaffected. | A real pairing + a real session over the tunnel and over LAN `http://`, on iOS and Android. Query timings still under threshold. |
| **2 — default on** | flag on | both | yes | Same. Pinned devices are now the majority. | Telemetry shows the plaintext path is only unpinned/old devices. `--no-e2ee` exercised and its warning verified. |
| **3 — required** | flag on, `e2ee.required: true` | E2EE only | n/a | An unpinned old client gets `426 E2EE_REQUIRED` and a message telling it to update and re-pair. | An explicit product decision with a minimum app version, never an automatic consequence of stage 2. |

**Why stage 3 is a separate decision and not a date:** it is the first point at which a released app stops working. That is a support event, not a security milestone, and it should be taken deliberately with a known floor for app versions in the field.

**Rollback at every stage:** turn the flag off. Pinned devices then get `426` rather than being silently downgraded — a visible, diagnosable failure. That is the correct trade: an outage you can see beats a downgrade you cannot. It also means rollback is not free, which is worth knowing *before* stage 2 rather than during an incident.

**What is not a rollout stage:** at-rest encryption. It is a one-way migration of a rebuildable cache (`cache.db` is regenerable from `~/.claude`/`~/.codex` by design) plus a non-rebuildable `runtime.db` that needs a real re-encrypt-in-place migration with a backup first. It ships independently of the transport work and has no client-visible surface at all.

---

## 8. Contract additions (all additive)

```
GET  /api/info                    → + e2ee: { supported, enabled, version, required, reason? }
POST /api/pair/exchange           → + request  e2ee: { v, noise }
                                    + response e2ee: { v, noise }
                                    (existing sealed-API-key fields unchanged and still sent)
POST /api/e2ee/open               → new, public, Noise IK; returns { ctxId, expiresAt, ticket }
GET  /ws?ticket=<t>               → new auth form; ?key= still accepted for unpinned devices
GET  /api/devices                 → + e2ee: boolean per device (never a key, never a hash)
POST /api/devices/:id/revoke      → now also destroys contexts and terminates live sockets

Headers (E2EE requests only):  X-TB-E2EE: 1  ·  X-TB-Ctx: <ctxId>  ·  X-TB-Seq: <n>
New error:  426 { error, code: "E2EE_REQUIRED" }
```

Nothing renamed, nothing removed, no field retyped, no WS event string changed, no new `SessionStatus` value. Every existing path, parameter, and event in `docs/compatibility/tb-mobile.md` keeps working unchanged for an unpinned device.

---

## 9. Test plan

| Requirement | Test |
|---|---|
| Server authentication | A handshake against a *different* `spk` than the QR's fails, and fails before any payload is decrypted. |
| QR compatibility | An old `parsePairUri` fed a new QR ignores `spk`/`v` and pairs as today. |
| QR legibility | The `{ small: true }` QR with `spk` renders inside 80 columns. |
| Pair-token binding | A handshake with a valid static key but a wrong/absent PSK fails. |
| Single-use replay | A second exchange with the same token 401s **and** emits the `pair.token_replayed` warn line. |
| Nonce discipline | A counter is never reused within a context; a forced repeat is rejected and closes the socket. |
| WS strict ordering | Out-of-order, duplicate, and gapped counters each close the socket with `e2ee.sequence_violation`. |
| REST window | Concurrent requests arriving out of order all succeed; a replayed one is rejected. |
| AAD binding | Mutating `ctxId`, `seq`, or `channel` in the header fails decryption. |
| Downgrade | A pinned device presenting `?key=` or an unsealed body gets `426`, never `401`, never a plaintext answer. |
| Downgrade (client) | A pinned server answering `e2ee.supported: false` produces a hard failure, not a fallback. |
| `--no-e2ee` | Boot warning printed to console, `e2ee.disabled` at warn, `/api/info` reports the reason, pinned devices get `426`. |
| At-rest | `cache.db`, its `-wal` and `-shm`, and `runtime.db` contain no plaintext conversation text after a session. |
| At-rest key hygiene | A backup archive never contains `keys/`. |
| At-rest cost | Query timings stay under `THREADBASE_DB_SLOW_QUERY_MS`; the p99 regression is recorded, not assumed. |
| Revocation | Revoking a device closes its live WebSocket, not just its next request. |
| Legacy path | An unpinned device with the shared API key does everything it does today, plaintext, unchanged. |
| Log hygiene | `?ticket=` and `?key=` appear as `_` in `http.request` (`src/api/app.ts:53-57`); no sealed or unsealed body is ever logged. |

---

## 10. Known limits

Stated so they are not later discovered as gaps.

- **A compromised streamer host defeats all of this.** Same limit the device-identity design records (`docs/architecture/2026-07-24-device-identity-and-capabilities.md:148`), and it is not narrowed here.
- **Metadata is not protected.** Paths, sizes, and timing remain visible at the ingress (§3.2).
- **`IK` gives no forward secrecy against an attacker who steals `S_priv` and is then active.** §4.3.
- **A photographed QR still yields a paired device** within the 180-second window. §2.6.
- **Provider histories stay plaintext.** The cache is encrypted; `~/.claude/*.jsonl` is not, and it is the authoritative copy.
- **`server.yaml` still holds the API key in cleartext**, and its first creation lacks a `0600` mode (context.md Open question 4).
- **At-rest encryption does not survive a stolen laptop** whose disk is not encrypted, because the key file sits in the same home directory. §5.3.
- **Rollback from stage 2 is an outage for pinned devices**, by design. §7.
