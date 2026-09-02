# E2EE program review — 2026-08-29 (`e2ee-mega-brain-reviewer`)

**Requested by:** `e2ee-owner [ddde5e]`, 01:44 IDT, on the user's instruction; supplement 01:58 (W's four "push hardest" points). Read-only: no repo, worktree or config was edited; the implementer's untracked `src/e2ee/record.ts` / `src/e2ee/protocol.ts` were read, never run.

**Inputs, pinned.** Streamer `origin/main` **91ce3f18** (latest tag v1.70.6 = 0069afc1); mobile `origin/main` **f3e82287**. `NONCE-DESIGN.md` as approved 01:45 (uncommitted, `.worktrees/feat/e2ee-record-impl`, 244 lines). From `origin/main`: `design.md`, `mobile-design.md`, `plan.md`, `dilemmas.md`, `remaining-work.md`, `understanding.md`, `src/e2ee/*.ts`, `src/ws-hub.ts`, `src/server-wiring.ts`, `src/api/app.ts`, `auth.middleware.ts`, `misc.routes.ts`, `ws.routes.ts`, `devices.routes.ts`, `devices.repository.ts`, `capabilities.ts`, `feature-flags.ts`, `server.ts` (pairing route, upgrade wiring), `http-helpers.ts`, `sessions.handlers.ts` (stop stream); mobile `services/e2ee/*.ts`, `services/ws-client.ts`, `services/authed-fetch.ts`, `services/api-client.ts` (grep), `hooks/useTerminalStream.ts`, `services/cleartext-policy.ts`, `stores/servers.ts` (grep), `package.json`; `tracks/*` (plan rev 2, STATUS, every brief, PLAN-W, AUDIT-M); issues #590, #698, #903–#906; PRs #737, #739, #740, #900–#902.

**Severity key.** **BLOCKER** — must be settled before W1a's PR, because the tag freezes a contract X-server and X-client build on (the record API, the frozen codes, §8's lifetimes, the `/open` handshake). **HIGH** — ships a real defect or an exploitable gap if built as written. **MEDIUM** — a contradiction or underspecification the two independent implementations will resolve differently, or a bounded but real risk. **LOW** — correctness nit or hygiene. **NOTE** — no defect; a judgement the user may want to see.

---

## Summary

The core of `NONCE-DESIGN.md` is sound and the WIP `record.ts` implements it faithfully: `direction(4)‖counter(8)` big-endian, a `bigint` counter owned by the state, the 30-byte AAD, R1–R4, "never reset", the 2^64−1 refusal, per-socket contexts. **No finding against §2–§5 as written.** Every defect below sits where NONCE-DESIGN meets a channel it declares out of scope, or where a ruling overrode `design.md` without following the consequence through:

1. **The `/api/e2ee/open` handshake is unspecified** (pattern name, prologue, PSK) and both codebases only implement `IKpsk1` with a mandatory PSK — W1a is building `/open` now, X-client will build the other half later, and nothing written down makes them agree. (B1)
2. **The REST envelope is specified three different ways** on response binding (contradicts R4), on where the credential travels (three readings across `design.md` §4.4, X-server's brief, X-client's brief), and it binds nothing about the request target, so a sealed `POST /api/sessions/A/input` can be re-routed to session B. (B2)
3. **In-place rekey is unsynchronisable on the only channel that performs it.** Ruling (b) made rekey "n/a" on the socket; ruling (c) left 1 GiB and foreground as REST-only triggers; a sliding-window receiver cannot tell which key a counter was sealed under without the epoch §6 forbids. The clean fix is the one ruling (c) already chose for 24 h: no in-place rekey anywhere, a new key is a new context. (B3)

Counts: **3 blockers, 4 high, 12 medium, 12 low, 9 notes.** Rulings (a)–(d): (a) correct, made moot by B3; (b) endorsed with two costs to fix (H1 orphan contexts, M6 async connect); (c) endorsed and extended; (d) endorsed, which is why B1/B2 must land in W1a.

**Suggested application order** (the user HOLD in STATUS 01:58 is right): revise NONCE-DESIGN once for B1 + B2(a–c) + B3 + H1 + M1 + M2 → implementer continues → adversary brief gains the rows in §"Verifier additions" → X-server's plan absorbs M8 → X-client's brief absorbs H2/M6/M7 → H4 and N4 go to the user.

---

## The four rulings the owner asked to have attacked first

