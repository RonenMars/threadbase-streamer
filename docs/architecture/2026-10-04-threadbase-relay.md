# Threadbase Relay — design (Phase 0)

Status: **proposed, awaiting review**. No production behaviour changes until this is approved.
Checked against `main` @ `b69b7487` (streamer 1.107.2) and the tb-mobile working tree on 2026-10-04.
Hostnames in this document are illustrative (`relay.example.com`).

## 1. Summary

Threadbase Relay is an optional hosted service that forwards bytes between a phone and a user-owned streamer, so remote access works without Cloudflare, Tailscale, NAT or DNS setup.

The design rests on one finding: **the streamer's E2EE layer already makes any HTTP intermediary blind.**
A relay that forwards HTTP and WebSocket bytes sees exactly what Cloudflare sees today, and sealed REST and WS need no cryptographic change.
So the relay is a reverse proxy over an outbound tunnel, not a new protocol stack, and the mobile app treats it as one more address for a server it has already paired with.

Three decisions follow from that:

- **Transport:** existing-protocol proxying (`https://relay.example.com/r/<routeId>/…`) over one multiplexed streamer→relay WebSocket.
- **Identity:** the route id is derived from the streamer's existing X25519 identity key, and the streamer proves possession of that key with a Noise handshake. The relay keeps no registry, no accounts and no stored state.
- **Authorization:** unchanged. The relay never authenticates a phone; the streamer does, with the device's Noise static key, exactly as on the direct path.

## 2. Current architecture (mobile → streamer)

| Area | What exists | Anchor |
|---|---|---|
| Streamer identity | One X25519 static key, `~/.threadbase/keys/server-identity.key`. **DH-only, it cannot sign.** No Ed25519 key exists anywhere. | `loadOrCreateServerIdentity`, `src/server-identity.ts` |
| Pairing | QR `threadbase://pair?url=…&token=pt_…&exp=…&spk=…&v=1`. One public `POST /api/pair/exchange`. With `spk`: `Noise_IKpsk1`, the phone pins the streamer key. Without `spk`: legacy NaCl box of the shared API key, no server authentication. | `printServerBanner`, `handlePairExchange`, `parsePairUri` (mobile) |
| Device credential | `devices` row in `runtime.db`: token hash, capabilities, `e2ee_static_pub`, `e2ee_required`. | `devices.repository.ts` |
| Transport open | Public `POST /api/e2ee/open`, `Noise_IK` (no psk), payload `{v, kind: "ws"\|"rest"}`. Returns `ctxId`, and a single-use ticket for WS. Contexts are in memory, provisional for 30 s until first use. 5 opens per minute per device. | `createE2eeRoutes`, `runOpenHandshake` (mobile) |
| REST | Body is one sealed record; headers `x-tb-e2ee`, `x-tb-ctx`, `x-tb-seq`, `x-tb-env`. No `Authorization` on a sealed request. AAD binds `sha256(METHOD\npath\nquery)`, not host or scheme. | `e2eeEnvelopeMiddleware`, `sealedFetch` (mobile) |
| WebSocket | One endpoint, `GET /ws`. Sealed sockets authenticate by ticket (`x-tb-ticket` or subprotocol), one record per binary frame, first sealed frame within 10 s. Client frames capped at 64 KiB. | `mountWebSocket`, `openTicketedSocket` (mobile) |
| Uploads | `POST /api/sessions/:id/files`, base64 in JSON, one sealed record up to 64 MiB. Not chunked. | `MAX_UPLOAD_RECORD_BYTES`, `uploadAttachment` (mobile) |
| Plaintext fallback | Unpinned devices and the shared `tb_` key are served in clear, with `Authorization: Bearer` or `/ws?key=`. | `authMiddleware` |
| "Local" callers | Decided by `socket.remoteAddress` being loopback. Opens `/api/logs`, `/api/logs/meta`, and everything under `--local-no-auth`. `/healthz` is open when `cf-connecting-ip` is absent. | `isLocalRequest`, `LOCAL_ONLY_PATHS` |
| Mobile addresses | A server record already has two addresses, `url` and `publicUrl`, tried in order for pinned servers. The opened context carries its own base URL. | `serverAddresses()`, `services/server-addresses.ts` |
| Mobile client | One request function (`authedFetch`), one WS manager (`wsManager`). Two raw fetches precede credentials: pair exchange and `/open`. | `services/authed-fetch.ts`, `services/ws-client.ts` |
| Push | Streamer → Expo push service. No Threadbase-hosted service. Unaffected by the relay. | `registerPushToken` (mobile) |

