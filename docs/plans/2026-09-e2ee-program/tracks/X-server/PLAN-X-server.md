# Group X-server — the streamer REST envelope (PLAN)

**Session:** `e2ee-Xserver-opus5-high [37e02a]`, Opus 5 / high.
**Owner:** `e2ee-owner [ddde5e]` — ref recorded at first contact, 2026-08-29 22:30 IDT.
A later name carrying `[ddde5e]` is a rename I may accept alone; a new ref needs the user's confirmation in my pane.

**Status:** **APPROVED WITH AMENDMENTS, 2026-08-29 23:20 (day 2)** by `e2ee-owner [ddde5e]`; the independent reviewer AGREED on all seven questions, with the amendments folded into §3 below.
The bounded `context.ts` seam edit is GRANTED (§2). Slice 1 (window + seam + campaign) was dispatched on the earlier partial GO and is in flight; the shape-dependent work is now unblocked.

---

## 1. Arrival — preconditions re-verified

| Check | Result |
|---|---|
| `git ls-remote --tags origin v1.71.0` | `f95150cc03c33a165ba221f694206a5b11636001` ✓ |
| `origin/main` after `fetch --tags` | `f95150cc` — **identical to the tag**; this is my pin |
| `v1.71.0:specs/end-to-end-encryption/NONCE-DESIGN.md` | present, 67 111 bytes, §13 "The REST envelope contract" at line 366 ✓ |
| `v1.71.0:src/e2ee/context.ts` | present, 27 425 bytes ✓ |
| `v1.71.0:src/e2ee/record.ts` | present; `unsealUnchecked` at `:446`, REST-request-channel guard at `:448` ✓ |
| `v1.71.0:src/e2ee/protocol.ts` | four codes frozen at `:50-53` ✓ |
| `v1.71.0:__tests__/fixtures/e2ee-record-vectors.json` | `restAadLayout`, `restTargetCanonicalization`, `restResponse`, `negative` (12 cases) all present ✓ |
| Worktree | `.worktrees/feat/e2ee-rest-envelope`, branch `feat/e2ee-rest-envelope`, HEAD `f95150cc`, `node_modules` symlink to the root checkout ✓ |
| Node | `v24.15.0` (nvm) ✓ |
| Biome | **installed 2.5.3, lockfile pins 2.5.10** — the symlinked tree does not match the pin. The lint gate runs `npx --yes @biomejs/biome@2.5.10 check .`, and the exit code I report is that one. |

**One deviation from the kick-off's wording, reported rather than smoothed over:** the kick-off calls the design "rev11". `NONCE-DESIGN.md` at the tag carries **no rev marker** — its header reads "design of record for Phase 3", and §17 lists the corrections it makes. I am treating **the file at commit `f95150cc`** as the contract; there is no version string to match against, so identity is by commit.

---

## 2. BLOCKING — this track cannot be built without editing `src/e2ee/context.ts`

The kick-off says: *if you need to change `record.ts` or `context.ts`, stop and tell me before writing a line.* I need to change `context.ts`. Here is exactly why, and exactly how little.

`context.ts:183` carries W1a's own comment:

```
// ─── SEAM: the REST sliding window goes here ──────────────────────
// This receive state is STRICT today ... The REST track replaces the
// acceptance rule on THIS state and nothing else
```

and `Context.unsealRequest` (`:225`) reads:

```ts
const state = this.receiveState(CHANNEL_REST_REQUEST);
const counter = state.counter;
const plaintext = state.unseal(frame, target);   // ← STRICT
sealer.accept(counter);
```

**There is no way to build the window outside this method.** `RestResponseSealer` is `#responses`, a private field; `accept()` has no public reach. If my middleware calls `context.receiveState(CHANNEL_REST_REQUEST).unsealUnchecked(...)` itself and runs its own window, it can never arm the sealer, so every subsequent `sealResponse` throws `no accepted request is waiting on that counter`. `unsealUnchecked` exists, is exported, and **has no production caller at the tag** — it is the seam left for me, and the seam is reachable only from inside `context.ts`.

