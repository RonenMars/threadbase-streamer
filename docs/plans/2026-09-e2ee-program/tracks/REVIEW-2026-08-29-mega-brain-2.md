# E2EE re-review — 2026-08-29, revision 2 (`e2ee-mega-brain-reviewer`)

**Requested by:** `e2ee-owner [ddde5e]`, 03:10 IDT, on the user's instruction. Read-only: no repo, worktree, or config edited; the implementer's worktree `.worktrees/feat/e2ee-record-impl` has a resident sub-agent actively editing, so several files moved *during* this review — where that matters I re-verified against the live tree and say so.

**Inputs, pinned to the live tree.** `NONCE-DESIGN.md` revision 2 (402 lines, identical in both W trees, uncommitted). WIP under `.worktrees/feat/e2ee-record-impl`: `src/e2ee/record.ts` (500 lines), `context.ts` (498), `protocol.ts` (65), `api/routes/e2ee.routes.ts` (281), `api/rate-limit.ts` (46); tests `e2ee-record.test.ts`, `e2ee-context.test.ts`, `e2ee-open-route.test.ts`, `__tests__/fixtures/e2ee-record-vectors.json`; tracked diffs to `noise.ts`, `pair-request.ts`, `app.ts`, `auth.middleware.ts`, `misc.routes.ts`, `capabilities.ts`, `http-request-log.test.ts`, and the `design.md` / `mobile-design.md` corrections. `tracks/W/ADVERSARY-BRIEF-ADDITIONS.md`, `tracks/F/PLAN-F.md`, `tracks/D/PLAN-D.md`, `tracks/STATUS.md` decisions log. Streamer `origin/main` **91ce3f18**, mobile **f3e82287** — unchanged.

**Method note — the tree is live.** Between my first and second reads, the sub-agent fixed four things my first pass would have flagged: the `OPEN_PSK` import (now the `/open` tests are psk-less and add a `protocolName` assertion), a stale `rekey`/`ctxIdDerivation` block in the fixture, a missing `e2ee-protocol-version.test.ts` (now present), and a `ctxIdBase64Url` field-name mismatch. **I re-verified each against the live tree and am NOT reporting them** — they were transients of an in-progress edit, exactly as the owner warned. Everything below was confirmed present in the tree after the last re-verify (03:1x).

---

## Summary

The revision applied the rev-1 rulings faithfully and the code is good: `RestResponseSealer` binds responses to the request counter with a one-per-accepted-counter rule enforced in the type rather than in a middleware's memory (`record.ts:388-417`), authenticate-before-sequence-check is implemented and tested (`record.ts:324-335`), the `/open` psk-less `IK` handshake is specified and its prologue *and* pattern name are both isolated by tests, the target hash binds the REST request line, provisional contexts + per-device caps + a bounded body reader all exist, and the key-hygiene stop-work is fixed with a red mutation. **Almost every rev-1 blocker and high is resolved or correctly deferred.**

What remains splits three ways:

1. **B3 is only three-quarters propagated.** The user's "no in-place rekey" ruling reached `design.md` and `mobile-design.md` cleanly, but **NONCE-DESIGN §8's own two lifecycle tables still say REST rekeys** (`NONCE-DESIGN.md:140`, `:154`) and §8's opening sentence still gives the superseded `ctxId = HKDF(…)` derivation (`:125`) that §12 overrode. A reader of §8 alone gets two abolished rules. This is the specific §6-vs-§8 contradiction you asked me to hunt. (N-M1)
2. **One new HIGH the revision introduced:** a REST context is advertised to the client with a 24 h `expiresAt` in msg2 but the server holds it provisional at 30 s until its first request, while §8 says REST is opened "lazily" — a client that warms a REST context ahead of its first call loses it after 30 s and the advertised number gave it no warning. (N-H1)
3. **Interop anchors that §11/§16 promise but the fixture does not yet carry:** no committed `/open` handshake vector (the psk-less `IK` transcript is distinct from the pairing `IKpsk1` one the only committed vector pins), and no committed negative vectors. Both are B1/M11 residuals that must land before the tag or X-client has nothing to check its independent psk-less implementation against. (N-M4, N-M5)

Counts, new this pass: **1 blocker-adjacent HIGH, 7 medium, 2 low, plus the answers to your five questions.** No finding survives against the record-layer crypto (§2–§5, §7) or the `RestResponseSealer` design.