What an intermediary sees today, and the relay would see: method, path, query string (which contains session and conversation ids), status code, `x-tb-*` headers, `X-Client-Id` (a stable per-install UUID), `ETag` / `If-None-Match`, sizes and timing.
It sees no bodies and no WebSocket message content.

## 3. Proposed architecture

```text
            direct (unchanged)
Mobile ───────────────────────────────────────────► Streamer :8766
   │                                                    ▲
   │  https://relay.example.com/r/<routeId>/api/…       │ relay ingress listener
   │  wss://relay.example.com/r/<routeId>/ws            │ (unix socket / named pipe)
   ▼                                                    │
 Relay ◄════════ one outbound WebSocket tunnel ═════ Relay connector
        logical streams: one per HTTP request or WS      (optional, off by default)
```

- Sealed bytes pass end to end between phone and streamer. The relay holds no Noise key of either party's E2EE relationship.
- The relay connector is a separate optional module. If it cannot connect, the streamer logs it, reports it in diagnostics and carries on; nothing else depends on it.
- On mobile, `relayUrl` becomes a third entry in `serverAddresses()` for pinned servers. Same server record, same device key, same pin, no re-pairing.

### 3.1 Transport choice

| | A. Raw multiplexed transport | **B. Existing-protocol proxy (chosen)** | C. Hybrid control/data plane |
|---|---|---|---|
| Mobile change | New client transport | One extra base URL | New client transport |
| HTTP semantics | Reimplemented on the phone | Native | Split |
| WebSocket | Custom | Native upgrade, forwarded | Custom |
| Uploads, backpressure | In the mux | In the mux, relay↔streamer leg only | Two mechanisms |
| Blindness | Same | Same | Same |
| Complexity | High | Lowest | Highest |

B is chosen because the mobile seam already exists and the AAD does not bind the host, so a path-prefixed relay URL works with the current sealing code.
The multiplexing of option A is still needed, but only on the relay↔streamer leg, where both ends are ours.

## 4. Identity, routing and authentication

### 4.1 Route id

```text
routeId = base64url( sha256( "threadbase-relay/1 route" || spk ) )[0..32 chars]   (192 bits)
```

`spk` is the streamer's X25519 public key, already in the QR and `/api/info`.
The route id is a locator, not a credential: knowing it lets a client send bytes toward a streamer, which then authenticates the device itself.

Because the id is a function of the key, the relay needs **no registration step and no database**.
Whoever proves possession of key `K` owns route `H(K)`, and nobody else can.

### 4.2 Streamer → relay authentication

The identity key cannot sign, so a signature challenge would need a second permanent key.
Instead the tunnel opens with the Noise code the streamer already has:

1. The streamer dials `wss://relay.example.com/tunnel` and sends `Noise_IK` message 1 as initiator, with its identity key as the static key, the relay's pinned static public key as responder key, and a new prologue `"threadbase-relay/1 tunnel"`.
2. The relay replies with message 2, which contains its fresh ephemeral.
3. The streamer sends one sealed confirmation frame under the resulting transport keys.

Step 3 is the challenge-response: the transport keys depend on the relay's fresh ephemeral, so a replayed message 1 cannot produce a valid confirmation.
Only after step 3 does the relay attach the tunnel to `H(spk)`.

The relay's static public key ships as a default in the streamer and is overridable in `server.yaml`, so a self-hosted relay works too.
The prologue separates this use of the identity key from the pairing and open handshakes.