| Ruling | Verdict | Why |
|---|---|---|
| (a) Counter does not reset on rekey | **Correct** — and a derivation, not only a judgement | Uniqueness of `(k, nonce)` is implied by uniqueness of `nonce` per context whatever `k` does, so "never reset" is strictly stronger than "reset on rekey" and needs no epoch and no per-key argument. Noise §11.3 being the precedent is incidental. **B3 makes it moot**: with no in-place rekey there is nothing to survive. Keep the sentence as the invariant ("one counter value, once, per direction, per context"); drop the rekey test obligation (§12 row "§6 counter survives a rekey") together with `rekey()`. |
| (b) One context per channel instance | **Endorsed** | The close-loop argument holds because the *receive state*, not only the key, would be shared across sockets, and frames in flight at a drop are lost. A bounded resync on reconnect (W's point 2) would reintroduce a replay window on the highest-volume channel to save one handshake — wrong trade. The only design that avoids the second handshake (one device context, per-socket sub-keys via HKDF with a socket index inside the nonce's 4 direction bytes) changes the nonce layout everyone has agreed and is not worth it now. Two consequences were not followed through: a socket context whose ticket is never consumed has no end of life (**H1**), and the mobile connect path becomes async with a race under `forceReconnect` (**M6**). Cost to measure in D2: +1 RTT + 2 DH on every foreground — exactly what `mobile-design.md` §4.3:150 wanted to avoid; the foreground *rekey* it proposed instead is now dead weight (B3 iv). |
| (c) 24 h destroys; rekey on 1 GiB + foreground | **Endorsed, and go further** | Destroy-and-reopen is the right mechanism for every key change (B3). 1 GiB and foreground should mean the same thing as 24 h. |
| (d) X-client → Opus 5/high + adversary; X-server keys off W1a's tag | **Endorsed** | The tag dependency is what makes B1 and B2(a) blockers: `record.ts`'s API and the `/open` payload freeze at that tag, and X-server cannot seal a response bound to its request with `seal(plaintext)`. |

---

## BLOCKER

### B1 — `/api/e2ee/open`'s handshake is unspecified; both implementations only speak `IKpsk1` with a mandatory PSK

**Where.** `NONCE-DESIGN.md` §1:5 (handshake declared out of scope) and §8:105 (`POST /api/e2ee/open → { ctxId, ticket }`); `design.md` §3.5:295 ("Noise IK messages 1 and 2 using the *stored* static keys"), §4.2:329 ("Noise IK handshake (+ pair-token PSK at pairing)"); streamer `src/e2ee/noise.ts:47` (`NOISE_PROTOCOL_NAME = "Noise_IKpsk1_25519_ChaChaPoly_SHA256"` seeds `h`), `:50-72` (the prologue namespace: `"threadbase-e2ee/1 open"` is *named* for `/open` and explicitly "not declared until something uses it"; "no PSK" at `/open`), `:392-436` (`writeMessage1` always `mixKeyAndHash(args.psk)` at `:428`; prologue defaults to `PAIR_PROLOGUE` at `:402`), `:503-546` (`readMessage1` requires `psk`, mixes it at `:534`, prologue defaults at `:512`); mobile `services/e2ee/noise.ts:26` (same name), `:191-199` (`psk` is a required config field), `:237` (`sym.mixKeyAndHash(config.psk)` unconditionally). Mobile has no "no-PSK" initiator and the streamer no "no-PSK" responder.

**Failure scenario.** W1a implements `/open` as one of the three plausible readings — (i) `Noise_IK_…` without `psk1` (new protocol name, `mixKeyAndHash` skipped), (ii) the `IKpsk1` code path with a constant PSK, (iii) the `IKpsk1` path with a PSK derived from something — under one of two prologues (the named `"…/1 open"`, or the default `PAIR_PROLOGUE` because `prologue?` is optional). X-client, reading "Noise IK against stored static keys", picks another. Every `/open` then fails with "decryption failed" and nothing else, discovered at X-client's interop run weeks after the tag. If the prologue is left at the default, the domain separation `noise.ts:53-60` argues for is silently absent: a captured pairing msg1 and an `/open` msg1 differ only by the PSK step.

