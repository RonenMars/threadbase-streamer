# The record layer's nonce and counter rules

**Status:** design of record for Phase 3. Written before the implementation, and the document the isolated verifier reads first.
**Scope:** the WebSocket record layer — `src/e2ee/record.ts` and `src/e2ee/context.ts`.
**Not in scope:** the Noise handshake's own nonce (§11), the REST sliding window ([design.md §3.4](./design.md)), `--no-e2ee`.

This file exists because a subtly wrong nonce or counter scheme passes casual review and every green test suite.
Every rule below is stated so that breaking it breaks a named test, and §12 lists the mutation for each.

---

## 1. Primitive

ChaCha20-Poly1305 (RFC 8439) through Node's `crypto.createCipheriv("chacha20-poly1305", …)`: 256-bit key, 96-bit nonce, 128-bit tag.
No new dependency, and the same primitive the Noise suite already uses ([design.md §3.3](./design.md)).

## 2. Nonce

```
nonce[12] = direction[4] || counter[8]        big-endian

direction  0x00000001   client → server
           0x00000002   server → client
counter    starts at 0, +1 per successfully sealed record
```

**Never random.** A counter makes nonce reuse an invariant a test asserts on rather than a birthday bound argued about in review ([D-2](./dilemmas.md#d-2--aead-and-nonce-discipline-counter-chacha20-poly1305-vs-random-nonce-xchacha20)).

Each direction has **its own key and its own direction label**, so a record can never be reflected back at its sender: a server→client record fed back to the server is decrypted with the wrong key *and* carries the wrong direction in its AAD.

**Big-endian, and deliberately not the handshake's encoding.** Noise's ChaChaPoly nonce is 4 zero bytes then an 8-byte **little-endian** counter (spec §12.3), implemented in `chachaNonce` in `src/e2ee/noise.ts`.
Two layers, two encodings, both correct for their own specification.
Do not reuse the handshake's helper and do not unify them.

## 3. Counter type

**`bigint` on the server.** Not an inheritance from the handshake — a decision.

The handshake's counter is a `bigint` and the client's is a `number`. That divergence is harmless at handshake volumes (two messages) and is not harmless at record volumes, where a `number` silently loses integer precision above 2^53.

**The client's obligation, stated normatively because the client is a separate implementation:** a `bigint`, or a two-`number` representation that **throws** above 2^53. Never one that wraps or rounds.

## 4. AAD

```
AAD[30] = version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)

version   E2EE_PROTOCOL_VERSION (currently 1)
channel   0x01 websocket   0x02 rest-request   0x03 rest-response
```

The header travels in the clear and is authenticated, so an intermediary can neither rewrite a sequence number nor re-point a record at another context.

**On channels `0x02` and `0x03` the AAD gains a 32-byte suffix** binding the request target, so the header stays fixed-width:

```
AAD[62] = version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)
          || sha256( method || "\n" || path || "\n" || query )
```

Paths and query stay plaintext ([D-7](./dilemmas.md)), so nothing in the AAD binds *what a sealed body is for*. Without this suffix an on-path attacker re-routes a sealed `POST /api/sessions/A/input` to `/api/sessions/B/input`: the body authenticates and the server runs the user's own keystrokes against a different session. The same applies to `/cancel`, `/stop`, `/permission/answer`, and `POST /api/cache/alert/resolve` with `prune_all`.

It also gives a bodiless request something to authenticate, which is what makes a sealed `GET` possible at all (§13).

**The exact bytes hashed are pinned, because this is the `ctxId`-encoding trap one layer down.** Both sides must reproduce the same string or every affected request fails to authenticate — a legitimate request, rejected, with only `E2EE_SEAL_FAILED` to debug it:

| Component | Exactly |
|---|---|
| `method` | **upper-case** ASCII, as sent |
| `path` | the **raw** request-target path — percent-encoding preserved, never decoded, never normalised |
| `query` | the **raw** substring after `?`, verbatim: original parameter order, original `+` vs `%20`, duplicates kept, no trailing `&` added or removed. Empty string when there is no `?`. |

The server reads these from the **raw wire URL** (`c.env.incoming.url`) and **never** from Hono's `c.req.path`, which is percent-decoded, nor from a re-serialised parse of the query, whose ordering and escaping are not guaranteed to round-trip.

**The client hashes the same origin-form target — the path and query as they appear on the request line, never the absolute URL it is about to fetch.** `POST\n/api/conversations/a%2Fb\nlimit=50` and not `POST\nhttps://host/api/conversations/a%2Fb\nlimit=50`. A client that hashes the absolute URL fails every sealed request with nothing but `E2EE_SEAL_FAILED` to debug, which is this section's own trap arriving through a sentence rather than through code. The committed fixture is the authority; prose that disagrees with it is wrong. `/api/conversations/a%2Fb` and `/api/conversations/a/b` are different targets and must hash differently.

A fixture vector pins it: a path containing `%2F` and a query with two parameters in a non-alphabetical order (§16).

`version` reuses **`E2EE_PROTOCOL_VERSION`**. The canonical home is a new `src/e2ee/protocol.ts`; `misc.routes.ts` and `pair-request.ts` keep their existing names as **re-exports** with a deprecation comment, and a test asserts the names are one value. They are not deleted: `src/server.ts` and `src/e2ee/pair-payload.ts` import `E2EE_EXCHANGE_VERSION` and another track is editing `server.ts`, so removing the symbol would widen this diff into files W1a does not own.

**Write down the coupling this creates:** the AAD version byte and the pairing QR's `v` are now one number, and released clients gate pairing on `e2ee.version === E2EE_CLIENT_VERSION`. Bumping the envelope version therefore refuses every v1 client at pairing. That may be intended; it must not be discovered.

## 5. The counter state machine

**R1 — the sender increments by exactly 1, after a successful seal.** Never before.

**R2 — the WebSocket receiver requires `counter == expected` exactly.** No window. A WebSocket runs over one TCP connection, so it is ordered and gap-free by construction; a repeat, a gap or a reorder is a protocol violation, not a network event. Log `e2ee.sequence_violation` and close the socket with reason `E2EE_SEQUENCE_VIOLATION`. This makes replay structurally impossible on the highest-volume channel with no bookkeeping at all.

**R2 ordering — authenticate first, then compare the counter.** The nonce is built from the header either way, so the AEAD can run before the sequence check, and it must. Checking the counter first makes `E2EE_SEQUENCE_VIOLATION` an *unauthenticated verdict about the peer*: anyone who can inject a frame reads `ctxId` and the counter from the previous plaintext header, sends garbage with a wrong counter, and the server logs a sequence violation naming the device and closes the socket. The pre-auth check buys no DoS protection — the same attacker can as cheaply send a large frame with the *right* counter, which is authenticated anyway — and it makes §9's frozen semantics false in exactly the case an adversary will test. A genuine replay is rejected under either order; only the attribution differs.

**R3 — a rejected frame advances neither counter.** Spec §5.1, and the rule `CipherState.decryptWithAd` in `src/e2ee/noise.ts` already honours. Getting it wrong desynchronises the two sides and every subsequent frame then fails for a reason that points at the wrong place.

**R4 — the counter is owned by the record state and is never passed in by a caller.** A `seal(ctx, counter, plaintext)` signature makes every caller a place the invariant can be broken; `seal(plaintext)` makes it one place.

One narrow exception, stated here so the verifier does not read it as a violation: the §7 exhaustion test has to place a counter near `2^64 - 1`, which it cannot do a frame at a time. `createRecordState({ initialCounter })` takes a **construction-time seed**, marked internal and used only by tests. That is not the forbidden shape — the seed sets a starting point once, at construction, while `seal` and `unseal` still take no counter and remain the sole advancers. A `seal(counter, …)` signature stays forbidden.

**One further sanctioned shape, for REST responses only.** `RestResponseSealer.seal(requestCounter, plaintext)` seals a response under the counter of the request it answers. R4 governs *sequence* counters — a value the sender chooses and advances — and a response echo is not one: the value is dictated by the request that was already accepted. It is a distinct class from `RecordState`, so a caller cannot reach a sequence counter through it. The rules that make it safe are in §13.

## 6. Key replacement — **RULED by the user, 2026-08-29**

> **A key is never replaced inside a context. A new key is a new context.**

and, unchanged and independent of it:

> **One counter value, once, per direction, per context.**

There is **no in-place rekey anywhere.** 24 h, 1 GiB sealed, and "foreground past threshold" all mean the same thing: **open a new REST context, then retire the old one.** The server keeps serving the old context for a short drain and then answers `E2EE_CTX_UNKNOWN`; the client single-flights the re-open (§8). WebSocket contexts never reach any of these bounds, because a socket's life is shorter than all of them.

### Why, since this retires a written guardrail

In-place rekey **cannot be synchronised on the only channel that would ever perform it.** WebSocket contexts are per-socket (§8) and never rekey, which leaves REST — and REST uses a sliding window precisely because the client issues concurrent requests. A receiver that accepts counters out of order cannot know which key generation a given counter was sealed under without an `epoch` field, which the nonce layout has no room for and the invariant above forbids.

Concretely, the failure it avoids: the server crosses 1 GiB on a REST context — responses dominate, so a day of browsing does it — and replaces `k_s2c`. The client has no signal. It unseals the next response under the old key and raises `E2EE_SEAL_FAILED`, which §9 defines as a *server-side* fault with no client recovery path, and the context stays dead until the app restarts. The mirror case happens on the client's side, and requests in flight race the switch in both directions.

Noise §11.3's rekey is safe because Noise transports are ordered. REST is not, and §8 made REST the only channel that would rekey.

### What this retires, and what replaces it

Workspace `CLAUDE.md` §3 and `plan.md` both say *"the counter surviving a rekey is the rule tested hardest"*. **That rule is retired**, by the user's decision on 2026-08-29, because no code path rekeys any more and a test obligation for a nonexistent path is worse than none — it invites someone to re-add the path to satisfy the test.

The rule that replaces it, and inherits "tested hardest", is the pair at the top of this section. The clean-up that follows:

- `rekey()`, `bytesSealed`, `rekeyDue()` and the byte-count trigger are **removed** from `record.ts` and `context.ts`.
- §15 carries no rekey row, and the cross-generation replay attack disappears with it — there is no generation to cross.
- The rekey interop vector is removed from §16.
- `design.md` §3.3's "forces a rekey" and §4.3's rekey sentence are corrected (§17).

This is strictly simpler than what it replaces: it needs no Noise precedent, no epoch, and no two-key overlap rule.

## 7. Exhaustion

A sender that would exceed `2^64 - 1` **refuses to send**. It does not wrap.
Unreachable in practice — at the D-3 measured budget of ~1.6 MB/s it is on the order of 10^11 years — and asserted precisely so it can never become a silent wrap.

The refusal leaves the state unchanged, so **the caller must then destroy the context**; there is no recovery that keeps it. `design.md` §3.3's "refuses to send and forces a rekey" is corrected accordingly (§17) — under Alternative B there is no rekey to force, and under either alternative the context is finished.

## 8. Context lifecycle

`ctxId` is **server-assigned: 16 random bytes, delivered in msg2, never derived by the client** (§12). Deriving it from the transcript hash was the earlier design and is abolished — besides needing a client HKDF of a shape the client does not have, it is circular, because the final transcript hash is computed *over* the msg2 payload that would have to carry the result.

Contexts are **in-memory only**. They do not survive a streamer restart, which is what stops an old capture from ever being replayed into a new run.

### A context is bound to one channel instance, not to the device

Each paired device holds **two** contexts, one IK handshake each.

| | WebSocket context | REST context |
|---|---|---|
| Scope | exactly one socket | one device, long-lived |
| Opened by | `POST /api/e2ee/open` → `{ ctxId, ticket }` → `GET /ws?ticket=` | `POST /api/e2ee/open`, **opened with its first request in hand** |
| `channel` byte | `0x01` | `0x02` request, `0x03` response |
| Receive state | strict `expected`, no window (§5 R2) | sliding window, populated by the REST track |
| Ends at | that socket's close — **no grace window** | 24 h, or revocation, or restart |
| Key replacement | not applicable — the socket's life is shorter than any bound | 1 GiB / 24 h / foreground → **open a new context and retire the old** (§6). There is no in-place rekey. |

`context.ts` therefore keys receive state by **(context, channel)** rather than by context alone.

**Why not one context per device.** Two reasons, and the second is the one that would have shipped a bug:

1. **REST needs a context while the socket is down.** `X-TB-Ctx` carries a `ctxId` on every sealed request ([design.md §3.6](./design.md)), and the 2 s HTTP replay fallback ([mobile-design.md §4.3](./mobile-design.md)) runs *exactly* when the socket is unavailable. A context that dies with the socket takes the fallback down with it.
2. **A shared context would sequence-violate itself into a close loop.** Frames in flight when a socket drops are lost. Under R2 the first frame after a reconnect is then a gap, so the client closes, reconnects, gaps again, and never recovers — a strict counter is only safe across a channel that cannot lose frames, which is one TCP connection and not a sequence of them.

**A reconnect opens a new context, and that is not a counter reset.** New `ctxId`, new keys, counters legitimately at 0 — a different context, not a rewound one. §6's invariant is untouched: it scopes uniqueness *per context*. The single-use 30-second ticket already implied this, since a fresh ticket only ever comes out of a fresh `/api/e2ee/open`.

| Event | WebSocket context | REST context |
|---|---|---|
| Opened, never used | **destroyed at the ticket TTL (30 s)** — see below | destroyed at the ticket TTL |
| Key replacement | n/a | never in place — a new key is a new context (§6) |
| 24 h wall clock | n/a — outlived by the socket | **destroyed**; client re-opens |
| Socket close | **destroyed**, no grace window | unaffected |
| Socket reconnect | a **new** context via a new open | reused |
| Streamer restart | destroyed | destroyed |
| Device revoked | destroyed, live sockets terminated | destroyed |

### A context is provisional until it is used

**Why this rule exists.** An `IK` msg1 carries no freshness — no PSK, no responder challenge — so anyone who captured one valid `/open` msg1 can replay it. Each replay passes "fail closed on the device row", because the static key genuinely *is* a known device; it costs two DH and one AEAD and allocates a context and a ticket. The attacker never obtains keys, since msg2 needs `D_priv`. **This is pure allocation** — the D-9 class, unauthenticated bytes driving allocation, on a new public endpoint — and without this rule a socket context whose ticket is never consumed has no end of life at all.

- A context is **provisional** until its first authenticated use: its ticket is consumed, or one request unseals under it.
- **Never open a REST context "lazily" in advance.** A provisional context is collected at the ticket TTL, so a client that warms one on foreground and sends its first real request a minute later finds it gone and eats a spurious re-handshake at the app's slowest moment — the exact round trip `mobile-design.md` §4.3 set out to avoid. Open it **with the request already in hand.**
- **The advertised deadline must be the deadline that applies.** msg2 carries the provisional deadline while the context is provisional, and the full lifetime only once it is used — never a 24 h `expiresAt` on a context that will actually be collected in 30 s. See §12 for the field.
- A provisional context **dies with its ticket TTL, 30 s.** `expiresAt` in the msg2 payload is that TTL for a socket context.
- **Sweep on open.** Expired and drained-out contexts must be removed from the registry by the *open* path, before the cap is applied — not only when someone looks one up by id. A replayed msg1 creates contexts **nobody will ever look up**, so a lookup-triggered sweep never runs on exactly the contexts an attacker manufactures, and the cap retires them without freeing them. Tickets are swept on the same path. Anything that allocates must also be a place that collects.
- **Cap live contexts per device** — 4 socket + 2 REST. **Eviction is by usefulness, not by age**: destroy provisional/unused contexts first, and only then the oldest live one. Evicting strictly by `createdAt` picks the actively-used context and keeps two unused ones in exactly the ordering that matters.
- **The context being opened is never an eviction candidate.** It is provisional by definition, so a naive "provisional first" ordering sorts it to the front of its own queue and the open evicts itself: a device holding four live sockets then gets a fifth that dies at the drain deadline, and can never open a usable one. Exclude the new context, then apply the ordering to the rest. A test that only opens *unused* contexts stays green through this bug, which is why the fixture for it must hold the oldest context **in use**.
- **Eviction honours the drain.** An evicted context is marked for deletion at `now + drainMs` and swept later, not destroyed the instant its replacement registers — otherwise a request in flight on it dies mid-transaction, which is the opposite of the "short drain" §6 promises. If a future change makes immediate destruction the real decision, §6 and this section must be corrected to say so; the code and the prose do not get to disagree.
- `/open` is rate-limited under the **same policy** as `/pair/exchange` (5/min), through a shared module rather than by reusing `checkExchangeRateLimit` itself — that is a private method over private per-map state inside `server.ts`, and lifting it would mean rewiring three call sites in a file another track owns. Sharing the policy and not the arithmetic is the right trade; consolidating them is a named follow-up.
- **Key the limiter on the authenticated device once the handshake has run**, and only on the source address for a handshake that failed and therefore names nobody. This is what keeps one device from exhausting the bucket for the whole fleet behind a tunnel.
- **The IP bucket must be consulted before the handshake, not merely charged after it.** A bucket that is charged and never checked bounds nothing, and a comment claiming otherwise is worse than no comment — it stops the next reader looking. The rule: a **failure** bucket keyed by source address, **checked before `readMessage1`** (`if (!failures.check(ip)) return 429`) and **charged only when the handshake fails**, so a legitimate device never spends it. Without the pre-check, unlimited garbage msg1s from one source each cost two DH — the D-9 CPU case, on a public endpoint.
- **A well-formed msg1 from an unknown key charges the failure bucket too.** The server's static public key is what pairing distributes, so anyone can mint unlimited *valid* msg1s from fresh keypairs; if only malformed ones are charged, the flood that actually costs Diffie-Hellman is precisely the one that never trips the limit. A refusal at the device lookup is still a failure from that source.
- **Two budgets, two purposes:** a source-address **failure** budget at **30/min**, set well above anything a real device does and below what a flood needs, and the per-device **allocation** limit at **5/min**. Sizing them the same way conflates a CPU bound with an allocation bound and gets both wrong.
- **A replayed msg1 is caught before any Diffie-Hellman, by its ephemeral.** In Noise `IK` the client's `e` travels in the clear at a fixed offset, and a legitimate client generates a fresh one per handshake — so **a repeated `e` is definitionally a replay** and is rejected before `readMessage1` runs, answered `E2EE_HANDSHAKE_FAILED` and charged to the **source** budget.

  **Never charge a replay to the device.** A replayed msg1 authenticates *as the victim*, so charging the device turns "key the limiter on the authenticated device" into a targeted lockout: five replays of one captured message spend that device's whole minute and push it past its context cap, while every other device is unaffected. The rule that bounds allocation becomes the weapon if the wrong party is billed.

  Bounded, **insertion-ordered** (never refreshed on a hit — a hit *is* a replay, and refreshing would let an attacker pin a slot with traffic already being rejected) on the 32-byte `e`, capacity 65 536, entries living for the REST context TTL or until evicted.

  **Record only after the device row has been checked, not merely after the handshake.** A well-formed msg1 from a keypair the server has never seen still completes `readMessage1`, so recording before the device lookup lets **unauthenticated traffic drive the eviction clock**: at the permitted rate one source contributes tens of thousands of entries a day, and the entries evicted first are the oldest — which is where a captured victim's msg1 lives. That reaches the accepted floor sooner and more often than the TTL should allow. Recording below the device check costs the replay defence nothing, because a stranger's msg1 is refused by the device row anyway.

  **A retry must re-run `writeMessage1`, never re-send the same bytes.** A client that re-sends an identical msg1 after a lost response, a timeout or a `429` is indistinguishable from a replay and is refused for the life of the cache entry. This is the same rule §14 already states for records — a retry re-seals from plaintext — and it is a **client obligation that must be written into the contract**, because the failure is silent, durable, and looks like a server fault.

  **Residual, stated rather than implied closed.** Because only device-authenticated msg1s are recorded, one permitted device contributes about **7 200 entries a day**, so roughly **ten** sustained paired devices are needed to turn a 65 536-entry cache. The floor is therefore *further away* than a per-source reading suggests — that figure describes the discarded design where a stranger's msg1 could record, and it must not be "corrected" back.

  **The refusal is byte-identical to other handshake failures, but the clock is not.** A replay returns *before* `readMessage1`, so it costs no Diffie-Hellman while every other refusal costs at least one — a timing oracle answering "is my captured msg1 still cached?", i.e. when this floor opens. Accepted rather than closed, because the floor it reveals is already bounded and documented here; recorded so it is a known property rather than an unstated gap.

  A capture replayed after eviction or past the TTL still costs one DH pair and one per-device slot per attempt. That is bounded by the two budgets, and a one-minute per-device lockout per five such replays is the accepted floor. The real cure is client freshness — an `IK` payload nonce bound into the transcript — which is a protocol change for a later version, not this one.
- Behind a tunnel that failure bucket is one bucket for everyone. That is the **same exposure `/pair/exchange` already carries**, and it is stated rather than papered over; the per-device cap remains the real bound on allocation.
- **The failure bucket is a fleet-wide gate, not merely an attacker's ceiling.** It is checked on *every* `/open`, so behind a shared-IP tunnel — where the streamer cannot distinguish sources and reads no forwarded-IP header — 30 malformed msg1s from anywhere on the internet deny `/open` to **every paired device behind that tunnel** — and because a refused request is never charged, sustaining roughly one request every two seconds holds the bucket full **indefinitely**. It is a fleet-wide outage for as long as the flood lasts, not "for a minute", and replaying one captured msg1 does it at **zero** server Diffie-Hellman cost. Saying "the per-device cap remains the real bound" understates it, and this sentence replaces that one.
  The control is operator-side — Cloudflare rate limiting or Access — and it belongs in the rollout guide rather than in a `429` we pretend is adequate.
- **The 5-per-minute figure is a tunable, not a constant of nature.** A device on a flaky network can legitimately want three `/open`s in a burst — foreground, silence-timer, and REST — so the margin is thin and depends on the client single-flighting its re-opens. If field evidence shows legitimate devices hitting it, raise it; do not conclude the client is misbehaving.

**The per-device cap is the real bound, and the rate limit largely is not.** The limiter keys on the socket's `remoteAddress`, and behind a Cloudflare tunnel every request arrives from `127.0.0.1` — the streamer reads no forwarded-IP header — so it degrades to **one global bucket for the whole fleet**. That has two consequences worth writing down rather than discovering: it cannot distinguish an attacker from the fleet, so it must not be cited as the defence against msg1 replay; and it is a **self-DoS on the recovery path this very section describes**, since after a restart each device re-opens twice (socket + REST) and three devices behind one tunnel exceed a 5/min bucket, `429`-ing legitimate devices out of their own recovery until the window rolls.

Treat the per-IP limit as effective on the LAN leg only. Either rate-limit per authenticated device *after* the handshake — which already proves a paired device — or honour a configured forwarded-IP header where the deployment sets one.

The same path is reached benignly, which is why the bound must be a rule and not a rate limiter alone: two concurrent `E2EE_CTX_UNKNOWN` recoveries after a streamer restart, or a client foreground and a silence-timer reconnect firing together, both produce a second `/open` whose context is orphaned.

**Re-open storms.** After a streamer restart, every pinned device's next request is `E2EE_CTX_UNKNOWN` at once. The client **single-flights its re-open per server** — two concurrent requests must not become two handshakes — and the registry tolerates two REST contexts for one device transiently. **The newer wins**; the older is retired at its provisional TTL if it was never used, or on the drain otherwise.

### Revocation needs a per-device index

`POST /api/devices/:id/revoke` must destroy **every** context for the device and terminate its sockets, which under this model is N socket contexts plus its REST context(s) plus any unconsumed tickets. The registry therefore exposes `destroyDevice(deviceId)`, returning the sockets to terminate and dropping that device's tickets. W1a ships the registry API; W1b wires the route to it, and W1b's revocation test drives the **real route**, not the registry directly — the route currently has no reach into either the hub or the registry, and that gap is the pre-existing bug `design.md` §4.4 names.

A phone that backgrounds and returns keeps its REST context and opens a new socket context. The session it was watching is untouched — nothing about session lifetime changes.

**This supersedes [design.md §4.3](./design.md)** on two further points beyond §6's counter sentence: the transport context does **not** "follow the socket" as a single device-wide object, and there is **no grace window** on close. The W1a PR corrects both sentences in place, and corrects [mobile-design.md §4.3](./mobile-design.md)'s reconnect row to "reuse the REST context; open a new socket context with a fresh ticket".

## 9. Rejection codes — frozen at W1a's tag

Four strings. X-server and X-client consume them; nothing renames them afterwards without a coordinated change in both repos.

| Code | Meaning | Client's correct response |
|---|---|---|
| `E2EE_CTX_UNKNOWN` | `ctxId` unknown, expired, or lost to a streamer restart | **Recoverable.** One transparent re-handshake, then retry. |
| `E2EE_DEVICE_REVOKED` | the device's row is missing or `revoked_at` is set | **Hard failure.** Surface it. Never retry. |
| `E2EE_SEQUENCE_VIOLATION` | an **authenticated** frame whose counter was not `expected` — repeat, gap or reorder | Close reason on the socket, so the client can tell a policy close from a network drop. |
| `E2EE_SEAL_FAILED` | the server could not seal or unseal a frame it should have been able to | Distinct from a sequence violation on purpose. |

**Why `E2EE_SEAL_FAILED` is its own code.** A seal failure is a **server-side fault**; a sequence violation is a **claim about the peer**. Collapsing them would tell the client its own frames were wrong when the server was at fault, and two failures behind one code was a P1 in the prior program.

The same reasoning separates the first two rows: *"absent"* and *"invalid"* are different answers, and a restart the client can silently recover from must never look like a revocation it must surface.

**`E2EE_SEQUENCE_VIOLATION` means what it says only because of §5's ordering rule.** The AEAD runs first, so by the time this code is reached the frame is proven to come from the peer, and "a claim about the peer" is true. Were the counter checked first, the same code would fire on any injected garbage and the log line would blame a device that did nothing.

**`E2EE_CTX_UNKNOWN`'s log line must not say "unknown" for a frame addressed to a different live context.** A socket bound to one context that receives a frame carrying another `ctxId` is a *misaddressed* frame, not an unknown one. The client's recovery — one re-handshake — is right either way; the log wording is what a human reads at 3am.

## 10. Pre-authentication hardening

`POST /api/e2ee/open` is public — added to `PUBLIC_POST_PATHS` in `src/api/middleware/auth.middleware.ts` — so everything it parses is bytes an attacker chose, before anything has authenticated them ([D-9](./dilemmas.md#d-9--where-e2ee-sits-relative-to-the-auth-middleware)).

- **Reject an unknown `ctxId` before any allocation.** The registry lookup is the first thing that runs.
- **Bound the body before decrypting.** Check the *encoded* length, as `parseE2eeRequest` already does in `src/e2ee/pair-request.ts` — testing the decoded size means performing the allocation the bound exists to prevent.
- **Read the body with a bounded reader.** The shared `readBody` helper concatenates every chunk before parsing, so on a public path a multi-GB POST is fully buffered before any bound applies — `pair-request.ts`'s base64 cap runs *after* the whole body is in memory. W1a adds a bounded reader (checks `Content-Length`, aborts the read past N KB) and `/open` uses it. Retrofitting `/pair/exchange` is a one-line follow-up PR in another track's file, not W1a's diff.
- **Never size a buffer from an attacker-supplied length field.**
- **Fail closed on the device row.** A static key with no row, or with `revoked_at` set, gets `E2EE_DEVICE_REVOKED` and no context. Absent is not the same as invalid, and neither is success.

### A bound this design cannot reach on the WebSocket channel, stated rather than assumed

D-9 asks for frames bounded *before* anything is allocated. On the socket that is **not achievable as currently wired**: `@hono/node-ws` constructs its `WebSocketServer` with hardcoded options and exposes no `maxPayload`, so `ws`'s 100 MiB default applies and the frame is fully assembled before any record-layer check runs. A per-frame ceiling in `record.ts` is therefore a check *after* allocation.

W1b either constructs its own `WebSocketServer({ noServer: true, maxPayload })` and handles the upgrade, or accepts the ceiling and reaps any socket that has not sent a valid sealed frame within N seconds. It must state which. Whoever holds a socket without keys — a ticket thief (below), or a legacy `?key=` device — can otherwise push 100 MiB frames.

**Per-direction frame ceilings**, because the two directions carry different things: client→server frames are `register` / `subscribe_session` / `hold_session`, which are bytes, so **64 KiB** is generous; server→client `terminal_replay` is bounded by the replay line cap and needs its own, larger ceiling. The server bounds c2s; the client bounds s2c.

**Ticket theft.** An intermediary that consumes the client's ticket first holds a socket bound to a context whose keys it does not have. It gets no plaintext — every frame is sealed to keys it lacks — but it occupies a hub slot receiving sealed broadcasts, and the legitimate client's upgrade fails and re-opens. Reaping silent sockets (above) closes it; carrying the ticket in a header rather than the URL removes the log-tailing variant entirely.

### The ticket, and a gap in the protection the design assumes

The WS ticket is single-use, 30 seconds, and bound to its `ctxId`.

**The ticket travels in a WebSocket header, not in the URL.** A URL query parameter lands in every ingress access log — Cloudflare logs full request URLs — and single-use plus 30 seconds bounds that damage without removing it. React Native's `WebSocket` accepts custom headers, so the ticket never needs to touch a URL. This is cheap now and expensive once the client half ships.

The `summarizeQuery` widening below is kept regardless: it protects `?key=`, which is not going anywhere, and every future secret-bearing parameter.

[design.md §3.5](./design.md) says the existing `summarizeQuery` protection (`src/api/app.ts`) *"already reduces `?ticket=` to `ticket=_`"*. **That is conditional, not unconditional.** The function reads:

```js
keys.map((k) => `${k}=${/^-?\d+$/.test(query[k]) ? query[k] : "_"}`)
```

An all-digit value is logged **verbatim**. Demonstrated:

```
summarizeQuery({ ticket: "Xk9_2bQz-aR4" })   →  ticket=_
summarizeQuery({ ticket: "84719203847192" })  →  ticket=84719203847192
```

A base64url ticket is essentially never all digits — and "essentially never" is exactly the probability-instead-of-invariant argument this design rejects for nonces. Two ways to close it, and W1a must pick one rather than rely on the alphabet by luck:

1. give `summarizeQuery` an explicit sensitive-key set that is always reduced, regardless of value; or
2. assert at ticket generation that the encoding can never be all digits.

**(1) is the decision.** It protects `?key=` and every future secret-bearing parameter, rather than one generator's alphabet. `summarizeQuery` gains an explicit sensitive-key set — `ticket`, `key`, and anything else carrying a credential — whose values are reduced to `_` **regardless of shape**.

Two tests, because one of them alone would be misleading:

- an **all-digit** ticket appears as `_` in `http.request`. A base64url ticket passes against today's unmodified code, so a test using one could never have failed and proves nothing.
- a non-sensitive numeric parameter — `limit=50` — still logs its value, so the fix is a sensitive-key rule rather than a blanket numeric redaction that would strip useful diagnostics.

## 11. The `/open` handshake

`NONCE-DESIGN` originally declared the handshake out of scope. It cannot be: W1a builds the server half now and a separate track builds the client half later, and **nothing currently written down makes the two agree.** `design.md` says only "Noise IK against the stored static keys", which admits at least three incompatible readings, and both codebases today implement `IKpsk1` with a **mandatory** PSK and no psk-less path. Getting this wrong fails every `/open` with "decryption failed" and nothing else, discovered at the client's interop run weeks after the tag freezes.

| | |
|---|---|
| Protocol name | **`Noise_IK_25519_ChaChaPoly_SHA256`** — the exact bytes that seed `h`, so the name itself is domain separation |
| Prologue | **`"threadbase-e2ee/1 open"`** — explicit, never the default `PAIR_PROLOGUE` |
| PSK | **none.** No `psk` token, no `mixKeyAndHash` step |
| msg1 payload | `{ v, kind }` — `kind` is `"ws"` or `"rest"`, **required**, and authenticated inside the AEAD |
| msg2 payload | `{ v, ctxId, expiresAt, provisional, ticket? }` — `ticket` **only** for `kind: "ws"`; encodings in §12 |

**`kind` is required and has no default.** §8 defines two context kinds with different lifetimes, different receive state and different contents, so the handshake has to say which one it is opening — and a capability that was never asked for must not be inferred in either direction, the same rule `readOnly` follows at pairing. It travels **inside** the encrypted payload rather than as an outer field, so an intermediary cannot flip a socket context into a REST one.

**`ticket` is absent for a REST context, not null.** Only a WS context is redeemed at an upgrade; issuing a ticket nobody can spend would be a credential minted for no reason.

**`provisional` is always present** (§12): while `true`, `expiresAt` is the use-by deadline, not the session lifetime.

Both `noise.ts` implementations gain a **psk-less branch**: a different protocol name and the `psk` token skipped. It is a small amount of new crypto code and it gets its own vectors and its own adversary attention.

**Every byte-field guard goes through one helper.** `assertBytes(value, length, name)` — `value instanceof Uint8Array && value.BYTES_PER_ELEMENT === 1 && value.byteLength === length` — for the PSK, the keys, `ctxId`, the target and the ephemeral.

**The accepted type is `Uint8Array`, not `Buffer`, and the builders must honour that.** A `Buffer` *is* a `Uint8Array`, so a predicate that tests for the former while claiming the latter admits a plain view and then dies on `Buffer`-only methods — `target.copy is not a function`, a `TypeError` outside §9's code set rather than an `E2EE_SEAL_FAILED`. This matters because **§16 makes this module an artefact a second implementation consumes, and a `@stablelib`-based client produces plain `Uint8Array`s.** Build with `Buffer.from(view.buffer, view.byteOffset, view.byteLength)` or `.set`, so a correct-length view works and a wrong-length one is refused with a code the client can act on.

Three separate guards in this design were written against a *missing* argument and left silent on an *empty* one; a fourth was silent on a *wrong-typed* one. `.length` is not byte length for a typed array, so `new Float64Array(32)` passes a "32-byte" check and binds **256 zero bytes**. One helper is the fix, because the defect is not in any single guard — it is in writing the guard four times.

**No argument that reaches a trust boundary takes a `??` or `||` default.** Both operators read through the prototype chain, so `Object.prototype.prologue` makes the pairing handshake accept an `/open` message — collapsing the domain separation this section exists to create — and `Object.prototype.ephemeral` pins every handshake to one attacker-chosen ephemeral, which by this document's own rule is definitionally a replay. A prologue is a **required parameter**; everything else is read with `Object.hasOwn`.

**A pre-shared key is checked for its length, not its presence.** `if (!psk)` is a truthiness test, and an empty buffer is truthy — so an `IKpsk1` handshake completes with the right protocol name, the right token order, and a binding over **zero bytes**. The wire says the pair token is bound; it is not. That is exactly what this section rejects above when it refuses a public-constant PSK, arriving through a missing length check instead of a deliberate choice, and the selector being hardened against a *missing* argument is what makes an *empty* one easy to miss. Require exactly the hash length, on both message paths, on both sides.

**The pattern is selected explicitly, never inferred from whether a `psk` argument was passed.** Choosing the branch by the *absence* of `psk` means a pairing call site that simply forgets the argument silently downgrades to plain `IK` and loses the pair-token binding that is the entire reason pairing uses `IKpsk1` — a missing argument selecting a weaker protocol, at a trust boundary. Take a `pattern: "IKpsk1" | "IK"` argument (or two named entry points): `IKpsk1` **throws** when `psk` is absent, and `IK` **throws** when one is supplied. Both directions, because handing a PSK to the psk-less pattern is equally a caller who has misunderstood which handshake they are running.

**The default must be read from the argument object itself.** `args.pattern ?? "IKpsk1"` walks the prototype chain, so any prototype pollution anywhere in the process reassigns the default of a protocol selector at a trust boundary. "The default is the stronger pattern" has to be enforced by `Object.hasOwn`, not asserted in a comment.

**And a third direction: an unrecognised pattern must throw, not fall through.** A selector ending `return pattern === "IKpsk1" ? withPsk : withoutPsk` sends every value that is neither — `"IKPSK1"`, `"ik"`, anything arriving from a config file or the wire — to the **psk-less** branch, silently dropping the pair-token binding. The type system does not protect the client track, which consumes this module as an artefact rather than as typed source. Make the selector exhaustive and throw on anything unrecognised.

**Every `/open` attempt runs `writeMessage1` afresh — a retry never re-sends the previous bytes.**

This is a client obligation and it must be in the client contract, not only here. A msg1 is replay-detected by its ephemeral, so re-sending an identical body after a lost response, a timeout or a connection reset is **indistinguishable from an attacker's replay** and is refused for the life of the cache entry.

**A `429` is the exception, and the distinction matters because this is a contract another implementation builds against:** both rate-limit paths return *before* the message is recorded, so identical bytes do work after either. Do not rely on that — re-running `writeMessage1` is correct after every outcome — but the contract must not claim a refusal that does not happen. The refusal is a route-level `400 E2EE_HANDSHAKE_FAILED`, deliberately identical to every other handshake failure — it does not and must not tell an attacker which of its guesses was a replay — so the client cannot diagnose this from the response and has to get it right by construction.

It is the same rule §14 states for records: a retry re-seals from plaintext. The failure mode here is worse, because it is silent, durable for a day, and looks exactly like a server fault.

**Commit `/open` interop vectors beside the record fixtures** (§16), and one test that **a pairing vector fails against the open prologue.** Without that test, leaving the prologue at its default would silently remove the domain separation this table exists to provide — a captured pairing msg1 and an `/open` msg1 would then differ only by the PSK step.

*The alternative considered and rejected: keep `IKpsk1` with a public constant PSK. Security reduces to plain `IK` and the code reuse is total, but it encodes "there is a PSK here that means nothing", and a reader who assumes a real PSK draws a false conclusion about freshness — which is exactly the mistake H1 in §8 exists to prevent.*

## 12. Wire encodings

Every row here is a place two independent implementations pass their own positive fixtures and still fail on the wire. **Pin each value in the fixtures (§16), not only in this table.**

| Field | Encoding |
|---|---|
| `ctxId` | 16 bytes, **base64url**, unpadded — the same spelling in `X-TB-Ctx`, in JSON, and in fixtures |
| `X-TB-Seq` | decimal string of the `bigint` counter |
| `expiresAt` | milliseconds since the Unix epoch — **the deadline that currently applies**: the provisional TTL while the context is provisional, the full lifetime once used |
| `provisional` | boolean in msg2; `true` means `expiresAt` is the use-by deadline, not the session lifetime |
| `kind` | `"ws"` or `"rest"`, required in msg1 |
| drain window | **10 s.** How long an evicted context keeps serving before it answers `E2EE_CTX_UNKNOWN` (§8). Pinned here because a client that retries faster than the drain will not see the retirement it is supposed to recover from. Shorter than the 30 s provisional TTL, far longer than any REST round trip. |
| ticket | base64url, unpadded, 22 characters |
| WS frames | **binary** opcode; the client must set `binaryType` accordingly |
| Header casing | as written here — `X-TB-E2EE`, `X-TB-Ctx`, `X-TB-Seq` |

**`ctxId` is server-assigned: 16 random bytes, delivered in msg2, and never derived by the client.** The earlier `HKDF(h_ss, "tb-e2ee-ctx-id", 16)` is fine as a server-side detail but is wrong as a contract — it specifies no salt/info/IKM roles, the client has no HKDF library of the right shape, and since the server already returns `ctxId` in msg2 a client that derived it would hold a second source of truth to disagree with.

## 13. The REST envelope contract

W1a ships the record-layer API for (a) and (c); the REST middleware is another track's, built on top of it. It is settled here because the tag freezes it.

**(a) A response is bound to the counter of the request it answers.** `RestResponseSealer.seal(requestCounter, plaintext)` (§5 R4) is the only sanctioned shape. Two rules make it safe, and nonce uniqueness for `(k_s2c, 2‖counter)` depends on the first:

> **At most one sealed response per accepted request counter.** A request rejected by the window (a replay) or by the AEAD gets a **plaintext** error and never a sealed body — including through the framework's error path.

**The sealer enforces this itself; it does not inherit it.** Accepting a counter that has already been answered must be refused *in the sealer*, by remembering answered counters — not left to whatever sits upstream. Today the strict receive counter happens to make a repeat impossible, but that is the very code the sliding window replaces: the moment acceptance becomes window-driven, an upstream bug stops being a replay and becomes **keystream reuse under `(k_s2c, 2‖counter)`**, which is the one failure this entire document exists to prevent. An invariant held by a layer scheduled for replacement is not held.

and the client checks `response.counter === request.counter`.

**Saturation must not become a server fault.** The outstanding-counter table is bounded. When that bound is reached, the request whose counter is dropped gets a **plaintext, retryable** error — an `E2EE_CTX_UNKNOWN`-class outcome — and never a sealed-response attempt that dead-ends in `E2EE_SEAL_FAILED`. A server fault the client cannot recover from is exactly what §6's ruling removed from the rekey path; it must not reappear on a saturation edge. The REST middleware should shed load with a retryable status before the bound is reached at all.

*Why not a second sender counter for responses:* responses would then not be bound to requests at all, and because the client issues concurrent requests an on-path attacker could swap two in-flight sealed responses within one context — both authenticate under `k_s2c` with fresh counters, and the client would have nothing to compare against.

**(b) The principal comes from the context, and no `Authorization` header travels on a sealed request.** Unseal runs before authentication *so that* the credential travels sealed; a device token in a plaintext header on every sealed request is the exact leak that ordering exists to close. The unseal middleware sets the principal from the context and re-checks `revoked_at` per request; the auth middleware skips when a principal is already set. An `Authorization` header present alongside `X-TB-Ctx` **must name the context's device or the request is rejected** — "header device ≠ context device" is otherwise undefined behaviour at a trust boundary.

**Nobody re-adds `Authorization` to get past Cloudflare Access.** A named tunnel behind *interactive* Access `401`s any request without a bearer at the edge, so a `401` on a sealed request looks like it would be fixed by putting the header back. It would not — it would reintroduce the exact leak this rule closes. That topology already does not support the mobile client, and the right answers are Access off or a Service Token (which uses `CF-Access-Client-*`, not `Authorization`).

State the D-9 rationale accurately while we are here: sealing the credential hides it from the **tunnel data plane**, not from Cloudflare-the-company — with a Service Token or interactive Access enabled, the edge sees a credential on every request regardless.

**(c) The AAD binds method, path and query** on channels `0x02`/`0x03` — see §4.

**The AAD builder enforces the target rule itself**, rather than trusting a caller-side assert: REST channels require a 32-byte target, the WebSocket channel forbids one. The check must live in the builder because the client track consumes the builder — a rule enforced one layer up is a rule that other implementation does not get.

**The response sealer requires its target and validates it, like every other seal path.** `seal(requestCounter, plaintext, target)` — three arguments, none optional. The target must be passed *into* the AAD builder rather than concatenated beside it, or the builder's length check is unreachable and a caller can seal a response with no binding at all, or a short one. The receive side and the record state both enforcing it is not enough: the response sealer is the path the REST middleware calls, and a safeguard with one unexercised hole is the hole.

**The REST receiver needs a sanctioned seam.** `unseal` enforces strict `expected` (§5 R2), which is correct for the socket and wrong for a sliding window. Exposing the AEAD step alone — an `unsealUnchecked` returning `{ plaintext, counter }`, **REST request channel only** — is the sanctioned shape, because the alternative is the REST track reaching around the record layer and reimplementing nonce and AAD assembly, which is precisely the duplication that makes two implementations disagree. Whichever side adds it, **the W1a PR body must say which**, so the REST track does not discover the gap at its own kickoff.

**Not settled here, and the REST track must settle it before building:** bodiless `GET` framing (a sealed GET carries no record, so it needs a header-carried tag over the §4 AAD or it is unauthenticated and never advances the window); streaming ndjson responses, which a single-record envelope would buffer end-to-end; multipart uploads, whose original `Content-Type` must travel inside the envelope; and response interception, which must buffer and rewrite `Content-Type`/`Content-Length` rather than only counting bytes as the existing byte-counter does.

**Non-enumerability alone does not hide a key.** `Object.defineProperty(..., { enumerable: false })` defeats default `util.inspect`, spread, interpolation and a test runner's differ — but **not `util.inspect(x, { showHidden: true })`**, which is precisely the flag a diagnostic dump reaches for, and which on a *registry* prints every live context's keys in one call. **No traffic-key bytes exist as a JS `Buffer` once the handshake completes.** The keys are `crypto.KeyObject`s, opaque to every renderer; `export()` is the only path back to bytes and nothing calls it. The buffers they were imported from are `Buffer.allocUnsafeSlow` copies, zeroed immediately after import.

That is the rule because **hiding was tried three times and defeated three times**, each by a mode the previous fix had not imagined:

| Mechanism | Defeated by |
|---|---|
| `Object.defineProperty(…, { enumerable: false })` | `util.inspect(x, { showHidden: true })` |
| `Symbol.for("nodejs.util.inspect.custom")` | `util.inspect(x, { customInspect: false })` |
| both together | both flags together — and on the *registry*, every live context's key in one call |
| TypeScript `private` | nothing; it is an ordinary own property at runtime |
| ECMAScript `#private` | `{ customInspect: false, showHidden: true, getters: true }` — `showHidden` surfaces the accessors and `getters` invokes them |
| ECMAScript `#private`, **no getter at all** | **the allocation pool.** Node pool-allocates small Buffers; a Buffer's `parent`/`buffer` exposes the shared 8 KiB `ArrayBuffer`, and a *public* Buffer on the same object — `ctxId` — hands out a window onto the pool the private key was allocated in |

The last row is why hiding cannot be the mechanism. **A `#private` field closes nothing when its buffer shares an allocation with a public one**, and the leak then arrives through an object that holds no key at all. Every public Buffer on a key-bearing object is therefore an `allocUnsafeSlow` copy, which is unpooled.

Two corollaries worth stating, because both were missed once:

- **The state that makes a nonce unique is as sensitive as the key.** The counter, the outstanding set, the answered bitmap and the high-water mark are `#private` too: with them as ordinary properties, one assignment re-arms every answered counter into keystream reuse, and TypeScript `private` is not present in the repository that consumes this module.
- The list of things to check is not "the classes named after keys". The leak above arrives through `ctxId`, which is public by design.



## 14. What this document forbids

| Forbidden | Because |
|---|---|
| Reusing `chachaNonce` from `src/e2ee/noise.ts` | little-endian, spec §12.3 — wrong layer (§2) |
| Building the record state from `CipherState` | its `n` is the handshake's; the record layer owns its own counter (§5 R4) |
| A caller supplying a counter to `seal`/`unseal` | makes every call site a place to break R1 (§5 R4) |
| Any window, tolerance or reordering allowance on the WebSocket channel | R2 is what makes replay structurally impossible there (§5) |
| Resetting the counter for any reason | §6 — the invariant is settled even while the key-replacement mechanism is not |
| `Authorization` on a sealed REST request | §13(b) — it is the leak the middleware ordering exists to close |
| A sealed response to a request the window or the AEAD rejected | §13(a) — it breaks nonce uniqueness for `(k_s2c, 2‖counter)` |
| Deriving `ctxId` on the client | §12 — a second source of truth to disagree with |
| The default `PAIR_PROLOGUE` at `/open` | §11 — silently removes the domain separation |
| An `await` between `seal` and `ws.send` | reorders frames; the peer's strict counter then closes the socket. Seal-and-send is one synchronous step. |
| An `await` before a ticket is consumed | ticket consumption is a synchronous map delete *before* any await, or two upgrades race one ticket |
| Re-sending previously sealed bytes on a retry | a retry re-seals from plaintext; re-sending replays a counter the window already accepted |
| Minting a third protocol-version constant | §4 |
| One device-wide context shared by the socket and REST | a socket drop loses in-flight frames, so R2 turns the next frame into a gap and the client closes forever (§8) |

## 15. Test obligations

Each row is a rule above, the test that holds it, and the mutation that must make that test fail. A safeguard whose mutation was never seen red is not verified.

| Rule | Test | Mutation that must fail it |
|---|---|---|
| §2 nonce never reused in a context | nonce log across a full session has no duplicate `(direction, counter)` | reuse a counter value |
| §2 no reflection | a server→client record fed back as client→server is rejected | remove **every** binding of `direction` — the AAD field, the nonce bytes, and the header check. See the note below. |
| §4 AAD binds `ctxId` / `channel` | mutating either fails decryption | drop that field from the AAD |
| §4 AAD binds `counter` | a frame renumbered into the expected slot fails | remove **every** binding of `counter` — AAD field and nonce bytes. See the note below. |
| §5 R1 | counter advances by exactly 1 per sealed record | advance before sealing |
| §5 R2 | out-of-order, duplicate and gapped counters each rejected + closed | introduce a window → gap accepted |
| §5 R3 | a rejected frame leaves the counter unadvanced | advance on failure → duplicate accepted |
| §7 exhaustion | a sender at `2^64 - 1` refuses | allow the wrap |
| §8 unknown ctx | unknown `ctxId` rejected before allocation, `E2EE_CTX_UNKNOWN` | look up after allocating |
| §9 codes distinct | revoked and restart-lost produce different codes | collapse them into one |
| §10 body bound | an oversized body is refused before decrypt | remove the length check |
| §10 ticket log | an **all-digit** ticket appears as `_` in `http.request` | remove the sensitive-key set |
| §10 log control | `limit=50` still logs its value | redact numerics blanket-wise → diagnostics lost |
| §8 per-socket context | a reconnect gets a new `ctxId`, and the old one is rejected with `E2EE_CTX_UNKNOWN` | keep the context alive past close |
| §8 REST survives the socket | a REST request succeeds while no socket is open | bind the REST context to the socket → the 2 s replay fallback breaks |
| §8 ticket single-use | two concurrent upgrades with one ticket → exactly one accepted | drop the consume-on-use |
| §8 provisional TTL | a context whose ticket is never consumed is gone at 30 s | leave it resident |
| §8 per-device cap | with four contexts **in use**, the 5th evicts the oldest *used* one and is itself usable | let the new context be its own eviction candidate |
| §8 msg1 replay | one captured msg1 replayed N times → bounded contexts and tickets | remove the rate limit |
| §8 `destroyDevice` | revoking kills every context and returns the sockets to terminate | index by context only |
| §5 R2 ordering | an injected frame with a bad tag reports a seal failure, **not** a sequence violation | check the counter before the AEAD |
| §11 prologue | a pairing vector fails against the `/open` prologue | default the prologue |
| §4 target binding | a sealed body re-pointed at another path fails to authenticate | drop the sha256 suffix |
| §13(a) response echo | a rejected request gets a plaintext error and never a sealed body | seal the error too |
| §10 bounded reader | an oversized `/open` body is refused without buffering | use the unbounded reader |
| §7 exhaustion | the refusal leaves the state unchanged and the context is destroyed | allow the wrap |
| §8 source failure budget | the 31st garbage msg1 from one source is refused **before any DH** | charge the bucket without checking it |
| §8 well-formed unpaired flood | a fresh-keypair flood is charged too, and stops at 30 | charge only malformed handshakes |
| §8 msg1 replay cache | 1000 replays of one msg1 cost **0 DH after the first** | drop the ephemeral check |
| §8 replay billing | a replay never charges the *device* budget, so a bystander cannot lock a victim out | charge the device instead of the source |
| §8 cache bounds | a full cache evicts its oldest and still accepts a fresh `e`; memory flat | make the cache unbounded |
| §13 handshake-state hygiene | `SymmetricState`, `CipherState` and both handshake states hide `ck` under plain `inspect` **and** `showHidden` | leave the handshake states unredacted |
| §11 explicit pattern | `IKpsk1` without a `psk`, and `IK` with one, each throw | select the pattern by `psk` presence |
| §8 sweep on open | N replayed msg1s leave the live context and ticket counts bounded | sweep only on lookup |

**A mutation that cannot be seen red does not verify anything, and two of these nearly were not.** `direction` and `counter` are each bound in *two* independent places — the AAD **and** the nonce — plus an explicit header check. Dropping either from the AAD alone leaves the frame rejected anyway, by the nonce, so the safeguard test stays green and only the interop fixtures fail because the ciphertext changed. The defence-in-depth is real and welcome; the consequence is that the mutation must remove **every** binding of the field, or it proves nothing about the safeguard it claims to test. `ctxId` and `channel` are bound by the AAD alone, so the single-field mutation is genuinely sufficient for them.

**Positive control** — a sealed frame round-trips and its `type` field is readable only after unseal.
**Negative control** — with sealing disabled the same capture shows plaintext, proving the capture harness can see plaintext when it is there.

## 16. Interop fixtures

Committed under `__tests__/fixtures/`, with their path named in the W1a PR body so the client track has something concrete at the tag.

Each fixture carries: both traffic keys, `ctxId`, direction, counter, the assembled AAD, the plaintext, and the expected ciphertext — enough for the client to check its independent implementation byte for byte.

**Positive vectors alone are not enough.** A client that matches only positive vectors can still accept a mutated AAD field, a reflected direction or a counter gap — the exact "correct output sitting above a defect" shape Phase 2 warned about. Commit **negative vectors** too, each with the rejection it must produce:

- every AAD field mutated in turn — `version`, `ctxId`, `direction`, `counter`, `channel`, and the REST target hash — each must be **rejected**;

  Note for whoever implements the other side: `direction` and `counter` are bound in the **nonce as well as the AAD**, so those two vectors do not prove anything about the AAD on its own — they prove the frame is rejected, which is what matters. Do not read this list as "the AAD is the only binding"; §15 says the same thing about why their mutations must remove every binding.

- a reflected direction — a server→client record fed back as client→server — must fail;
- a counter gap and a counter repeat — each must produce a sequence violation, not a decrypt;
- the `/open` vectors from §11, including the pairing-vector-against-open-prologue failure;
- a REST target vector whose path contains `%2F` and whose query carries two parameters in non-alphabetical order, pinning §4's canonicalization by bytes.

**The `/open` handshake vector is its own artefact.** The only committed handshake fixture is the pairing `IKpsk1` transcript, which uses a different protocol name (so it seeds `h` differently), a different prologue, and a PSK step — it cannot check a psk-less `IK` implementation at all. Commit: the server static key, the client static key and ephemeral, both message byte strings, the resulting `handshakeHash`, and both traffic keys. Driving the handshake live in a test does not substitute — **the client consumes the fixture, not our test file.**

**Read them for what they are.** Phase 2's vectors proved the two sides agreed on a committed fixture; they did not establish conformance to the specification, and every defect found in the client implementation sat underneath correct output. The same caution applies here, which is why the acceptance for this layer is an isolated adversary rather than a matching fixture.

---

## 17. Corrections this PR makes to the design of record

A design document that contradicts the shipped record layer is worse than no document, so these land with the code rather than after it. All three files are in this spec folder, so one PR covers them.

| File | Sentence | Correction |
|---|---|---|
| `design.md` §4.3 | "Counters reset to 0 only as part of a rekey" | **There is no in-place rekey at all**; a new key is a new context, and the counter question does not arise. See §6. (This sentence was first corrected to "rekey replaces `k` only, the counter continues" — that intermediate wording is superseded, and `design.md` should carry the current rule plus why it changed twice.) |
| `design.md` §4.3 | the transport context "follows the socket", destroyed "on socket close after a grace window" | Two contexts per device — per-socket for the WS, long-lived for REST — and no grace window. See §8. |
| `mobile-design.md` §4.3 | reconnect row: "Reuse the context if unexpired; fetch a fresh ticket" | "Reuse the REST context; open a new socket context with a fresh ticket." A fresh ticket only comes from a fresh `/api/e2ee/open`, so a reconnect was always a new handshake. |
| `design.md` §3.3 | "refuses to send and forces a rekey" | The refusal destroys the context. See §7. |
| `design.md` §1.3 | an active MITM "cannot inject input into a session" | It could re-route a sealed request to another session until §4 bound the target. Correct the claim to match what the AAD actually guarantees. |
| `design.md` §3.4 | "Responses do not need a window — each is bound to its request's counter in the AAD" | True, but only under §13(a)'s rule that a rejected request never receives a sealed body. State the rule with the claim. |
| `design.md` §3.5 | `/open` described only as "Noise IK" | Point at §11 for the protocol name, prologue and PSK rule. |

Each correction quotes the old sentence and points here, so the reasoning is recoverable rather than silently overwritten.

---

## 18. Two small things that are easy to miss

**`/api/e2ee/open` needs a route-capabilities entry.** A test asserts every mounted route is classified, so a new route without one fails the suite. Classify it the way the other public-bypass routes are, with a rule so that a stray method is denied by rule rather than by omission.

**App-level `{ type: "ping" }` frames are sealed like any other frame and consume counters.** That is correct and costs nothing. Worth one sentence here because WebSocket *protocol* pings are invisible to React Native's JS layer, so the client's silence timer depends on the app-level ping continuing to exist — nobody should "optimise" it away on the grounds that the protocol already has one.