Version negotiation rides inside the handshake payloads: message 1 carries `{v, protocols: [1], caps: ["http", "ws"]}` and message 2 carries `{protocol: 1, caps, limits, tunnelId}`.
A relay that supports none of the offered protocols answers with a close code the connector maps to `unsupported_protocol`.

### 4.3 Mobile → relay

The relay does not authenticate phones.
A sealed request carries no credential the relay could check, and adding a relay credential would create the parallel identity system the mission warns against.
The relay applies only shape checks and limits (section 7); the streamer remains the sole authorization boundary.

### 4.4 Tenant isolation

A logical stream lives inside exactly one tunnel object:

```text
routing key = ( routeId from authenticated spk , tunnelId , streamId )
```

- `streamId` is allocated by the relay per tunnel, never by a client, and is meaningless outside that tunnel.
- A client request for `/r/<routeId>/…` is attached to the tunnel currently registered for that route id, and to nothing else. Session ids and other application ids are never read.
- When a streamer reconnects, the new authenticated tunnel replaces the old one. The old tunnel is closed and every stream on it is reset; no frame is ever redirected from one tunnel to another.
- Even if the relay misroutes, the receiving streamer holds no E2EE context or device row for that phone and refuses the request.

### 4.5 Streamer side: the relay ingress listener

A connector that dialled `127.0.0.1:8766` would look like a local caller and inherit the loopback carve-outs.
To make that impossible by construction, the streamer opens a **second listener on a unix socket (named pipe on Windows)** with the same request handler, and the connector forwards relay streams only to it.

- Requests on that listener are tagged `viaRelay` by which listener accepted them, not by a header a caller could forge or a proxy could drop.
- A unix-socket connection has no `remoteAddress`, so `isLocalRequest` is already false for it. This is to be verified by a test, not assumed.
- On `viaRelay` requests the streamer accepts only sealed REST, ticketed WS, `/api/e2ee/open`, and `/api/pair/exchange` **with** an `e2ee` block. It refuses `Authorization`, `?key=`, legacy pairing, `/healthz` without a context, and `--local-no-auth`.
- Rate-limit buckets that key on `remoteAddress` use a relay-supplied opaque client tag instead, so one remote attacker cannot exhaust the pairing or `/open` budget for everyone. The tag only ever feeds rate limiting.

## 5. Tunnel protocol

One WebSocket, binary frames, after the handshake in 4.2:

```text
frame = type(1) || streamId(4, BE) || payload(≤ 64 KiB)
```

| Type | Direction | Payload |
|---|---|---|
| `OPEN` | relay → streamer | JSON `{kind: "http"\|"ws", method, target, headers, clientTag}` |
| `HEAD` | streamer → relay | JSON `{status, headers}`; for `ws`, `{accepted: true, protocol?}` or `{accepted: false, status}` |
| `DATA` | both | body bytes; for `ws`, a flag byte then a piece of one binary message (flag `1`: more of the same message follows) |
| `END` | both | half-close: no more data from this side; for `ws`, JSON `{code, reason}`, the WebSocket close |
| `RESET` | both | `{code}`: abort the stream |
| `WINDOW` | both | `{credit}`: flow-control credit in bytes |

Liveness uses WebSocket ping/pong; no frame type is spent on it.

A WebSocket stream is opened only on a ticket (`x-tb-ticket`, or the `threadbase-e2ee-v1` subprotocol offer) and never with a credential.
The relay completes the client's upgrade only after the streamer accepts it, and selects only the subprotocol the streamer selected, so an offered ticket is never echoed.
A refused upgrade is answered with the status the streamer refused with.
A message larger than a frame is split into pieces and sent on as WebSocket fragments, so neither side holds a whole message for the other; flow-control credit counts message bytes, not the flag byte.
Sealed sockets are binary in both directions, and a text message ends the stream.
The streamer's own ping reaches only the connector's local socket, so the relay pings each client every 30 s and drops one that does not answer.
Headers are forwarded from an allowlist (`x-tb-*`, `content-type`, `content-length`, `accept`, `if-none-match`, `etag`, `cache-control`, `sec-websocket-protocol`), and the relay never caches, rewrites or compresses a response.