**The smallest change that opens it** — this is the whole `context.ts` diff I am asking for:

1. one new private field on `Context`: `readonly #window = new RestReceiveWindow()` (REST kind only);
2. inside `unsealRequest`, `state.unseal(frame, target)` becomes `state.unsealUnchecked(frame, target)`, then `this.#window.admit(counter)` (which throws the rejection), then the existing `sealer.accept(counter)` and `markUsed()`, both unchanged;
3. the SEAM comment replaced by what the code now does.

The window itself — arithmetic, bitmap, tests — lives in a **new file I own**, `src/e2ee/rest-window.ts`. `context.ts` gains one import and about ten changed lines inside one method. `record.ts` is not touched at all.

**Deliberately preserved:** acceptance stays welded to a successful unseal. `context.ts:230` says why — *"Acceptance is recorded ONLY on the success path, which is what makes §13(a) enforceable rather than a rule a middleware has to remember"* — and that is the property I am least willing to move into my middleware.

**Collision check with W1b, done rather than assumed.** W1b's `context.ts` diff is `TICKET_HEADER` at the top (~line 51) and `DeviceLookup` / `DevicePrincipal` / `authenticateContext` appended after line 656. Mine is lines 155–240. **No textual overlap.** Whoever merges second still rebases and re-runs the whole campaign.

I have written no code. Awaiting the owner's go.

---

## 3. Design questions — ANSWERED

Asked with my opinion (standing rule), taken by the owner to the independent reviewer, **AGREE on all seven** with the amendments below. These are now the contract, and X-client must match them.

### Q1 — `authenticateContext` must not destroy the context *(the one I would not have shipped)*

**Problem I raised.** W1b's helper ended every refusal, 401 and 403 alike, in `contextRegistry().destroy(ctxId)`. Right for a single-use ticket; wrong for a 24 h REST context addressed by a plaintext header. Benign case: a migration-era client that keeps sending `Authorization` beside `X-TB-Ctx` destroys its own context on every request and re-handshakes forever against a 5/min limit, with `E2EE_CTX_UNKNOWN` as the only diagnostic. Hostile case: anyone holding any valid credential — a second paired device, or the shared api key, which the helper deliberately counts as a mismatch — sends `X-TB-Ctx: <victim>` plus their own bearer and destroys a victim's context at will, into the fleet-wide 30/min `/open` bucket §8 already calls a fleet-wide outage.

**ANSWERED.** `authenticateContext` becomes a **pure verdict — it never destroys.** The caller applies the effect.

> **The discriminator, stated so it generalises:** destroy on a fact in **our own database that the attacker cannot forge** (`revoked_at`); never on **a header the attacker supplies** (a mismatched credential).

REST caller's effects:

| Verdict | Effect |
|---|---|
| revoked / no row | **seal the 403 with the still-live context, THEN destroy** — in that order |
| credential names another device (shared key included) | **sealed 401, context left intact** |