**Fix (in NONCE-DESIGN, before code).** Add a section "The `/open` handshake": protocol name, prologue bytes, PSK rule, msg1 payload, msg2 payload as exact JSON with encodings (see M2), and commit `/open` interop vectors beside the record fixtures (§13) — the Phase 2 lesson applies to this handshake too. Recommended: `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `"threadbase-e2ee/1 open"`, no PSK; this needs the psk-less branch in both `noise.ts` files (skip the `psk` token, different name) plus a test that the pairing vector fails against the open prologue. Alternative with less new crypto code: keep `IKpsk1` with `psk = SHA256("threadbase-e2ee/1 open-psk")` (a public constant — security reduces to `IK`, code reuse is total); acceptable if written down, less clean. Either way it must be one sentence both sides can read.

### B2 — The REST envelope contract contradicts R4, places the credential three different ways, and does not authenticate the request target

Settle (a)–(c) before W1a's tag: (a) changes `record.ts`'s API, (b) and (c) change the AAD/headers X-server and X-client both consume from the tag.

**(a) Response binding vs R4.** `design.md` §3.4:285 — "Responses do not need a window — each is bound to its request's counter in the AAD, and a response with the wrong counter is discarded by the client"; X-server `prompt.md:22` — "Seal on the way out with `channel = 0x03`, bound to the request's counter in the AAD". `NONCE-DESIGN.md` §5 R4:64-66 and §11:192 forbid a caller-supplied counter, and the WIP `record.ts:191` `seal(plaintext)` has no way to seal under a given counter. *Failure:* X-server either (i) builds a second s2c `RecordState` with its own counter — then responses are **not** bound to requests, and because React Query issues concurrent requests (`mobile-design.md` §4.1:123) an on-path attacker can swap two in-flight sealed responses within one REST context (both authenticate under `k_s2c` with fresh counters; the client has nothing to compare against) — or (ii) violates R4 through a private API. If responses *are* bound to the request counter, nonce uniqueness for `(k_s2c, 2‖counter)` rests on a rule nobody has written: **at most one sealed response per accepted request counter** — a request rejected by the window (replay) or by the AEAD must get a plaintext error and never a sealed body, including through the `onError` path (`app.ts:122`). *Fix:* define a distinct `RestResponseSealer.seal(requestCounter, plaintext)` as the one sanctioned request-echo shape (R4 governs *sequence* counters; an echo is not one), the no-sealed-response-for-a-rejected-request rule, and the client check `response.counter === request.counter`.

**(b) Where the credential travels.** `design.md` §3.6:312 and D-9:197-205 (unseal before auth *so that* the credential travels sealed); `design.md` §4.4:369 (the unseal middleware "resolves the principal from `ctxId`"); X-server `prompt.md:21` ("hand off to `authMiddleware` with the (now decrypted) credential" — inside the envelope); `mobile-design.md` §4.1:119 and X-client `prompt.md:27` ("`Authorization` carries the device token on E2EE pairings" — in the clear). *Failure:* X-client sends the device token in the clear on every sealed request — the exact leak D-9's ordering exists to close (an ingress operator holds a replayable bearer; harmless only while the 426 pin holds, and a downgrade oracle the moment `--no-e2ee`, a rollback or a lost pin (#903) reopens plaintext) — while X-server expects it inside the body, and `authMiddleware` (`auth.middleware.ts:56-63`) 401s a request carrying no `Authorization` at all. The two halves do not interoperate, and "header device ≠ context device" is undefined. *Fix:* principal from the context; no `Authorization` on sealed requests; the unseal middleware sets `principal` (+ per-request `revoked_at` re-check) and `authMiddleware` skips when one is already set; an `Authorization` present alongside `X-TB-Ctx` must name the context's device or the request is rejected.

**(c) Request-target integrity.** The AAD (`NONCE-DESIGN.md` §4:46) binds nothing about method, path or query, which D-7 keeps in plaintext. *Failure:* an on-path attacker re-routes a sealed `POST /api/sessions/A/input` (or `/cancel`, `/stop`, `/permission/answer`, `POST /api/cache/alert/resolve` with `prune_all`) to `/api/sessions/B/…`; the body authenticates and the server executes it against B. `design.md` §1.3:45 claims an active MITM "cannot inject input into a session" — it can redirect the user's own input into another of their sessions. *Fix:* for channels `0x02`/`0x03` the AAD appends `sha256(method ‖ "\n" ‖ path ‖ "\n" ‖ query)` (32 bytes; header stays fixed-width), or the target is repeated inside the sealed body and compared. Cheap, and it gives bodiless requests something to authenticate (M8).

### B3 — In-place rekey cannot be synchronised on the only channel that performs it

**Where.** `NONCE-DESIGN.md` §6:75 ("Triggers: 1 GiB sealed on the context, and the client's foreground rekey. Both sides rekey both cipher states together"), §6:81 (no epoch, no generation number), §8:109 (WS: "not applicable"), §8:122 (REST: keys replaced, counters continue); `design.md` §3.4:282-285 (REST is a sliding window because requests are concurrent); WIP `record.ts:318-327` (`rekey()`); `mobile-design.md` §4.3:149-150 (foreground rekey, and its rationale).

**Failure scenario.** (i) The server crosses 1 GiB sealed on a REST context (responses dominate — a day of conversation browsing) and replaces `k_s2c`; the client has no signal, unseals the next response under the old key and gets its own `E2EE_SEAL_FAILED` — which §9:142 defines as a *server-side fault* and X-client's brief gives no recovery for (only `E2EE_CTX_UNKNOWN` triggers the transparent re-handshake, `prompt.md:23`). The context is dead until the app is killed. (ii) The client foregrounds and replaces `k_c2s`; the server rejects its next request the same way; requests in flight at the switch race it in both directions. (iii) Even with explicit signalling, a receiver that accepts counters out of order cannot know which key generation a given counter was sealed under without an epoch — the field §6 forbids. Noise §11.3's rekey is safe because Noise transports are ordered; REST is the one channel here that is not, and ruling (b) made it the only one that rekeys. (iv) The foreground trigger's stated purpose — avoiding a handshake round trip at the app's slowest moment (`mobile-design.md` §4.3:150) — is already defeated by ruling (b): every foreground force-reconnects the socket (`app/session/[id].tsx:457-459` → `forceReconnect`), which is now a fresh `/open`.

**Fix.** Delete in-place rekey from the design and from `record.ts`: 24 h, 1 GiB and "foreground past threshold" all mean **open a new REST context, then retire the old one** (server: keep serving the old context for a short drain, then `E2EE_CTX_UNKNOWN`; client: single-flight the re-open, M6). The invariant becomes *a key is never replaced inside a context; a new key is a new context* — stronger than §6, needs no Noise precedent, and removes `rekey()`, `bytesSealed`, §12's rekey row and §6's cross-generation replay attack (there is no generation). Workspace `CLAUDE.md` §3 and `plan.md:49` ("the counter surviving a rekey is the rule to test hardest") are retired with a written reason, not left as a test obligation for a code path that no longer exists. If the user wants in-place rekey kept: add `epoch(1)` to the AAD and a two-key overlap rule on the REST receiver — but do not ship the current text.

---

## HIGH

### H1 — msg1 replay against `/open` allocates contexts that never expire

**Where.** `NONCE-DESIGN.md` §8:102-109 (WS context "Ends at: that socket's close"; "24 h wall clock: n/a — outlived by the socket"), §10:150-155 (no allocation bound, no rate limit); `design.md` §3.5:295-296; `auth.middleware.ts:23` (public POST); `server.ts:2020-2024` (`checkExchangeRateLimit` exists for `/pair/exchange` only).

**Failure scenario.** An `IK` msg1 carries no freshness (no PSK, no responder challenge). Anyone who captured one valid `/open` msg1 (ingress, LAN) replays it N times. Each replay passes "fail closed on the device row" — the static key *is* a known device — costs two DH and one AEAD, and allocates a context plus a ticket. The attacker never obtains keys (msg2 needs `D_priv`), so this is pure allocation: a socket context whose ticket is never consumed has **no end of life** in §8's table, a REST context lives 24 h, there is no per-device cap and no rate limit. This is the D-9 class — unauthenticated bytes driving allocation — on a new public endpoint. The same gap is hit benignly by M6's `forceReconnect` race and by two concurrent `CTX_UNKNOWN` recoveries after a streamer restart.

**Fix.** A context is *provisional* until its first authenticated use (ticket consumed, or one request unsealed) and dies with its ticket TTL (30 s) if unused; the msg2 payload's `expiresAt` for a socket context is that TTL. Cap live contexts per device (e.g. 4 sockets + 2 REST, evict oldest). Reuse `checkExchangeRateLimit` for `/open`. Add "replay one captured msg1 ×1000 → measured, bounded allocation" to the adversary's brief.

### H2 — Unauthenticated plaintext responses to sealed requests drive client state (401 → re-pair UI, 304 → stale, 426 → undefined)

**Where.** `services/authed-fetch.ts:146` (`401` → `AuthError` → the re-auth UI; compat contract `docs/compatibility/tb-mobile.md:100`); `services/api-client.ts:475-538` (conditional GET; a `304` keeps the cached copy as fresh); X-server `prompt.md:25` ("426 is plaintext"); X-client `prompt.md` — no rule for an unsealed response to a sealed request, no 426 handling; `mobile-design.md` §6.3 does not cover it.

**Failure scenario.** An on-path attacker answers a sealed request with a plaintext `401`: the app throws `AuthError` and shows "pair the device again" — a social-engineering downgrade (the next QR the user scans is the attacker's problem to arrange, but the app just told them to). A plaintext `304` freezes the conversation view on the cached copy — a rollback of what the user sees, on demand. A plaintext `426` cannot be told from a real pin refusal. None leaks content; all are authenticated-channel semantics decided by unauthenticated bytes, and `authedFetch` already implements the worst of them today.

**Fix.** X-client rule: on a sealed request, only a validly sealed response carries application semantics; any unsealed response is a *transport* failure (retry with backoff; never `AuthError`, never cache freshness, never "the server says re-pair"). Drop `If-None-Match` on sealed requests (or authenticate a bodiless 304 through a header tag, M8). A 426 to a request the client already sealed is a protocol error surfaced as "server/pin mismatch", never a downgrade. X-server: the plaintext 426 carries `{ error, code }` and nothing a client is expected to act on beyond that.

### H3 — Export compliance: every current build ships non-exempt crypto under `ITSAppUsesNonExemptEncryption: false`

**Where.** `plan.md:92` (`@stablelib` X25519/ChaCha20-Poly1305/SHA-256/HMAC in the bundle from build 204); `remaining-work.md:14` and STATUS "Outside every track" (reverted to `false` by #862 after App Store Connect rejected build 205); plan rev 2 table row `ITSAppUsesNonExemptEncryption`.

**Failure scenario.** The plan frames this as "the user's paperwork, gating any TestFlight build that carries E2EE" and R's stage-2 precondition. It is not a stage-2 problem: the algorithms are in every binary uploaded since build 204, whether or not the `e2ee` flag is on anywhere, and the declaration is knowingly false today. The exposure is a compliance finding against a shipped app, not a future gate; the BIS self-classification report (`plan.md:89`) is the same shape.

**Fix.** Not a code finding — the user's call. At minimum STATUS should say "current builds ship non-exempt crypto under a false declaration; the ANSSI → Apple approval is on the critical path for *any* release, not only an E2EE-enabled one", so the gate is read at the right moment.

### H4 — The sequence check runs before authentication, so `E2EE_SEQUENCE_VIOLATION` is an unauthenticated verdict about the peer

**Where.** WIP `record.ts:266-272` (counter compared to `expected` before the AEAD at `:276-292`); `NONCE-DESIGN.md` §5 R2:60 (log `e2ee.sequence_violation`, close), §9:141,144 ("a sequence violation is a **claim about the peer**").

**Failure scenario.** A party that can inject a frame (the ingress; anyone on the LAN leg with TCP access) sends a garbage frame with the socket's `ctxId` and any counter ≠ `expected` — both readable from the previous plaintext header. The server logs `e2ee.sequence_violation` naming the device and policy-closes the socket; the client, on the mirror image, closes and reconnects. The pre-auth check buys no DoS protection (the attacker knows `expected` and can just as cheaply send a 4 MiB frame with the right counter, which is authenticated anyway) and it misattributes an injection as peer misbehaviour — the code's frozen semantics are false in exactly the case the adversary will test. A genuine replay of a captured frame is rejected under either order; only the attribution differs.

**Fix.** Authenticate first (the nonce comes from the header either way), then compare the counter; R3 unchanged. If the order is kept for a reason, rewrite §9's semantics honestly ("a frame this socket could not accept in sequence, authenticated or not") and make the log line say so. Adversary row: "injected frame with a bad tag and a wrong counter — which code fired, and is the log line true?"

---

## MEDIUM

### M1 — `ctxId` derivation is underspecified and unnecessary; the `/open` payload and every wire encoding are unspecified

`design.md` §4.2:341 and `NONCE-DESIGN.md` §8:94 give `ctxId = HKDF(h_ss, "tb-e2ee-ctx-id", 16)` with no salt/info/IKM roles; the mobile has no HKDF library (`package.json:78-81` — `@stablelib/hkdf` from `mobile-design.md` §2:34 was never added) and its Noise HKDF is the three-output chained form (`services/e2ee/noise.ts:56-62`). The server already returns `ctxId` in msg2 (§8:105), so a client that derives it has a second source of truth to disagree with. Also unspecified, and each a silent interop failure: `ctxId` encoding in `X-TB-Ctx`, in JSON and in fixtures (hex / base64 / base64url); `X-TB-Seq` format (decimal `bigint`); `expiresAt` (present in `design.md` §8:509 `{ ctxId, expiresAt, ticket }`, absent in NONCE §8:105 `{ ctxId, ticket }`; ms vs s); ticket alphabet and length; WS frame opcode (binary — RN needs `binaryType`); header-name casing. *Fix:* `ctxId` is server-assigned (16 random bytes is fine; HKDF from `h_ss` is a server detail), delivered in msg2, never derived by the client; add a "Wire encodings" table to NONCE-DESIGN and pin every value in the fixtures.

### M2 — `readBody` buffers an unbounded body on a public endpoint; `/open` must not inherit it

`http-helpers.ts:165-179` concatenates every chunk before `JSON.parse`; `server.ts:2028` uses it for public `/api/pair/exchange`, so the base64 bound at `pair-request.ts:81` runs only after the whole body is in memory. Pre-existing D-9 gap on the exchange (P's file — coordinate; not W1a's diff). *Failure:* a multi-GB POST to a public path is fully buffered. *Fix:* W1a adds a bounded reader (`Content-Length` checked, read aborted at N KB) and uses it for `/open`; the exchange retrofit is a one-line follow-up.

### M3 — WS frames cannot be bounded before allocation through `@hono/node-ws`

`@hono/node-ws@1.3.1` hardcodes `new WebSocketServer({ noServer: true })` (`dist/index.js:37`) — `ws`'s default `maxPayload` is 100 MiB and `createNodeWebSocket({ app })` (`server.ts:957`) exposes no option. WIP `record.ts:67,241` bounds at 4 MiB **after** `ws` has already assembled the frame. `NONCE-DESIGN.md` §10 / D-9's "bound before anything is parsed or allocated" is therefore not achievable for the WS channel as wired. *Failure:* a keyless socket holder (a ticket thief, H1/L9) or any legacy `?key=` device pushes 100 MiB frames. *Fix:* say so in §10; W1b either replaces the hardcoded server construction (own `WebSocketServer({ noServer: true, maxPayload })` + `handleUpgrade`) or accepts the ceiling and reaps any socket that sends no valid sealed frame within N s.

### M4 — Revocation needs a per-device index over N + 1 contexts and unconsumed tickets, and the route has no reach

`design.md` §4.4:370 (revoke destroys every context and terminates sockets — a behaviour change to revocation); `NONCE-DESIGN.md` §8:127; `devices.routes.ts:17` (`Pick<ApiDeps, "devicesRepo">` — no hub, no registry); ruling (b) makes it N socket contexts + REST context(s) + tickets per device. *Failure:* revoke clears the row; live sockets keep streaming (the pre-existing bug §4.4 names) if the registry has no `deviceId` index or the route is not wired to it. *Fix:* registry API `destroyDevice(deviceId)` returning the sockets to terminate and dropping the device's tickets; the route gains the dependency; W1b's planned test (b) drives the real route, not the registry directly.

### M5 — Ruling (b)'s cost on the client: connect becomes async, and `forceReconnect` races two opens

`services/ws-client.ts:162-203` (`_doConnect` constructs the socket synchronously; the 15 s `connectTimer` covers the upgrade only), `:311-320` (`forceReconnect`), `app/session/[id].tsx:457-459` (foreground → `forceReconnect`), `hooks/useTerminalStream.ts:186-197` (45 s silence timer → `forceReconnect`). *Failure:* connect is now `POST /open → ticket → upgrade`; foreground and the silence timer fire `forceReconnect` within the same second, two `/open`s race, one context is orphaned (H1) and the `isCurrent` guard (`:190`) does not cover the fetch; the connect timer never starts for a hung `/open`. Cost: +1 RTT + 2 DH per reconnect at foreground. *Fix:* X-client's plan single-flights the open per server, generation-guards the whole `open → upgrade` sequence, and gives the open its own timeout; D2 measures foreground-to-first-frame with and without the extra handshake.

### M6 — The pin-loss path ends in an undiagnosable reconnect loop; the client has no 426 handling

#903's crash window leaves `serverPublicKey` set and `requireEncryption` absent (`stores/servers.ts:261-292`); the client then presents `?key=<deviceToken>` (`ws-client.ts:138`) and gets HTTP 426 at upgrade, which RN's `WebSocket` surfaces only as `onerror` → infinite backoff with a generic "disconnected"; REST gets a 426 the compat table (`tb-mobile.md:98-102`: 401/404/429) maps to nothing. *Fix:* X-client: 426 → a specific state ("this server requires encryption for this device") that re-sets the pin when `serverPublicKey` is present, never a downgrade; F3's #903 fix closes the window; accept that the upgrade refusal cannot carry a code to RN and rely on the REST 426 to diagnose.

### M7 — The frozen constant collapse (§4) edits `server.ts` and `misc.routes.ts` in the crypto PR

`src/server.ts:78` imports `E2EE_EXCHANGE_VERSION` (P's file under the wave-1 same-file rule), `pair-payload.ts:19` too; `misc.routes.ts:119` exports `E2EE_PROTOCOL_VERSION` and `cli/pair-banner.ts` reads it through `describeE2eeCapability`. The WIP `protocol.ts:23` is the right canonical home. *Failure:* deleting the old symbols widens W1a's diff into three modules another track may be editing. *Fix:* keep the old names as re-exports of `protocol.ts` (`export { E2EE_PROTOCOL_VERSION as E2EE_EXCHANGE_VERSION } from "../e2ee/protocol"`) with a deprecation comment and a test that the names are one value. Note the coupling this creates: the AAD version byte and the pairing `v` are now one number, and old clients gate pairing on `e2ee.version === E2EE_CLIENT_VERSION` (`types/api.ts:518`) — bumping the envelope refuses every v1 client at pairing. Intended or not, write it down.

### M8 — REST framing X-server has to invent: bodiless requests, streaming responses, multipart, `writeHead`

(i) RN `fetch` drops GET bodies, so a sealed GET has no record to carry: define a header form (`X-TB-Tag` = tag of the empty plaintext over the AAD from B2(c)), otherwise every GET is unauthenticated and never advances the window. (ii) `POST /api/sessions/:id/stop` streams ndjson (`sessions.handlers.ts:1807-1838`; the client reads it incrementally, `api-client.ts:438-472`) and `writeHonoResponse` streams (`http-helpers.ts:85-104`): a single-record envelope buffers "stopping" until "stopped" — define multi-record responses (each record bound to the request counter plus a record index) or exempt streaming endpoints explicitly. (iii) Uploads are multipart (`fs:upload`): the request record must carry the original `Content-Type` inside the envelope, or an intermediary rewrites it. (iv) `json()` (`http-helpers.ts:80-83`) calls `writeHead(status, headers)` then `end(body)`; `countResponseBytes` (`app.ts:66-83`) patches only `write`/`end` and counts — sealing must buffer, intercept `writeHead`/`setHeader`, and rewrite `Content-Type`/`Content-Length` at `end`. The brief's "prior art" is necessary, not sufficient.

### M9 — Hermes is never exercised before D2

Mobile unit tests run on Node (`jest-expo`); `bigint` → 8-byte big-endian encoding and `DataView.setBigUint64` availability in Hermes are unverified by any jest run (no BigInt/DataView use exists in the app today — grep is empty). *Failure:* a Hermes-only gap passes every test and fails on the phone at D2. *Fix:* X-client runs the record fixtures on-device before D2, reusing D-3's throwaway benchmark-screen method (`dilemmas.md:90`).

### M10 — The W1a adversary brief misses the attacks this review found

`tracks/W/prompt.md:45` lists nonce reuse, rollback, replay, truncation/oversize, `ctxId` confusion, reflection. Add: msg1 replay ×N against `/open` with allocation measured (H1); a ticket consumed by a second party before the client (L9); an injected frame with a wrong counter and a bad tag — which code, is the log line true (H4); `/open` with an unknown and with a revoked static key, allocation measured; two concurrent `/open`s for one device; a frame with the right `ctxId` on the wrong socket. For X-server later: response swap between two concurrent requests (B2a); a sealed `POST` re-routed to another session id (B2c); plaintext 401/304/426 injected to a sealed request (H2).

### M11 — Interop fixtures are positive-only

`NONCE-DESIGN.md` §13:228 lists keys, `ctxId`, direction, counter, AAD, plaintext, ciphertext. A client that only matches positive vectors can still accept a mutated AAD field, a reflected direction or a counter gap — the exact "correct output above a defect" shape `plan.md:45` warns about. *Fix:* add negative vectors (each AAD field mutated → must fail; wrong direction → must fail; counter gap → sequence violation) and the `/open` vectors from B1.

### M12 — `summarizeQuery` widening (W's point 3) is right; the ticket should also leave the URL

`app.ts:53-57`. The all-digit case is real but (10/64)^22 ≈ 10⁻¹⁸ for a 22-char base64url ticket — the fix is still correct because it protects `key` and every future secret parameter by rule rather than by alphabet. Risks of the widening are small: other tests asserting `qs` strings (W's `limit=50` control covers the shape), and `c.req.query()` returning first values only. Separately: a ticket in the URL lands in every ingress access log (Cloudflare logs full request URLs); single-use + 30 s bounds the damage, but RN's `WebSocket` accepts custom headers (`new WebSocket(url, null, { headers })`), so the ticket can travel in a header and never touch a log. Low cost now, expensive to change after X-client ships.

---

## LOW

- **L1** — `/api/e2ee/open` needs a `ROUTE_CAPABILITIES` entry (`capabilities.ts:105-146`) or `__tests__/capabilities.test.ts:199` ("every mounted route is classified") fails; classify like `/internal/sessions:145` (public bypass + a rule so a stray method is denied by rule).
- **L2** — Seal-and-send must be one synchronous step in W1b: any `await` between `seal` and `ws.send` (e.g. after `getOutputLines` at `server-wiring.ts:764`) reorders frames and the client's R2 closes the socket.
- **L3** — Ticket consumption must be a synchronous `Map` delete before any `await` in the upgrade path — the `PairTokenStore` lesson (`pair-store.ts:53-73`, `noise.ts:497-501`); W1b's race test (a) will catch it, the design should say it.
- **L4** — `record.ts:256-258` throws `E2EE_CTX_UNKNOWN` for a `ctxId` mismatch on a socket already bound to one context; the client's recovery (one re-handshake) is right, but the log line should not say "unknown" — it is a frame addressed to another context.
- **L5** — Frame bounds per direction: c2s frames are `register`/`subscribe_session`/`hold_session` (bytes); s2c `terminal_replay` is ≤ 1040 lines (`pty-shared.ts:19,21`). State a c2s ceiling (64 KiB) and an s2c ceiling separately; the client bounds s2c, the server c2s.
- **L6** — `record.ts:194-199` refuses at `2^64−1` and leaves the state unchanged; §7 should say the caller must then destroy the context (with B3, that is the only outcome), and §14 should also correct `design.md` §3.3:264 ("refuses to send and forces a rekey").
- **L7** — Re-open storms: after a streamer restart every pinned device's next request is `E2EE_CTX_UNKNOWN`; the client must single-flight its re-open per server (two concurrent React Query requests → two handshakes → one orphan, H1) and the registry must tolerate two REST contexts per device transiently — define which one wins.
- **L8** — Retries must re-seal from plaintext: `api-client.ts:279-300` retries with a new timeout; a retry that re-sends cached sealed bytes replays a counter the window already accepted. `authedFetch` sealing per call gets this right by construction — write the rule so a future "reuse the encoded body" optimisation cannot break it.
- **L9** — Ticket theft at the ingress: an intermediary that consumes the client's ticket first holds a socket bound to a context whose keys it lacks — no plaintext, but a hub slot receiving sealed broadcasts and the legitimate client's upgrade fails (it re-opens; repeatable DoS, which an ingress can do anyway). Reap sockets that send no valid frame within N s; the header-carried ticket (M12) removes the log-tailing variant.
- **L10** — `NONCE-DESIGN.md` §8:105's `/open` result omits `expiresAt` that `design.md` §8:509 and W's `prompt.md:30` include; with H1 it becomes load-bearing (socket context TTL = ticket TTL).
- **L11** — Design.md §1.3:45 ("cannot inject input into a session") and §3.4:285 should be corrected in §14 alongside §4.3, once B2(a)/(c) are decided — the same "docs that carry status" failure §14 exists to prevent.
- **L12** — App-level `{ type: "ping" }` frames (`types.ts:339`) are sealed like any frame and consume counters (fine); WS protocol pings are invisible to RN JS, so the client's 45 s silence timer (`useTerminalStream.ts:25`) still depends on app frames — unchanged by W1b, worth one sentence so nobody "optimises" the app ping away.

---

## NOTE

- **N1 — D-8 vs §6.5 (R2 escalation).** `THREADBASE_FEATURE_E2EE=1` is the *documented enable path* for stage 1 (`misc.routes.ts:178-179` tells operators to set it), so option 1 ("exempt `e2ee` from the env rung") breaks stage 1. The collision is only about *disabling* at stage 2, and D-8's "no env var" rule cannot be enforced for a registry entry without special-casing the registry. Recommendation for the user: option 3 — at stage 2 treat flag-off from *any* source exactly like `--no-e2ee` (boot warning naming the pinned-device count, `e2ee.disabled` at warn, `/api/info` `reason` naming the source: env / `--feature` / `server.yaml` / `--no-e2ee`); the friction D-8 wanted comes from the warning and the 426s, not from hiding the switch. Then `--no-e2ee` is sugar for `--feature e2ee=false` and R1 may not need to exist as a separate flag at all.
- **N2 — Stage 3** as a product decision with an app-version floor: no finding.
- **N3 — NO-GO drift.** The owner's 20:00 re-interpretation (the NO-GO now binds the stage-2 default and stage 3, since `E2EE_SUPPORTED` merged in #674 without evidence) is the only sane reading; D1 producing #674's evidence after the fact is the right repair.
- **N4 — Old-client compatibility.** Nothing in NONCE-DESIGN or the WIP changes a released path: `?key=` and `Authorization: Bearer` stay live for unpinned devices, no field renamed, no event string changed. No finding. One residual, by design: a pinned device's *shared* API key (`tb_…`) presented via `?key=` resolves to `legacyPrincipal()` with no device row (`auth.middleware.ts:86-87`), so the pin cannot bite there — the shared key is the stage-3 problem `design.md` §2.6:203 already names.
- **N5 — Merged PRs #739, #740, #900–#902** read for regressions: none found. #740's non-OPEN-socket behaviour change is correctly disclosed; #902's `bad-server-key` (non-retryable) over `e2ee-malformed` (retryable) is the right call.
- **N6 — Group P / Group M closures**: the audit method (mutation that stays green = the defect) is the right bar; no finding on the closures themselves. #903–#906 triage agrees with F's brief.
- **N7 — The 30 s ticket / 15 s connect timer interaction** is fine as long as every attempt gets a fresh open (M5); a reused ticket after a black-holed attempt would be a gamble on whether the upgrade was ever received.
- **N8 — Metadata.** `ctxId` in the clear links a device's REST requests for up to 24 h and its socket for its life — within §3.2's accepted residual; stated so nobody later calls it a leak.
- **N9 — W's points (1)–(4)**, answered in place: (1) §6 — correct, and moot under B3; (2) §8 — endorsed, resync rejected, two consequences (H1, M5) to add; (3) §10 — keep, plus M12's header suggestion; (4) §4 — re-export, don't move (M7).

---

## Explicit "no finding" sections

- **Nonce construction, AAD layout, R1–R4, `bigint`, big-endian vs the handshake's little-endian, the 2^64−1 refusal** (`NONCE-DESIGN.md` §2–§5, §7): no finding. The WIP `record.ts` matches them byte for byte; `recordNonce`/`recordAad` offsets (`:88-93`, `:112-123`) are correct; Node's `chacha20-poly1305` usage (`authTagLength`, `setAAD` with `plaintextLength`, `getAuthTag`) is correct; `rekey()`'s REKEY derivation (`:318-327`) is a faithful Noise §11.3 — it is simply not needed (B3).
- **Frozen codes** (§9): the four strings and their split are right; only H4's attribution and L4's wording are affected.
- **The pairing contract on `origin/main`** (streamer #630/#649/#739, mobile #768/#900–#902): no new finding beyond #903–#906.
- **W0 (#740)**: no finding; the regex scanner's ceiling is honestly stated.
- **STATUS.md / decisions log / briefs**: consistent with each other and with `origin/main`; the only inconsistencies are the three-way REST credential contradiction (B2b) and the `expiresAt` omission (L10), both already listed.

---

## Verifier additions (for `record-layer-adversary`, W1a and W1b)

Each as `rejected: <evidence>` / `succeeded: <finding>` / `not attempted: <reason>`:

1. Replay one captured `/open` msg1 ×1000 — count live contexts and tickets, measure heap; expect a bound (H1).
2. `/open` with an unknown static key and with a revoked one — expect refusal before any context or ticket exists; measure.
3. Consume a ticket from a second connection before the client — expect the client's upgrade refused, the thief's socket reaped within N s, and no plaintext frame ever on it (L9).
4. Inject a frame with the socket's `ctxId`, a wrong counter and a bad tag — record which code fired and whether the log blames the device (H4).
5. Two concurrent `/open`s for one device, then use only the second — expect the first to expire (H1).
6. A frame with the right `ctxId` on another device's socket; a REST record (`channel 0x02`) delivered as a WS frame — expect rejection before the AEAD by channel/context, and say which check.
7. Reflection, rollback, truncated/oversized, ctxId confusion — as briefed.
8. (W1b) Seal-then-await-then-send reorder under a slow `getOutputLines` — expect no client-side sequence violation (L2).

---

## Two-implementation traps (answer to request §5, bullet 4)

Things Node `crypto` and `@stablelib` in Hermes can read differently, each of which passes a positive fixture and fails on the wire:

| Trap | Where it bites | Pin it by |
|---|---|---|
| `/open` pattern name, prologue bytes, PSK presence | B1 | one sentence + vectors |
| `ctxId` derivation and encoding (hex/base64/base64url) | M1 | server-assigned, encoding table |
| `bigint` → 8-byte BE in Hermes (`DataView.setBigUint64` availability) | M9 | on-device fixture run |
| AAD `counter` vs nonce `counter` on REST responses (request echo vs own) | B2(a) | one rule, one class |
| `X-TB-Seq` as decimal string of a `bigint`; header casing | M1 | encoding table |
| Frame opcode (binary) and RN `binaryType` | M1 | stated |
| `expiresAt` units, ticket alphabet/length | L10 | stated |
| Bodiless GET framing / tag-in-header | M8 | stated |
| "no sealed response for a rejected request" | B2(a) | stated + tested |
| Retry re-seals from plaintext, never re-sends | L8 | stated |
| Negative vectors (mutated AAD, reflected direction, gap) | M11 | committed |

---

## What this review did not do

No code was executed and no test was run (read-only under the HOLD). The Hermes `DataView`/BigInt claim in M9 is from memory and is itself a to-verify item, which is the point of M9. `@hono/node-ws`'s hardcoded `WebSocketServer` options were read from the installed `1.3.1` in the implementer's `node_modules`, not from the package's source repository.