### 5.1 Limits and backpressure

| Limit | Initial value |
|---|---|
| Frame payload | 64 KiB |
| Concurrent streams per tunnel | 64 |
| Flow-control window per stream | 256 KiB |
| Buffered bytes per tunnel, both directions | 8 MiB |
| HTTP request body | 64 MiB + record overhead (matches `MAX_UPLOAD_RECORD_BYTES`) |
| Tunnels per route | 1 |
| Client WebSockets per route | 16 |
| Stream idle timeout (HTTP) | 60 s without bytes |
| Tunnel handshake deadline | 10 s |

Flow control is credit-based per stream.
A sender may not exceed the credit it holds; a receiver grants credit as it drains to the next hop.
When a phone is slow, the relay stops granting credit to the streamer for that stream, and the connector stops reading from the local socket, so pressure reaches the streamer's own WS send path.
Exceeding a limit resets the stream with `RELAY_OVERLOADED`; it never queues without bound.
A 64 MiB upload flows through in 64 KiB frames under the window, so the relay never holds a whole file.

### 5.2 Failure semantics

Relay-originated responses are plaintext JSON `{error, code}` with header `x-tb-relay-error: 1`, so a client can tell them from a streamer response before touching the envelope.

| Code | Status | Meaning |
|---|---|---|
| `RELAY_STREAMER_OFFLINE` | 503 | No tunnel for this route. Also returned for a route that never existed, so route ids cannot be enumerated. |
| `RELAY_STREAMER_RECONNECTING` | 503 + `Retry-After` | Tunnel dropped within the last 15 s. |
| `RELAY_OVERLOADED` | 503 | A stream, buffer or connection limit was hit. |
| `RELAY_RATE_LIMITED` | 429 + `Retry-After` | Per-IP or per-route rate limit. |
| `RELAY_TIMEOUT` | 504 | Streamer accepted the stream and went silent. |
| `RELAY_STREAM_RESET` | 502 | Tunnel died mid-response. |
| `RELAY_UNSUPPORTED_REQUEST` | 400 | Request failed the shape check (plaintext, credential present, path not allowed). |

The relay never emits 403 or 404, because mobile reads those on `/api/e2ee/open` as a permanent "device revoked" or "E2EE disabled" (`mapOpenFailure`).
WebSocket failures use close code 1013 with the code as the reason.

Connector states, reported in `GET /api/diagnostics` as a `relay` check: `disabled`, `connecting`, `connected`, `reconnecting`, `authentication_failed`, `unsupported_protocol`.
Reconnect uses exponential backoff from 1 s to 60 s with jitter.

## 6. Trust boundaries

| Party | Trusts | Does not trust |
|---|---|---|
| Mobile | The streamer key it pinned at pairing. | The relay, for anything but delivery. |
| Streamer | Its own device registry and E2EE contexts. The relay's static key only as "this is the relay I chose to dial". | Anything the relay says about who a client is. |
| Relay | That a tunnel owner holds the private key for its route. | Clients, and streamers beyond their own route. |

**A malicious relay can:** drop, delay or reorder traffic; observe the metadata listed in section 2 plus client and streamer IP addresses; refuse service.
**It cannot:** read or forge sealed content, impersonate a streamer to a pinned phone, or impersonate a phone to a streamer.
**Wrong routing** delivers sealed records to a streamer with no matching context, which refuses them.

Pairing through the relay is safe only with `spk`: the phone authenticates the streamer in the Noise handshake, and the pair token is the psk.
Legacy pairing has no server authentication and is refused on the relay path.

## 7. Threat model