**The seam, settled 2026-08-29 23:5x and locked by slice 2a** (I proposed it; the owner and reviewer adopted it, and W's implementer has it verbatim):

```ts
export type E2eeContextAuth =
  | { ok: true; principal: DevicePrincipal }
  | { ok: false; reason: "device-revoked" | "credential-mismatch" | "no-device-store" };

export function authenticateContext(args: {
  context: E2eeContext;              // the RESOLVED context, not a ctxId
  devicesRepo: DeviceLookup | null | undefined;
  presented: string | undefined;
}): E2eeContextAuth;
```

- **A `reason` discriminant, never a `destroyContext` boolean and never `status`/`body`.** The helper states the fact it found; the HTTP mapping and the destroy are the caller's policy. A boolean would bake REST's policy into a helper W1b also consumes, and a status would do the same for the wire.
- **The helper never destroys.** REST destroys on `device-revoked` only.
- **`device-revoked` is reached by a missing row as well as a set `revoked_at`** (§10: absent is not the same as invalid, and neither is success).
- **`credential-mismatch` includes the shared API key** — a credential naming *no* device is a mismatch, not an exemption.
- **An unreadable or absent device store is `no-device-store`** — a refusal, not a throw and never a success (the sibling `refuseUnsealedIfPinned` defect an adversary round found: *a downgrade guard that defaults to allowing the downgrade is not a guard*) — and it maps to a **sealed 503 `{ error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }` with the context intact, never a 403.** §9 makes `E2EE_DEVICE_REVOKED` a hard failure the client must never retry, so answering a disk fault with it would tell the phone its device was revoked because our storage blinked. W's WS caller answers identically (`auth.middleware.ts:132-139`), and it is not a new invention: `devices.routes.ts:59` already answers a missing device registry with the byte-identical body.
- **`DevicePrincipal` is an intersection, imported, never re-derived**: `Principal & { kind: "device"; deviceId: string }`. `Extract<Principal, { kind: "device" }>` yields `never`, because `Principal` is one interface with `kind: "device" | "legacy"` and an optional `deviceId` rather than a discriminated union — and the resulting error surfaces far from its cause.
- **`principal.deviceId === context.deviceId` always**, because the principal is built from the context's row and never from the credential.

**Caller-side ordering (REST):** `unsealRequest` succeeds → the counter is committed and exactly one sealed response is owed → ask for the verdict → on refusal seal the body with the still-live context, then destroy only if `device-revoked` → on success set the principal, run the capability check (a 403 here is sealed too), then `next()`.

### Q2 — bodiless requests: `X-TB-Env`

**ANSWERED, with two amendments I did not ask for and want on the record.**

The sealed empty record — 30-byte header + 16-byte tag = 46 bytes, target hash in the AAD and never transmitted — travels **base64url in `X-TB-Env`** for any method with no body. `X-TB-E2EE: 1` stays a pure marker.

- **A request presenting both a sealed body and `X-TB-Env` is rejected.** One envelope source per request; "which one wins" must not be a question a parser answers at a trust boundary.
- **The length bound runs on the header string before base64url decode**, not only on `Content-Length` — the same rule `pair-request.ts` already applies to `e2ee.noise` (`MAX_BASE64_CHARS` on the encoded length, because `Buffer.from(s, "base64")` allocates in proportion to `s`). A `Content-Length`-only bound does not see a header.

### Q3 — the ndjson `stop` stream: buffer it

**ANSWERED: buffer, seal once at `end`.** Multi-record is unavailable, not merely undesirable: the AAD is fixed-width with no index field, `RestResponseSealer` permits exactly one seal per accepted counter, and §13(a) forbids a second sender counter for responses — per-line sealing *is* nonce reuse under `(k_s2c, 2‖counter)`.

**Cost, corrected from my own first statement of it.** I wrote "up to 5 s later", which overstates it. There is **no added wall-clock latency**: the response still completes when the terminal event fires. What a sealed client loses is the *early* arrival of the intermediate `stopping` line — it arrives together with the terminal event instead of ahead of it.

### Q4 — multipart: verified absent, no path written

`git grep -i multipart v1.71.0 -- src docs` returns nothing. **The reviewer corrected its own earlier M8 on this point:** the streamer's uploads are raw-body POSTs, not multipart. I state the verified absence in the PR and write no `Content-Type`-preserving path with no caller.

### Q5 — the sealed 304, and the rule that generalises it

**ANSWERED, and it became the better answer once I priced it properly.** My first proposal was to strip `If-None-Match`/`If-Modified-Since`. The owner leaned symmetric, and the symmetric answer is *cheaper*, because it is the same 46-byte header-carried frame as Q2 in the other direction — one encode/decode helper serves both.

> **FROZEN RULE.** *A sealed record whose HTTP framing cannot carry a body travels base64url in `X-TB-Env`, in either direction; the body carries it whenever the framing allows one.*

The 304 carries its one accepted response, empty, bound to the request counter. 304 and bodiless requests then need no special case beyond "look in the header". Concrete rather than hoped-for: **one** `writeHead(304, …)` site in the tree (`conversations.handlers.ts:739`), and the only other bodiless response is the CORS preflight `204` (`cors.middleware.ts:72`), answered before this middleware runs. One caller, one test.

### Q6 — the status code stays outside the envelope

**ANSWERED: accepted.** Consistent with D-7. **Residual stated rather than discovered:** an on-path attacker can rewrite a sealed 200 into a 5xx — denial, never forgery, since the body still authenticates or does not arrive.

### Q7 — statuses for the four frozen codes

**ANSWERED: the map as proposed.** `docs/compatibility/tb-mobile.md:98` maps `401 → AuthError (re-auth UI)` and `404 → NotFoundError`, so the recoverable codes must avoid both.

| Condition | Status | Code | Body |
|---|---|---|---|
| ctx unknown / expired / not a REST context / counter below the window | **409** | `E2EE_CTX_UNKNOWN` | plaintext |
| replay (bit already set); `X-TB-Seq` ≠ the authenticated counter | **400** | `E2EE_SEQUENCE_VIOLATION` | plaintext |
| AEAD failure, malformed envelope, both envelope sources present | **400** | `E2EE_SEAL_FAILED` | plaintext |
| body or `X-TB-Env` over the bound | **413** | `E2EE_SEAL_FAILED` | plaintext |
| pinned device, no valid `X-TB-Ctx` | **426** | `E2EE_REQUIRED` | plaintext, via `refuseUnsealedIfPinned` |
| device row missing or revoked | **403** | `E2EE_DEVICE_REVOKED` | **sealed**, then destroy |
| credential beside `X-TB-Ctx` naming another device | **401** | — | **sealed**, context intact |
| device registry absent or unreadable (`no-device-store`) | **503** | `STORE_UNAVAILABLE` | **sealed**, context intact — transient, and not in mobile's status map, so it does not trip the re-auth UI |
| capability missing | **403** | `MISSING_CAPABILITY` | **sealed** |
| the handler's own 2xx/4xx/5xx, including through `onError` | as the handler set it | — | **sealed** |

**A plaintext 409 pre-unseal is distinguishable from a handler's sealed 409** by its sealed-ness and its `code` — the reviewer's point, and the reason the status map does not need a unique status per condition.

**The line, as one sentence a test asserts:** *every refusal before a successful `unsealRequest` is plaintext; everything from a successful `unsealRequest` onward is sealed.* Not a rule the middleware remembers — `accept()` runs only inside a successful unseal, so a rejected request is **structurally** unable to receive a sealed body.

### Two structural notes, endorsed

- **Acceptance stays inside `unsealRequest`.** No refactor moves it out. `context.ts:230`: *"Acceptance is recorded ONLY on the success path, which is what makes §13(a) enforceable rather than a rule a middleware has to remember."*
- **`unsealRequest` must remain the SOLE caller of `sealer.accept`.** Established during slice 1: `admit()` can never accept a counter that `accept()` then throws on, because the window and the response sealer keep high-water marks over the same counter sequence, in the same order, at the same width — but that holds *only* while one call site advances both. A second caller anywhere desynchronises the two marks and re-opens the gap, and the symptom would be an accepted request that can never be answered. Stated here because it is a constraint on the middleware slice, not a property of the window.
- **The capability check runs on the context principal.** `authMiddleware` today sets `c.set("principal", …)` *after* the capability check and not at all when `requiredCapability` returns null, so "skip when a principal is already set" must never skip the capability check — that would hand a read-only device full write authority the moment it seals. Its mutation is kept.

---

## 4. The middleware plan

### 4.1 Order in the chain

```
app.use("*", requestLog)            unchanged — logs method/path/status/qs/bytes, never a body
app.use("*", corsMiddleware)        unchanged — answers OPTIONS preflight before any envelope exists
app.use("*", e2eeEnvelope(deps))    NEW — src/api/middleware/e2ee-envelope.middleware.ts
app.use("*", authMiddleware(deps))  + a REST X-TB-Ctx branch (my half; W1b owns the /ws branch)
```

**One middleware, not a pair.** It installs the response interception on `c.env.outgoing` *before* `await next()` and seals after — the same shape `countResponseBytes` already uses. A separate seal middleware would be a second place to forget the one-response rule.

After `corsMiddleware` because a preflight must be answered without a context; before `authMiddleware` because D-9's whole point is that the credential travels sealed.

### 4.2 The rejection ladder, cheapest rung first

| # | Rung | Cost | Outcome |
|---|---|---|---|
| 1 | `X-TB-E2EE` absent | one header read | `next()` — plaintext path untouched, old clients unaffected |
| 2 | `X-TB-Ctx` not 22 base64url chars | length + charset test, no decode | 409 `E2EE_CTX_UNKNOWN` |
| 3 | **`registry.get(ctxId)` → null** | **one `Map.get` + a deadline compare — no allocation, body never read** | 409 `E2EE_CTX_UNKNOWN` |
| 4 | `context.kind !== "rest"` | one field compare | 409 `E2EE_CTX_UNKNOWN` |
| 5 | `X-TB-Seq` not a decimal `bigint` in `[0, 2^64)` | one regex + `BigInt` | 400 `E2EE_SEQUENCE_VIOLATION` |
| 5a | **both a body-carried envelope and `X-TB-Env` present** | one header presence test | 400 `E2EE_SEAL_FAILED` — one envelope source per request; "which one wins" is not a question a parser answers at a trust boundary (Q2) |
| 6 | `Content-Length` **or the `X-TB-Env` string's own length** over `MAX_REST_ENVELOPE_BYTES` | one header parse, **before a byte is read and before any base64url decode** | 413 |
| 7 | bounded read; abort past the cap while draining, memory flat | O(cap) | 413 |
| 8 | `unsealUnchecked(frame, restTargetHashFromUrl(method, c.env.incoming.url))` | one bounded ChaCha20 pass | 400 `E2EE_SEAL_FAILED` |
| 9 | window: above → advance; inside & clear → set; **set → replay**; below → unprovable | O(1) bitmap | 400 `E2EE_SEQUENCE_VIOLATION` / 409 `E2EE_CTX_UNKNOWN` |
| 10 | `X-TB-Seq` compared to the **authenticated** counter | one compare | 400 `E2EE_SEQUENCE_VIOLATION` |
| 11 | `sealer.accept(counter)` — arms exactly one response | O(1) | — |
| 12 | `authenticateContext(...)` — a **pure verdict**; this caller applies the effect | one device-row read | revoked → **seal the 403, then destroy**; mismatch → **sealed 401, context intact** (Q1) |
| 13 | capability check | O(1) | 403, **sealed** |

Rungs 1–5 touch no body at all. **Rung 3 is the D-9 property the adversary measures** and the mutation "move the lookup below the body read" must turn red.

**The rung-6 bound runs on the *encoded* length.** `pair-request.ts` sets the precedent and states the reason: `Buffer.from(s, "base64")` allocates in proportion to `s`, so testing the decoded size means performing the allocation the bound exists to prevent. A `Content-Length`-only bound never sees a header-carried envelope at all.

**`X-TB-Seq` is never acted on before rung 8.** §5's ordering rule exists so `E2EE_SEQUENCE_VIOLATION` is a claim about the *peer*: checking the plaintext counter first would let anyone who read one header get a sequence violation logged against a device that did nothing, and it buys no DoS protection (the same attacker can as cheaply send the *right* counter). So the header is required, and compared to the authenticated counter afterwards.

### 4.3 The window

`src/e2ee/rest-window.ts` — `RestReceiveWindow`, an RFC-6479 1024-bit bitmap, deliberately the same arithmetic and the same width as `RestResponseSealer`'s answered bitmap, because a counter that window will still answer must be one this still accepts.

```
#highWater: bigint = -1n          highest counter ever admitted
#bits: Uint8Array(1024 / 8)       index = Number(counter % 1024n)
admit(counter):
  above the high-water mark  → clear the positions the window newly covers, set the bit, advance
  inside, bit clear          → set it
  inside, bit set            → throw E2EE_SEQUENCE_VIOLATION   (a replay, provably)
  below the window           → throw E2EE_CTX_UNKNOWN          (cannot prove it was never seen)
```

Both fields are `#private`, for the reason §13 gives verbatim: *the state that makes a nonce unique is as sensitive as the key* — one assignment to a public `highWater` re-arms every answered counter.

Sliding must **clear** the positions the window newly covers, or a wrapped index reads as a stale "seen". That is the mutation the campaign has to see red.

### 4.4 The response side

Both response paths exist in this codebase and both must be covered:

- **Direct-write routes** (~34 sites write to `c.env.outgoing` and return the 597 sentinel). Patch `writeHead` / `setHeader` / `write` / `end` before `next()`; buffer; at `end` seal once, then write the real status, `Content-Type: application/octet-stream`, the sealed `Content-Length`, and `X-TB-E2EE: 1`. A `sealed` flag makes a double `end()` a no-op rather than a second seal.
- **Hono-piped routes** (`c.json(...)`). After `await next()`, if `c.res` is not the 597 sentinel, read its body, seal, replace `c.res`.
- **A response whose framing carries no body** — the single `writeHead(304, …)` at `conversations.handlers.ts:739` — carries its one accepted, empty sealed record base64url in **`X-TB-Env`**, per Q5's frozen rule. The CORS preflight `204` never reaches here.
- **`onError`.** A thrown handler still owes its one sealed response. It cannot leak a sealed body to a rejected request, because such a request never reached `accept()` and the sealer refuses.

`countResponseBytes` is prior art for the interception seam and nothing more — it counts and forwards; this buffers and rewrites.

### 4.5 What must not change

- Paths and query stay plaintext (D-7).
- A request without `X-TB-E2EE` is passed through having touched nothing — an unpinned device with the shared key does exactly what it does today.
- Nothing in `docs/compatibility/tb-mobile.md` renamed, removed or retyped. `X-TB-Env` is a new **additive** request header.
- No body, sealed or unsealed, is ever logged; `?key=` and `?ticket=` stay `_` in `http.request`.

---

## 5. Verification

**Harness — the real path.** `createHonoApp(deps)` served by `@hono/node-server` on a loopback port, because handlers read `c.env.incoming` and write `c.env.outgoing` and Hono's test client provides neither. A real `POST /api/e2ee/open` Noise `IK` handshake with `kind: "rest"` against a real devices row; real sealed `fetch`es after that. No stubbed seam on the transition under test.

- **Positive control** — a sealed request round-trips through an untouched handler and the response unseals to that handler's JSON.
- **Negative control** — with the middleware removed from the chain, the same request 401s: proof the harness exercises the middleware rather than a path that would pass either way.

**One mutation per safeguard**, each reported as `<file>::<test>` with the verbatim assertion:

| Safeguard | Mutation | Must fail |
|---|---|---|
| unknown ctx rejected before allocation | move the registry lookup below the body read | the allocation probe |
| replay rejected | window accepts a set bit | the replay test |
| body bounded before decrypt | check the length after unseal | the oversized-body test |
| downgrade | 426 → 401 | the pinned-plaintext test |
| per-request revocation | drop the `authenticateContext` call | the mid-flight revocation test |
| capability still enforced under a context | skip the check when a principal is set | the read-only-device write test |
| raw target canonicalization | hash `c.req.path` instead of `c.env.incoming.url` | the `%2F` fixture vector |
| one sealed response per counter | seal the window-rejected error too | the nonce-reuse assertion |
| R2 ordering | act on `X-TB-Seq` before the AEAD | injected garbage reports SEQUENCE_VIOLATION, not SEAL_FAILED |
| channel binding | drop the `kind` check | a socket context serves REST |
| window slide clears | remove the clear-on-slide | a wrapped counter reads as seen |
| one envelope source | accept a request carrying both a body envelope and `X-TB-Env` | the both-sources test |
| pre-decode bound | check the `X-TB-Env` length after base64url decode | the oversized-header test |
| seal-then-destroy ordering | swap the two lines in the refusal path | **`e2ee-rest-envelope.test.ts::seals the refusal before it destroys the context`** — a call-order assertion (spy `sealResponse`, spy `contextRegistry().destroy`, assert the invocation order). Both calls are the caller's under the pure-verdict design, so the order is observable in the test even though it is not observable in the response: `destroy()` is unmapping, not invalidation, so a held context seals identically either way at this tag. **The test pins an order; it does not prove a failure mode**, and its name and comment must say so or it becomes the over-claim this track has already made twice. Real invalidation is streamer **#743** (a `#destroyed` flag in `sendState`/`receiveState`), filed against neither open PR because both have `context.ts` open. |
| bodiless responses sealed | serve the 304 unsealed | the conditional-request test |
| destroy-on-mismatch | destroy the context on a credential mismatch | the Q1 context-survival test |
| below-window decided before the bit | swap the two rejection blocks in `admit` | `e2ee-rest-window.test.ts::decides below-window before it reads the bit` — the §9 code, not the accept/reject decision (neither ordering can fail open: both tests precede `#markSeen`) |
| `accept` has one caller | add a second call site for `sealer.accept` | the desynchronised-high-water test |

**Driver rules (program-wide, from W1a):** apply inside `try`, revert in `finally`, `git diff --quiet` after every mutation, a non-parsing mutant is `BROKEN — did not run` and never a pass, campaign re-run on every refreeze, and after any interruption check for a stranded mutation before anything else.

**Full suite** serialized under `mkdir /tmp/tb-streamer-suite.lock` with an `rmdir` trap, ~18 min, once per commit request. Lint via the lockfile-pinned Biome. Exit codes captured.

---

## 6. The adversary's brief

`rest-envelope-adversary` — spawned fresh at the exact commit in its own audit worktree, given **only** `design.md` §3, `dilemmas.md` D-9, `NONCE-DESIGN.md`, the fixture and the built tree. No plan, no diff, no conversation. Runs at this session's effort (high).

Every row below is answered as exactly one of `rejected: <evidence>` / `succeeded: <finding>` / `not attempted: <reason>` — an omitted row reads as covered. Every detector carries a negative control proving it can see the thing it claims to look for.

1. unknown `ctxId` — with an allocation probe (heap delta and timing) showing the rejection is O(1) **before** the body is read
2. expired `ctxId`; 3. a foreign but live `ctxId` (another device's context)
4. oversized `Content-Length`; 5. a chunked body with no `Content-Length`
6. an inner length field claiming 2 GiB
7. replay inside the window; 8. replay below the window
9. two contexts swapped — `ctxId` of A, ciphertext of B
10. response-counter mismatch, and two responses for one accepted counter
11. a pinned device presenting `?key=` and a plaintext body — must be 426, never 401
12. a bad credential *inside* a valid envelope — the 401 must still fire
13. `Authorization` beside `X-TB-Ctx` naming another device
14. target re-pointing — a sealed `POST /api/sessions/A/input` replayed at `/B/input`
15. the same request served under the percent-**decoded** path
16. revocation between unseal and handler
17. `If-None-Match` used to force a plaintext answer (the Q5 oracle)
18. **the Q1 DoS, in two halves** — observe a `ctxId`, then (a) present a mismatched credential with **no valid seal**: must die at unseal, context intact; (b) present a **valid seal** with a wrong credential: must be a sealed 401, context intact. Neither may destroy a context
19. a socket context presented on the REST channel
20. a request carrying **both** a sealed body and `X-TB-Env`
21. an `X-TB-Env` header far over the bound — refused **before** base64url decode, memory flat
22. `If-None-Match` on the sealed 304 path — the answer must be sealed, never an unsealed 304
23. a **revoked** device mid-flight — the 403 must arrive **sealed and readable**, and the refusal must be **sealed before the context is destroyed** (pinned by a call-order assertion in the caller, since `destroy()` is unmapping rather than invalidation at this tag — see #743)
24. drive concurrent requests hard enough to separate the window's high-water mark from the response sealer's — an accepted request that can never be answered is the symptom
25. any body, key or window state reachable in a log line or an `inspect` dump

---

## 6a. The 2b rebase checklist

2b starts **only** on W1b's release tag on the remote — children key off tags, never merges. Run these in order; each is a thing that has already gone wrong somewhere in this program.

1. **Verify the precondition myself, not from the message.** `git ls-remote --tags origin <tag>` returns it; the tag's tree contains `authenticateContext`; and its arm set is `{ ok: true; principal } | { ok: false; reason: "device-revoked" | "credential-mismatch" | "no-device-store" }` with a resolved `E2eeContext` in. **If I see the old destroy-on-mismatch shape, or `status`/`body` on the failure arm, STOP and report** — do not wire against it, and do not adapt to it quietly.
2. **Check for a stranded mutation before anything else** (sha256 against pristine, not `git diff --quiet` — two of my files are untracked and `git diff` is blind to a mutant in them).
3. Rebase onto the tag.
4. **Resolve the known `app.ts` conflict by keeping ONE declaration** of `e2eeContext?: E2eeContext` in `AppEnv["Variables"]` — W1b and I both add it with different comments. Accepting both hunks compiles until it does not.
5. Wire rungs 12–13 into the seam 2a locked: verdict → on refusal seal with the still-live context then destroy **only** on `device-revoked` → on success set the principal, run `requiredCapability`/`hasCapability` (its 403 sealed too), then `next()`.
6. **Re-run the `own()` sweep on the rebased bytes.** Every property read — bracket **or** dotted, not merely `?? ` defaults — on an object whose keys come from the wire goes through `own()` from `protocol.ts` or carries a one-line justification. `req.headers` is built with `Object.prototype` and an absent header is absent as an *own* property, so an unguarded read of it is a prototype-chain read; that is a defect this track shipped once and caught only by sweeping. The revert-`own()`-to-a-bracket-read mutation must be red under a polluted prototype, and every pollution test must clean up in a `finally` and assert it did.
7. **Re-run the ENTIRE 18-mutation campaign on the rebased bytes** — not only rungs 12–13. A mutation whose patch target moved in a rebase reports a pass it did not earn; that is W1a's twelve-moved-targets lesson and it is the reason for this line.
8. **The real-chain positive control**, on the device-credential path — not `localNoAuth`. That is the bar 2a could not meet and 2b must.
9. Re-take the pristine snapshot after every accepted edit, before every campaign.
10. Lint (pinned biome 2.5.10, not the symlinked 2.5.3) and the full suite under `mkdir /tmp/tb-streamer-suite.lock` with an `rmdir` trap, exit codes captured, once per commit request.
11. Staged diff + `git diff --staged --stat` and the worktree path to the owner; **wait for its read**; then the user's commit approval in my own pane. Never both "owner approved" and "user approved" of a diff nobody read.
12. Adversary in a **fresh** audit worktree at the exact frozen commit, with `tracks/X-server/ADVERSARY-BRIEF-X-server.md` and nothing else.

---

## 7. Ledger

| When | What |
|---|---|
| 2026-08-29 22:30 | Kick-off from `e2ee-owner [ddde5e]`; addendum on `authenticateContext` received 22:4x |
| 2026-08-29 22:34 | Preconditions verified; worktree at `f95150cc`; plan drafted; §2 blocker and §3 questions sent to the owner |
| 2026-08-29 23:20 | Q1–Q7 answered: reviewer AGREE on all seven with amendments (pure-verdict helper, both-envelope-sources rejection, pre-decode header bound, the `X-TB-Env` rule frozen in both directions). Plan approved with amendments. Slice 1 (window + seam) already in flight from the partial GO. |