**Bottom line for the tag:** three doc fixes (N-M1's §8 sweep, N-H1's REST `expiresAt`, N-M2's target-string canonicalization) and two committed-fixture additions (N-M4 `/open` vector, N-M5 negative vectors) are the gate. Everything else is either resolved, or a later track's to build against a now-frozen contract.

---

## Resolution of the rev-1 findings

| Rev-1 | Status | Evidence / residual |
|---|---|---|
| **B1** `/open` handshake unspecified | **PARTIAL** | Design resolved: §11 pins `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `threadbase-e2ee/1 open`, no PSK; `noise.ts` gains the psk-less branch (`NOISE_IK_PROTOCOL_NAME`, `if (args.psk)` guards); `e2ee-open-route.test.ts` isolates the prologue *and* asserts the protocol name differs. **Residual → N-M4: no committed `/open` interop vector.** |
| **B2(a)** response binding vs R4 | **RESOLVED** | `RestResponseSealer.seal(requestCounter,…)` (`record.ts:401`), `accept()` only on a successful unseal (`context.ts:200-205`), one-per-counter via `outstanding.delete` (`record.ts:402`), client checks `response.counter === request.counter`. Tested `record.ts` "never seals a body for a request that was rejected, and never twice". Residual → N-M6 (liveness). |
| **B2(b)** credential location | **RESOLVED** | §13(b): principal from context, no `Authorization` on a sealed request, `Authorization`-alongside-`X-TB-Ctx` must name the context's device. Clarification, not reversal → N-L1 (Access edge). |
| **B2(c)** request-target integrity | **RESOLVED** | §4 32-byte `sha256(method‖path‖query)` suffix; `restTargetHash` + `assertTarget` refuse a missing target on REST and a present one on the socket (`record.ts:131,185`); tested. **Residual → N-M2: the target *string* is not canonicalized.** |
| **B3** in-place rekey | **PARTIAL** | User ruled Alternative B. `design.md`/`mobile-design.md` fully updated; `rekey()`/`bytesSealed` gone from `record.ts`. **Residual → N-M1: NONCE-DESIGN §8's tables and §8's ctxId sentence still describe rekey / HKDF.** |
| **H1** msg1-replay allocation | **RESOLVED (+residuals)** | Provisional-until-used (30 s), per-device caps (4 ws / 2 rest), rate limit on `/open`. Residuals → N-H1 (REST provisional cliff), N-M2b (eviction has no drain), N-M3 (rate limit collapses behind the tunnel). |
| **H2** plaintext 401/304/426 drive client state | **DEFERRED (X-client)** | Server-side `refuseUnsealedIfPinned` exists; the client rule is X-client's. Captured in ADVERSARY-BRIEF-ADDITIONS rows 10-12. Still open for X-client — correctly out of W1a. |
| **H3** export declaration false today | **ACKNOWLEDGED** | STATUS restates it as a present exposure. User's call. |
| **H4** authenticate before sequence-check | **RESOLVED** | `record.ts:324-335` runs the AEAD (`openWith`) then compares the counter; §5 R2-ordering + §9 note; test "reports a seal failure, not a sequence violation, for an injected frame". |
| **M1** ctxId + encodings | **RESOLVED (+residual)** | `ctxId` server-assigned random (`context.ts:72`), §12 wire-encodings table. Residual folded into N-M1 (§8:125 still says HKDF) and N-M2 (target-string spelling absent from the table). |
| **M2** bounded reader | **RESOLVED** | `readBoundedJsonBody` checks `Content-Length` then the running total, drains-and-drops past the bound (`e2ee.routes.ts:75-110`), tested. |
| **M3** `@hono/node-ws` maxPayload | **ACKNOWLEDGED/deferred** | §10 states the gap honestly and defers the fix + a stated choice to W1b. Correct. |
| **M4** `destroyDevice` | **RESOLVED** | `E2eeContextRegistry.destroyDevice` returns `socketCtxIds`/`restCtxIds`/`tickets`; route wiring is W1b. |
| **M5** async connect / `forceReconnect` race | **DEFERRED (X-client)** | §8 states the client single-flights the re-open; impl is X-client's. |
| **M6** pin-loss reconnect loop / no 426 client handling | **DEFERRED (X-client + F3/#903)** | `refuseUnsealedIfPinned` server-side; client 426 handling is X-client's. |
| **M7** constant collapse | **RESOLVED** | Re-exports in `pair-request.ts`/`misc.routes.ts`, canonical `protocol.ts`, `e2ee-protocol-version.test.ts` present, version-coupling caveat written into §4. |
| **M8** REST framing gaps | **ACKNOWLEDGED** | §13 "Not settled here, and the REST track must settle it" lists bodiless GET, streaming, multipart, response interception. Frozen list, deferred to X-server. |
| **M9** Hermes never exercised | **DEFERRED (X-client/D2)** | On-device fixture run is X-client's; D2 measures. |
| **M10** adversary brief | **RESOLVED** | `ADVERSARY-BRIEF-ADDITIONS.md` carries rev-1 rows 1-13 verbatim, incl. the key-hygiene class. |
| **M11** negative vectors | **PARTIAL** | §16 *lists* the negative vectors and `record.test.ts` computes negative *cases* live. **Residual → N-M5: the committed fixture is positive-only**, so the client has no committed negative vector to consume. |
| **M12** ticket in a WS header | **RESOLVED** | §10/§12; client impl is X-client's. |
| **L1–L12** | **RESOLVED** | L1 route classification (`capabilities.ts` `/api/e2ee` + §18); L2/L3/L8 → §14 forbidden rows; L4 → §9 + `record.ts:312` misaddressed wording; L5 → §10 per-direction ceilings; L6 → §7 destroy-on-exhaustion; L7 → §8 single-flight; L9 → §10 reap; L10 → `expiresAt` present (but see N-H1); L11 → §17 corrections incl. §1.3/§3.4; L12 → §18 app-ping note. |
| **N1** D-8 option 3 | **DEFERRED (R2)** | STATUS decisions log records "N1 D-8 option 3, decided at R2." |

---

## New findings this pass

### HIGH

#### N-H1 — a REST context is advertised for 24 h but dies in 30 s until its first request, and §8 says open it "lazily"

**Where.** `e2ee.routes.ts:244` (`const expiresAt = kind === "ws" ? provisionalExpiresAt(now) : contextExpiresAt(kind, now)` — REST is told **24 h** in msg2); `context.ts:152` (every `Context`, REST included, starts `this.expiresAt = provisionalExpiresAt(args.now)` = **30 s** with `provisional = true`); `context.ts:213-218` (`markUsed` promotes to the full lifetime only on first use); `context.ts:315-322` (`get()` destroys any context past `expiresAt`); `NONCE-DESIGN.md:136` (§8 table: REST "Opened by `POST /api/e2ee/open`, **lazily**"); `mobile-design.md §4.1` on `origin/main` ("open one lazily, per §4.3").

**Failure scenario.** X-client reads the contract at the frozen tag: msg2 says this REST context is good for 24 h, and §8 says open it "lazily." A reasonable client warms the REST context on foreground (or on the first navigation) and issues its first actual API call when the user taps through, 30–60 s later. The server destroyed the context at 30 s (`get()` past the provisional deadline), so that first sealed request returns `E2EE_CTX_UNKNOWN` and the client eats a spurious re-handshake at the app's slowest moment — the exact round trip `mobile-design.md §4.3:150` set out to avoid. It is recoverable (that is why this is HIGH, not a blocker), but it is a contract trap frozen into the tag: the advertised `expiresAt` actively lies about the deadline, and "lazily" invites the losing pattern. The route comment (`e2ee.routes.ts:243-247`) shows the intent — "a client that opens one in order to send a request it is already holding" — but that intent is nowhere in the wire contract the client builds against.

**Fix (before the tag).** Make the advertised deadline honest: for a REST context, either put the provisional 30 s in msg2's `expiresAt` (and a separate `sessionExpiresAt`/`useBy` once used), or add an explicit `provisional: true` / `useByMs` field, and change §8's "lazily" to "opened with its first request in hand — a REST context not exercised within the ticket TTL is collected." One sentence in §8/§13 and one field in the msg2 payload; both are frozen at the tag, so they cannot wait for X-client.

### MEDIUM

#### N-M1 — B3 and M1 did not reach NONCE-DESIGN §8: the tables still say REST rekeys, and §8's ctxId sentence still says HKDF

**Where.** `NONCE-DESIGN.md:140` — §8 lifecycle table, REST column: **"Rekey | not applicable … | 1 GiB sealed, or client foreground"**; `:154` — §8 events table: **"Key replacement | n/a | §6, pending"** ("pending" — §6 is *ruled*, Alternative B); `:125` — §8 opening sentence: **"`ctxId = HKDF(h_ss, "tb-e2ee-ctx-id", 16)`, derivable by both sides…"**, which §12 (`:285`) overrode to server-assigned random and `context.ts:72` implements as `randomBytes`.

**Failure scenario.** §6 (`:93`) says "no in-place rekey anywhere"; §8's table three sections later still lists "1 GiB sealed, or client foreground" as a REST *rekey* trigger and still calls the row "Rekey." A reader who lands on §8's table — which is exactly where someone checks "what happens at 1 GiB" — gets the abolished answer, and the "Rekey" row header is the re-add-the-path invitation §6 explicitly warns against. Separately, §8's opening sentence still teaches the HKDF `ctxId` derivation that §12 abolished and the client is forbidden to perform (§12, §14 forbidden row) — so §8 and §12 give opposite `ctxId` rules, and §8 comes first. This is the "docs that carry status" rot §17 exists to prevent, inside the design's own governing section.

**Fix.** Sweep §8: rename the "Rekey" table row to "Key replacement" and set the REST cell to "1 GiB / 24 h / foreground → open a new context, retire the old (§6)"; change "§6, pending" to "§6"; and replace the §8:125 `ctxId = HKDF(…)` sentence with the §12 server-assigned rule (or delete it and point at §12). No code change — the code already matches §12 and §6.

#### N-M2 — the REST target hash is specified as `sha256(method‖path‖query)` but the string spelling of `path`/`query` is not pinned, so two implementations will disagree on any non-trivial request line

**Where.** `NONCE-DESIGN.md:57-59` (§4 AAD suffix) and `record.ts:131-133` (`restTargetHash(method, path, query)` = `sha256(\`${method}\n${path}\n${query}\`)`); `record.ts:127-129` comments only "query WITHOUT the leading `?`, empty when none." Nothing pins percent-encoding, case, parameter order, or which representation each side reads.

**Failure scenario.** This is the ctxId-encoding trap (M1) one layer down, and it is not yet closed. The client seals `target = sha256("GET\n/api/conversations/a%2Fb\nlimit=50&offset=100")`. The server must reproduce the *same bytes*. If X-server computes the target from Hono's `c.req.path` (percent-*decoded* → `/api/conversations/a/b`) or re-serializes the parsed query (order/`+`-vs-`%20` may differ), the hashes differ and every such request fails to authenticate — a legitimate request, rejected, with only `E2EE_SEAL_FAILED` to debug. Method case (`GET` vs `get`), a trailing `&`, and duplicate params are the same class. The frozen AAD format cannot fix this after the tag.

**Fix (before the tag).** §4/§13 must pin the exact string: "the raw request-target as it appears on the wire — no percent-decoding, no re-ordering, method upper-case, `query` the raw substring after `?` (empty if none)." State that X-server reads `c.env.incoming.url` (raw) and never Hono's decoded `c.req.path`. Add a fixture vector whose path contains `%2F` and whose query has two params, so the trap is pinned by bytes.

#### N-M3 — the `/open` rate limit keys on `remoteAddress`, which is `127.0.0.1` behind the tunnel, so it is a global 5/min bucket that legitimate devices trip during the re-open storm §8 itself describes

**Where.** `e2ee.routes.ts:170` (`rateLimit(c.env.incoming?.socket?.remoteAddress ?? "unknown")`); `rate-limit.ts` (5/min per key); the streamer reads **no** forwarded-IP header (verified: no `cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` anywhere in `src`), and the tunnel connects to `http://127.0.0.1:8766` (`CLAUDE.md`, cloudflare guide), so every tunneled request presents `remoteAddress = 127.0.0.1`. `checkExchangeRateLimit` on `origin/main` has the same property — this is inherited, not newly introduced, but H1 now *leans* on it.

**Failure scenario.** Two failure shapes. (1) The bound H1 relies on to blunt msg1 replay is per-IP; behind the tunnel every caller is `127.0.0.1`, so it is one global 5/min bucket that cannot tell an attacker from the fleet — the real bound there is the per-device cap, not the rate limit, and the design should say so rather than cite the rate limit as the H1 defense. (2) Worse, it is a self-DoS on the exact path §8 describes: after a streamer restart every pinned device's next request is `E2EE_CTX_UNKNOWN` and each re-opens (socket + REST = 2 `/open`s). Three or more devices behind one tunnel is ≥ 6 `/open`s in the same minute against a global bucket of 5, so some devices get `429` on their recovery handshake, retry, and `429` again until the window rolls — a restart wedges the fleet's recovery for up to a minute.

**Fix.** State in §8/§10 that the per-IP rate limit is effective only on the LAN leg and that the per-device cap is the bound behind a tunnel; and either raise/rework the `/open` limit so a legitimate multi-device re-open storm does not trip it (e.g. rate-limit per authenticated device *after* the handshake rather than per source IP before it, since the handshake already proves a paired device), or trust a configured forwarded-IP header when the deployment sets one. Do not present the rate limit as the H1 defense it largely is not behind the tunnel.

#### N-M4 — no committed `/open` interop vector (B1 residual): the psk-less `IK` transcript is distinct from the only committed vector

**Where.** `NONCE-DESIGN.md §11:268` and §16:373 both call for `/open` vectors; the only committed handshake fixture is `__tests__/fixtures/noise-ikpsk1-vectors.json` (the pairing `IKpsk1` transcript, public since #631). `e2ee-open-route.test.ts` drives the psk-less handshake *live* through `writeMessage1`/`readMessage2`, not from a committed vector.

**Failure scenario.** X-client writes the psk-less `IK` + `threadbase-e2ee/1 open` prologue independently, in `@stablelib`, and has nothing to check it against byte-for-byte — the pairing `IKpsk1` vector uses a different protocol name (seeds `h` differently), a different prologue, and a PSK step. The Phase-2 lesson is explicit that a second independent implementation is exactly where a shared misreading hides under correct-looking output; here there is no fixture to even reach agreement on. Discovered at X-client's interop run, weeks after the tag.

**Fix.** Commit an `/open` handshake vector alongside the record vectors: server static key, client static key + ephemeral, the two message bytes, and the resulting `handshakeHash` and `{clientToServer, serverToClient}` keys — enough for the client to reproduce the transcript. Name its path in the W1a PR body (§16 already requires this for the record fixtures).

#### N-M5 — the committed record fixture is positive-only (M11 residual)

**Where.** `__tests__/fixtures/e2ee-record-vectors.json` carries `records[]` of positive frames only; §16:368-373 requires committed negative vectors (each AAD field mutated → fails, reflected direction → fails, counter gap/repeat → sequence violation, plus the pairing-vector-against-open-prologue failure). `e2ee-record.test.ts` exercises negative *cases* but computes them in-process; the client consumes the *fixture*.

**Failure scenario.** A client that reproduces every positive vector byte-for-byte can still accept a mutated AAD field, a reflected frame, or a counter gap — the "correct output above a defect" shape Phase 2 named. The streamer's own negative tests do not travel to the client; only the fixture does.

**Fix.** Add the §16 negative vectors to the committed fixture, each tagged with the rejection it must produce, so X-client's suite is forced to prove its implementation *rejects*, not only that it *reproduces*.

#### N-M6 — `RestResponseSealer` silently evicts the oldest accepted counter at 1024 outstanding, so its later response throws a server-fault the client cannot recover

**Where.** `record.ts:388-394` (`accept()` evicts the oldest when `outstanding.size > MAX_OUTSTANDING` = 1024); `record.ts:401-407` (`seal()` throws `E2EE_SEAL_FAILED` when the counter is not outstanding).

**Failure scenario.** Under >1024 concurrent unanswered requests in one REST context, `accept()` drops the oldest accepted counter; when that request's handler finally produces a response, `sealResponse` → `seal()` finds no outstanding counter and throws `E2EE_SEAL_FAILED` — which §9 defines as a *server-side fault* with no client recovery path (only `E2EE_CTX_UNKNOWN` re-handshakes). Liveness, not security; the bound is generous and the trigger unlikely, but the failure mode is exactly the "server-fault the client can't recover" that ruling B3 removed from the rekey path, reappearing on a saturation edge.

**Fix.** Small: when eviction happens, the request whose counter is dropped should get a plaintext error (or a `E2EE_CTX_UNKNOWN`-class retryable code), never a sealed-response attempt that dead-ends. Or document that the REST middleware must bound in-flight requests below `MAX_OUTSTANDING` and shed load with a retryable status before it reaches this. One sentence in §13(a).

#### N-M7 — per-device eviction is an immediate destroy by creation age, with no drain and no used/provisional preference

**Where.** `context.ts:288-301`. `open()` sorts the device's same-kind contexts by `createdAt` and `destroy()`s the oldest beyond the cap **immediately**. §6:93 and §8:88 promise a "short drain" ("the server keeps serving the old context for a short drain and then answers `E2EE_CTX_UNKNOWN`"; "retired at its provisional TTL if it was never used, or on the drain otherwise").

**Failure scenario.** Two edges. (1) **No drain:** opening a 3rd REST context (cap 2) destroys the oldest *the instant* the 3rd is registered; a request in flight on that evicted context gets `E2EE_CTX_UNKNOWN` mid-transaction, not the "short drain" the design promises. With cap 2 this needs two overlapping re-opens (a foreground racing a `CTX_UNKNOWN` recovery), so it is race-only, but the code contradicts the prose. (2) **Age, not use:** eviction is strictly oldest-created; in the pathological ordering where the oldest context is the actively-used one and two newer ones are provisional-unused, the code destroys the live context and keeps the unused ones — the opposite of "the newer wins … retired if it was never used."

**Fix.** Match the code to §6/§8: evict provisional/unused contexts before live/used ones, and implement the "short drain" (mark for deletion at `now + drainMs`, sweep later) rather than an immediate `destroy` — or, if immediate destroy is the real decision, correct §6/§8 to say so and drop "short drain."

### LOW

#### N-L1 — §13(b)'s "no `Authorization` on a sealed request" is safe, but the D-9 "hidden from Cloudflare" rationale only holds when Cloudflare Access is off

**Where.** `NONCE-DESIGN.md §13(b)` and the D-9 rationale (`design.md §3.6`, "so the credential travels sealed"); `docs/guides/remote-access/cloudflare.md:174` ("requests without an `Authorization` header receive `401` from the CF edge — including `/healthz`") and `:159` ("if Cloudflare Access requires interactive login, the mobile app's plain HTTPS request will get a `302` … pairing fails").

**Scenario, stated so nobody re-introduces the leak.** §13(b) removes `Authorization` from sealed requests to keep the bearer off the wire. This is correct and safe on the deployments E2EE actually runs over: a quick tunnel (anonymous), LAN, a Bearer-at-the-streamer host, or a Service-Token'd tunnel (which uses `CF-Access-Client-*` headers, not `Authorization`). It is **not** compatible with a named tunnel behind *interactive* Cloudflare Access, which 401s any request lacking `Authorization: Bearer` at the edge — but that topology already doesn't support the mobile client (the guide says so), so E2EE breaks nothing new. Two things follow: (1) the D-9 claim that the credential is "hidden from Cloudflare" is only true when Access is off — when a Service Token or interactive Access is on, Cloudflare's edge sees a credential on every request regardless, so §13(b) buys secrecy from the *tunnel data plane*, not from Cloudflare-the-company; (2) nobody should "fix" a 401-behind-Access by adding `Authorization` back to sealed requests, which would reintroduce the very leak §13(b) closes — the right answer is Access-off or a Service Token for E2EE devices. Worth one sentence in §13(b) and a note to Group R (rollout topology) and Group D (see below).

#### N-L2 — the key-hygiene fix protects the two wrapper classes but not the `HandshakeKeys` object that carries the same bytes

Covered under Q3 below; recorded here so it appears in the severity list. The `hideKey` fix (`record.ts:498`) makes `RecordState.k` and `RestResponseSealer.k` non-enumerable, but the `HandshakeKeys` value (`{clientToServer, serverToClient}`) that flows from the handshake into `createRecordState` is a plain object with enumerable buffers and is not wrapped; today no route logs it, but nothing enforces that.

---

## Answers to your five questions

### (1) Did the fixes resolve cleanly, or introduce a new contradiction?

Mostly clean. The three surviving contradictions are all internal to **NONCE-DESIGN §8**, and all are B3/M1 edits that did not reach the tables:

- **§6-as-B vs §8's lifetimes:** §8:140 still lists "Rekey … 1 GiB sealed, or client foreground" for REST, and §8:154 still says "§6, pending." **Real, current — N-M1.** (The propagation to `design.md` §3.3/§4.3 and `mobile-design.md` §4.3 is, by contrast, complete and correct — I checked every surviving "rekey" mention.)
- **§8 vs §12 on ctxId:** §8:125 still gives the HKDF derivation §12 abolished — **N-M1.**
- **§13 vs §4/§5 R4:** **no contradiction.** `RestResponseSealer` is a clean distinct class; R4 governs sequence counters and the response echo is explicitly not one; §14 forbids `Authorization` on a sealed request and a sealed response to a rejected request; §15's table carries no rekey row and the fixture carries no rekey vector (both verified). §13 and §5 R4 are consistent.

New contradictions the revision *introduced*: N-H1 (advertised 24 h vs provisional 30 s) and N-M7 (code's immediate-destroy vs §6/§8's "short drain").

### (2) Anything in §11 (`/open`) or §12 (encodings) two implementations could still read differently?

- **§11:** the handshake itself is now well-pinned (name, prologue, no PSK) and doubly tested (prologue isolation + `protocolName` assertion). The residual is **N-M4: no committed `/open` transcript vector** — the psk-less `IK` is a distinct transcript from the committed `IKpsk1` one, so X-client has no byte anchor.
- **§12:** the table pins ctxId/seq/expiresAt/ticket/opcode/casing — good. The gap is **N-M2: the REST target string** (`method‖path‖query`) is *not* in the encodings table and is the one field computed independently on both sides from a request line that Hono decodes and re-serializes. That is the highest-probability §12-class interop failure remaining. Also worth a line in §12: `X-TB-Ctx` is base64url — confirm X-server compares it as the *string* (not re-decoded/re-encoded), since a client that pads or a server that decodes-then-reencodes could disagree on the 22-vs-24-char spelling.

### (3) The stop-work closure — exposure, sufficiency, and a class the mutation misses

- **Exposure: I independently confirm it was nil.** I grepped both traffic keys (and their hex and base64url forms) across both worktrees, `tracks/`, the scratchpads, and the task/log outputs: the only hits are the two committed fixture files (`noise-ikpsk1-vectors.json`, `e2ee-record-vectors.json`) — the hex hits elsewhere are my *own* review command's echo in this session's task output, and the `<Buffer` hits are npm-cache tarballs, not evidence. I also verified the record vectors' `clientToServerKey`/`serverToClientKey` are byte-identical to the `#631` handshake vector's `split()` output, public on `origin/main` since `8ed91593`. Nothing non-public was exposed.
- **Fix sufficiency:** sound for the leak that occurred. `hideKey` makes `k` non-enumerable and the test proves `util.inspect` (default), `Object.keys`, and a leaky control all behave; `JSON.stringify` was never the path (it throws on the `bigint`). pino and vitest's differ both walk enumerable own-properties, so they are covered too.
- **Classes the mutation does not cover** — three, worth one assertion or a note each:
  1. **`util.inspect(x, { showHidden: true })`** prints non-enumerable properties. A debug logger or a REPL session with `showHidden` would still surface `k`. The test uses default `inspect`; the guard is enumerability, which `showHidden` deliberately defeats.
  2. **Direct interpolation** — `${this.k}` or `String(this.k)` in a *future* error message, log line, or template. Non-enumerability does nothing against direct access. `RecordError` messages are clean today (I checked — they name lengths and codes, never the key), but nothing structural prevents a later edit from interpolating a key into an error the `/open` 500 path then logs.
  3. **The `HandshakeKeys` object (N-L2)** carries the *same* key bytes between `writeMessage2`/`respond` and `createRecordState`, as enumerable buffers, unwrapped. The `/open` 500 path logs `err` (not `keys`) today, so it is clean, but it is unenforced — the one place a key could still reach a log is an error thrown *while the raw `HandshakeKeys` is in scope*.
  Recommendation: add one assertion that a `HandshakeKeys` value renders without its key bytes (or is never passed to a logger), and add the two lines above to ADVERSARY-BRIEF-ADDITIONS row 13 ("inspect with `showHidden`; force the `/open` 500 path and grep its `err` for key bytes").

### (4) F's and D's plans

**Group F — sound, no blocker.** The #759 evidence map is honest (GAP where a criterion is only proven one layer down, HOLDS where it is real), the criterion-1 interop run against the pinned streamer is the right bar, and #831 correctly reduces to "converge on `ServerEditModal`, port the 401/500/network/localhost-hint matrix from `onboarding-flow.test.tsx` onto `settings-flow.test.tsx` *before* deleting `AddServerScreen`, with one ported case's mutation seen red." The isolated second reader already ran. One thing to hold F to, which the plan itself flags as an open check: confirm `ServerEditModal` in add-mode actually reaches the same fetch-error surface (option a) before relying on it — otherwise the ported matrix is testing a different code path than the one being deleted.

**Group D — sound, with one coverage gap to name (ties to N-L1).** The rig isolation is exemplary: `HOME` from first boot (not `THREADBASE_CONFIG_DIR` alone, per the prior program's incident), the `lsof` isolation proof, an ephemeral quick tunnel rather than the named one, the scrub rules, and a shutdown checklist against a start-of-session record. The gap: **D2's function-over-tunnel leg uses a quick tunnel (anonymous, no Access), and so does every streamer test — so "E2EE transport over a named tunnel behind Cloudflare Access," the production `tb-pc.rbv1000.win` topology, is exercised by nothing.** Given N-L1 (`/api/e2ee/open` and every sealed request are credential-less at the `Authorization` layer, which interactive Access 401s at the edge), D or R should either add a row proving E2EE works over the production Access topology (Service Token, or Access-off for the streamer hostname) or record the explicit decision that E2EE devices require Access-off / a Service Token. Otherwise the first real-world E2EE connection over the production tunnel is the test.

### (5) Additions to the adversary brief

To `tracks/W/ADVERSARY-BRIEF-ADDITIONS.md`, W1a rows:

- **REST provisional cliff (N-H1):** open a REST context, wait past 30 s without a request, then send the first sealed request → expect `E2EE_CTX_UNKNOWN`; confirm nothing in msg2 warned the client the 24 h was conditional.
- **REST target canonicalization (N-M2):** seal a request for a path containing `%2F` and a two-param query; serve it with the path percent-decoded and the params reordered → expect the target hash to fail unless both sides use the raw wire request-target.
- **`/open` rate-limit collapse (N-M3):** drive N ≥ 6 `/open`s from one source address (the tunnel case) → confirm whether legitimate multi-device recovery trips the global 5/min bucket; measure the re-open-storm shape after a simulated restart.
- **Eviction (N-M7):** open 3 same-kind contexts for one device with the oldest actively in use → record which is destroyed, and whether an in-flight request on an evicted context is dropped without a client-visible retryable code.
- **`RestResponseSealer` saturation (N-M6):** accept >1024 request counters, then seal the response for the evicted oldest → expect a retryable outcome, not a dead-end `E2EE_SEAL_FAILED`.
- **Key hygiene, extended (Q3):** `util.inspect(state, { showHidden: true })`; force the `/open` 500 path (`writeMessage2` throw) and grep its logged `err` for key bytes; inspect a raw `HandshakeKeys`.

To the "Later tracks" section: X-server must read the raw request-target (`c.env.incoming.url`), never Hono's decoded `c.req.path`, when computing the REST target hash (N-M2).

---

## Explicit "no finding"

- **Record-layer crypto (§2–§5, §7) and `record.ts`:** no finding. Nonce, AAD (30-byte + 32-byte REST suffix), R1–R4, authenticate-before-sequence, `bigint`, `2^64−1` refusal-then-destroy, the `initialCounter` test seam, and the reflection/renumber/wrong-channel rejections are all correct and correctly tested. The `RestResponseSealer` echo design is sound (only its saturation edge, N-M6, is worth a sentence).
- **`/open` route hardening (§10):** the order (rate-limit → bounded read → base64 bound → handshake → fail-closed-on-row) is correct; the bounded reader drains-and-drops past the cap; absent/revoked both answer `E2EE_DEVICE_REVOKED` and neither is `E2EE_CTX_UNKNOWN`; the disabled server 404s. No finding beyond N-M3 (the rate-limit's key).
- **The 426 helper (`refuseUnsealedIfPinned`):** correct, and its one honest limit — a pinned device presenting the *shared* key resolves to `legacy` and is not caught here — is documented in the code (`context.ts:469-475`) and is the accepted residual from `design.md §2.6` (the shared key is admin-equivalent; that is stage-3's problem). No new finding.
- **The constant collapse (§4, M7):** re-exports, canonical `protocol.ts`, a test that the names are one value, and the version-coupling caveat written down. Clean. The alias is correct by construction (`export const E2EE_EXCHANGE_VERSION = E2EE_PROTOCOL_VERSION`), so drift is impossible; the test is belt-and-suspenders and now exists.
- **`summarizeQuery` widening (§10, W's point 3):** the case-insensitive sensitive-key set + the `limit=50` control test are correct; redacting a param named `token`/`key`/`ticket`/`apikey` by rule is the safe default and I found no legitimate non-secret GET query param that this newly redacts.
- **The design-doc corrections (§17):** `design.md` §1.3, §3.3, §3.4, §4.3 and `mobile-design.md` §4.3 are all updated correctly and completely for Alternative B and the two-context model — I verified every surviving "rekey" string; the only stale ones are inside NONCE-DESIGN §8 itself (N-M1).
- **The stop-work closure:** exposure nil (independently confirmed), fix sufficient for the leak that occurred (residual classes in Q3).

---

## What this review did not do

No code executed, no test run (read-only, and the tree is mid-edit). N-M3's "no forwarded-IP header is read" was verified by grep over `src` on `origin/main`; the tunnel-origin `127.0.0.1` is from the repo's cloudflare guide, not a live capture. The `@hono/node-ws` 100 MiB default (M3, still open as a W1b item) is read from the installed `1.3.1` in the implementer's `node_modules`, not the upstream source. Because the sub-agent is editing live, any file cited here may have moved again after 03:1x — every citation was current at my last re-verify, and the transients I caught mid-edit are listed in the method note rather than reported as findings.