| Threat | Mitigation |
|---|---|
| Cross-tenant routing | Routing key in 4.4; streams never leave their tunnel; streamer-side E2EE refusal as second line. |
| Route id enumeration | 192-bit ids; unknown and offline routes are indistinguishable; per-IP rate limit. |
| Forged streamer registration | Noise handshake proves possession of the key the route id is derived from. |
| Replayed tunnel handshake | Confirmation frame under keys that include the relay's fresh ephemeral. |
| Stolen streamer identity key | Attacker can take over the route (denial of service, metadata) but still cannot open device contexts. Recovery is key rotation, which does not exist today (open item). |
| Stale tunnel takeover | Newest authenticated tunnel wins; replacement rate-limited to stop two holders of one key flapping. |
| MITM by relay | E2EE with pinned `spk`; relay path refuses plaintext and legacy pairing. |
| Malformed or giant frames | Fixed header, 64 KiB cap, tunnel closed on first violation. |
| Resource exhaustion, reconnect storms | Limits in 5.1; per-IP connection and handshake rate limits; idle timeouts. |
| Unauthorized stream creation | Only the relay opens streams, only toward the tunnel for the requested route. |
| Use as a free generic tunnel | Shape check: sealed-only, path allowlist (`/api/*`, `/ws`, `/healthz`), per-route byte accounting. See open decision 1. |

## 8. Pairing and server records

- The QR gains an optional `relay=<base URL>` parameter when the relay is enabled. It is an unauthenticated hint, used only so a phone that cannot reach `url` can still run the pair exchange.
- The authoritative `relayUrl` travels inside the authenticated pairing message 2, next to `publicUrl`, and in the sealed `/api/info` response, so **already-paired devices learn it without re-pairing**.
- Mobile stores `relayUrl` as a new field on the same `ServerConfig`. It must not be written into `url`: the server id is derived from `url`, and editing it wipes the pairing.
- Only pinned servers ever use the relay address.

Multiple streamers are independent routes; multiple phones on one streamer are independent client connections and independent E2EE contexts.

## 9. Observability and privacy

Logged per event: hashed route id, tunnel id, stream id, kind, byte counts, duration, close code.
Never logged: paths, query strings, headers, bodies, tickets, IP addresses in application logs.
Rate limiting keeps client IPs in memory only, keyed by a salted hash that rotates daily.

Metrics: connected tunnels, client connections, active streams, bytes each way, tunnel reconnect rate, failed handshakes, rate-limit hits, stream resets by code.

Privacy documentation must state plainly that the relay sees connection metadata (IP addresses, timing, sizes, request paths including session ids) and not content.
"Blind" is true of content only.

## 10. Deployment

One Node/TypeScript process, one region, no database, no queue.
Tunnels live in process memory, so a deploy drops them and connectors reconnect within their backoff.

For multiple instances later, the protocol needs no change, because identity is the key-derived route id rather than anything process-local.
What would change: a shared route→instance map (or consistent hashing at the load balancer) so a client request reaches the instance holding the tunnel.

## 11. Implementation sequence

Each row is one reviewable PR unless noted. Estimates are focused working days.

| Phase | Repo | Deliverable | Est. |
|---|---|---|---|
| 1 | relay (new) | Service skeleton, config, `/healthz`, tunnel handshake, route registry, frame codec, isolation and impersonation tests. | 4 |
| 2a | streamer | Relay ingress listener, `viaRelay` tagging and refusals, tests that every loopback carve-out is closed on it. | 2 |
| 2b | streamer | Connector: dial, handshake, backoff, `relay` feature flag (default off), `server.yaml` keys, diagnostics check. Kill-relay regression test. | 3 |
| 3 | relay + streamer | One sealed `GET /api/info` end to end; capture at the relay proves no plaintext. | 2 |
| 4 | relay + streamer | Generic HTTP: streaming bodies, cancellation, timeouts, flow control. | 3 |
| 5 | relay + streamer | WebSocket streams, slow-consumer and high-throughput tests. | 3 |
| 6a | streamer | `relay=` in QR, `relayUrl` in pairing message 2 and `/api/info`. | 1 |
| 6b | mobile | `relayUrl` field and persistence, third address, relay error mapping, settings toggle and copy (en/he/ar/ru). | 5 |
| 7 | all | Upload and backup validation through the relay; limits tuned. | 2 |
| 8 | relay | Rate limits, quotas, metrics, graceful drain, load and abuse tests. | 5 |
| 9 | all + landing | Rewrite the "no hosted service" claims; privacy policy; release notes. | 2 |

Total: about 32 days, before real-device QA.

### Changes outside the relay repo

**Streamer:** new `src/relay/` (connector, ingress listener, frame codec), `relay` flag in `FEATURE_FLAGS`, `relay_url` and `relay_public_key` in `server.yaml`, a `relay` diagnostics check and remediation codes, rate-limit keying, QR and pairing payload additions.

**Mobile:** `relayUrl` on `ServerConfig` and `PersistedServer`, `serverAddresses()`, `ServerAddressesSection`, `readPairHandshakeReply`, `parsePairUri` and the `buildPairUri` allowlist, `mapOpenFailure` and the unsealed branch of `sealedFetch`.

**Docs to rewrite in phase 9:** tb-mobile `README.md`, `docs/FEATURES.md`, `docs/no-hosted-service.md`, `docs/privacy-and-verifiable-builds.md`, the proposed privacy policy, `docs/store-console-wording.md`; tb-landing `home.security.*` copy; streamer `docs/guides/remote-access/README.md`.

## 12. Open decisions

1. **Admission (decided 2026-10-05: open, with the shape check and per-route byte quotas).** With no accounts, any process holding a valid keypair can attach a tunnel. Recommended for beta: open, with the shape check and per-route byte quotas. The alternative is an invite token in `server.yaml`, which costs zero-configuration.
2. **Authentication key.** Recommended: reuse the X25519 identity through Noise (4.2). The alternative is adding an Ed25519 signing key, a second permanent identity.
3. **Noise code in the relay.** The relay needs the responder half of `src/e2ee/noise.ts`. Recommended for v1: copy the file with its committed test vectors. The alternative is extracting a shared package first.
4. **Tunnel frame protection.** Recommended: rely on TLS after the Noise-authenticated handshake. A TLS-terminating proxy in front of the relay could then hijack a route, which costs availability and metadata but not content. The alternative is sealing every tunnel frame, which double-encrypts all traffic.
5. **Metadata exposure (decided 2026-10-05: accept for v1 and state it in the privacy text).** Paths, query strings and `X-Client-Id` are visible to the relay, as they are to Cloudflare today. Recommended: accept for v1 and say so in the privacy text. Hiding them means moving the request target inside the envelope, a wire change for both clients.
6. **Relay repository, hosting and domain.** A new `threadbase-relay` repo. Hosting on Vercel Functions was requested on 2026-10-05; it supports WebSocket servers, but the design needs a client request to reach the same instance that holds the streamer tunnel, and that is unverified there. The repo is public.
7. **Address order on mobile.** As a third address, the relay costs up to 8 s before first byte off-LAN (4 s per earlier address). Remembering the last address that worked would fix it, and is not in the phases above.

## 13. Findings outside the relay's scope

- **`/api/logs` and `/api/logs/meta` look reachable without credentials through a Cloudflare tunnel.** `LOCAL_ONLY_PATHS` is gated on loopback `remoteAddress` alone (`auth.middleware.ts`, `LOCAL_ONLY_PATHS.has(path) && isLocalRequest(remoteAddr)`), with no `cf-connecting-ip` check, and the file's own comment says tunnelled requests arrive from `127.0.0.1`. Read from code, not tested against a live tunnel.
- A pinned phone presenting the shared `tb_` key bypasses the E2EE pin (acknowledged in code comments).
- `/api/pair/exchange` and the plaintext upload path read the body with unbounded `readBody`.
- `docs/guides/remote-access/README.md` says the streamer binds `127.0.0.1` only; the default bind is all interfaces.
- The `src/server-identity.ts` header says no handshake uses the key yet; two do.
