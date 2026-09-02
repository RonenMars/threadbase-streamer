# PLAN-X-client — XC1: mobile WebSocket record layer, context, ticket, sealed `WSClient`

**Status:** XC1 **MERGED** (mobile #927 → `bb5cd7f0`). XC2 in implementation.
**Session:** resume of Codex `01a050c1` in Cursor, 2026-09-01. **Scope of this addition:** XC2 only.
**Date:** 2026-09-01.

---

## 0. Pins, base, and preflight evidence

Everything external is pinned here so a usage-limit resume continues instead of re-deriving.

| Thing | Exact value | How it was verified |
|---|---|---|
| Streamer interop baseline | tag `v1.72.0` → `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b` | `git ls-remote --tags origin v1.72.0` against the **remote**, not a checkout |
| Streamer PR | #748 `MERGED` at 2026-08-31T07:41:45Z, "feat(e2ee): seal WebSocket transport per device context" | `gh pr view 748 --json state,mergedAt` |
| Mobile base | `origin/main` = `77c2a1600c114e5de986f4d715bd03233365a08c` ("chore(ios): bump build number to 213 [skip-ci] (#925)") | `git fetch origin && git rev-parse origin/main` |
| Worktree | `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-transport` | created from `77c2a160`; `npm ci` exit 0 |
| Branch | `feat/e2ee-ws-transport` | no prior worktree or branch owned it |
| expo | 57.0.18 | resolved from `node_modules`, not the `^` range |
| react-native | 0.86.3 | resolved from `node_modules` |
| jest | 29.7.0 | resolved from `node_modules` |
| `@stablelib/chacha20poly1305` | 2.0.1 | resolved from `node_modules` |
| `@stablelib/x25519` | 2.0.1 | resolved from `node_modules` |
| `@stablelib/sha256` | 2.0.1 | resolved from `node_modules` |
| Simulator start-state | **nothing booted** — `xcrun simctl list devices booted` empty, `adb devices` empty, 2026-08-31T15:01:01Z | recorded before any device work, per tb-mobile `CLAUDE.md` |

Mobile pairing prerequisites all `MERGED`: #908, #915, #917, #919.

**No streamer package dependency is added to record the pin.** `v1.72.0` is pinned in this plan, in the copied fixture's provenance header, and in the loopback rig evidence — per the brief.

---

## 1. Contradictions found during reading — resolve before or during implementation

These are stated up front because each one would otherwise be discovered as a silent failure.

**C-1 — `{ type: 'auth' }` is already deleted on `origin/main`.** The brief and `mobile-design.md` §4.2 both list "delete the plaintext `auth` frame" as XC1 work. It was already removed; `services/ws-client.ts:206-214` carries a comment explaining that no streamer ever had a handler for it. **Consequence for verification:** the seen-red mutation "plaintext `auth` frame written to the socket" cannot be produced by deleting code — it must be produced by *re-adding* the frame and observing the no-plaintext assertion go red. Recorded so the mutation is not silently marked "not applicable".

**C-2 — `mobile-design.md` §4.2 says the URL becomes `/ws?ticket=<t>`.** That is superseded by `NONCE-DESIGN.md` §10/§12 and the brief: the ticket travels in the `X-TB-Ticket` header and never in the URL. This plan follows NONCE-DESIGN. `mobile-design.md` is streamer-repo prose and is **not** edited by this track.

**C-3 — `mobile-design.md` §4.1 says "the `Authorization` header stays".** Superseded by `NONCE-DESIGN.md` §13(b). That sentence is REST (XC2) scope; XC1 is only affected in that a **ticketed upgrade carries no credential at all** — neither `Authorization` nor the current `?key=`.

**C-4 — the `/open` msg2 fixture omits `provisional`.** `NONCE-DESIGN.md` §11 and §12 both say `provisional` is *always present* in msg2, but `__tests__/fixtures/e2ee-record-vectors.json`'s `open.payload2Utf8` is `{"v":1,"ctxId":"…","expiresAt":…,"ticket":"…"}` — no `provisional`. The client must therefore **not** require the field. Decision: parse `provisional` with `Object.hasOwn`, treat an absent value as `false`, and never let its absence fail an otherwise valid msg2. Reported to the coordinator as a spec/fixture contradiction for the streamer side to reconcile; XC1 does not block on it.

**C-5 — `noise.ts` needs a psk-less `IK` branch, and it is not in the brief's expected-paths list.** The brief lists `record.ts`, `context.ts`, `ws-client.ts`, `stores/servers.ts`. But `/open` is `Noise_IK_25519_ChaChaPoly_SHA256` with **no** psk (§11), and the mobile `noise.ts` today hardcodes `IKpsk1` with a mandatory `psk`. `services/e2ee/noise.ts` and `services/e2ee/pair-handshake.ts` must therefore be modified. This is an addition to the expected product paths and is called out for approval rather than assumed.

**C-6 — `D_priv` is deliberately not readable by callers.** `pair-handshake.ts` stores the device static key under `threadbase_e2ee_device_key_<serverId>` and its comment says "the key itself is never handed back to a caller". `/open` needs it. Decision: **do not** add a getter that returns key bytes (the guard-class rule forbids exactly that). Instead add `createOpenInitiator({ serverId, serverPublicKey, kind })` inside `pair-handshake.ts`, which loads the stored key internally and returns a `NoiseInitiator` — the key never crosses the module boundary. Load-only, never create: an absent key means "not paired", a hard failure, never a fresh key.

**C-7 — mobile PR queue blocks the one-PR-per-repo slot.** 5 open PRs (#924, #922, #918, #911, #879). Already reported. XC1 implements and verifies regardless; the PR is held until the slot frees.

---

## 2. Design decisions

### 2.1 Counter representation — `bigint`, refusing at the 64-bit ceiling

**Decision: a native `bigint`.** Not a two-`number` representation.

Justification: the spec (§3) permits either a `bigint` or a representation that *throws* above 2^53, and names the failure it is guarding — a `number` counter silently loses integer precision above 2^53 and starts repeating nonces with no error. A two-`number` scheme would satisfy the letter of §3 but adds a hand-rolled carry that is itself a place to introduce a wrap. `bigint` is exact to 2^64-1 by construction, matches the streamer's own representation, and makes the ceiling an explicit comparison rather than an emergent property.

Rules:
- The counter is `#counter: bigint`, an ECMAScript `#private` field. TS `private` is a runtime own property, so `(state as any).n = 0n` would be a live counter reset — `#private` makes it a syntax-level impossibility.
- `seal()` and `unseal()` take **no** counter. Only `createRecordState({ initialCounter })` seeds one, at construction, marked internal and used only by the exhaustion test (the §5 R4 sanctioned exception).
- **Ceiling:** a sender whose next counter would exceed `2n ** 64n - 1n` **refuses to send**, leaves the state unchanged, and the caller destroys the context (§7). It never wraps.
- Hermes risk: `BigInt` and `DataView.setBigUint64` are unverified in Hermes (review M9). Verified on-device before acceptance — §6.4. If Hermes lacks either, the fallback is a two-`number` representation that throws above 2^53, and that change comes back for approval; it is not made silently.

### 2.2 Wire format

Frame = 30-byte plaintext header ‖ ciphertext‖tag. Header and AAD are the same 30 bytes on the socket channel:

```
AAD[30] = version(1) || ctxId(16) || direction(4) || counter(8) || channel(1)   big-endian
nonce[12] = direction(4) || counter(8)                                          big-endian
direction: 1 = c2s, 2 = s2c      channel: 1 = websocket, 2 = rest-req, 3 = rest-resp
```

- `chachaNonce` from `noise.ts` is **never** reused — it is little-endian, a different layer (§14).
- WS frames use the **binary** opcode; `binaryType` is set accordingly.
- `recordAad` itself enforces that channels 2/3 carry a 32-byte target hash and channel 1 carries none. **`record.ts` supports all three channel bytes** — one AAD function, and it lets the REST negative vectors be consumed as AAD-level tests now. **No REST transport is wired**; `services/authed-fetch.ts` is not touched.

### 2.3 Context lifecycle

- **One fresh E2EE context per `WSClient` socket instance.** Never one device-wide context shared with REST (§8, §14). A reconnect is a **new** `/open`, new `ctxId`, new keys, counters legitimately at 0 — not a reset.
- **No persistence.** No key, `ctxId`, counter, or ticket is ever written to SecureStore or AsyncStorage. After an app kill the client opens a fresh context; a resumed counter is a nonce repeat.
- **Two `WSClient` instances never share one mutable context or counter.** Each instance constructs its own context; there is no module-level shared record state. This is the program's "two writers" stop-work trigger, so it gets a test rather than only a trigger.
- Keys are read off the handshake result, used to construct the two record states, and the source arrays are wiped. There is never a getter returning key bytes.

### 2.4 `open → ticket → upgrade` as one generation-guarded single-flight sequence

```
_doConnect()
  gen := ++this.#generation
  ctx := await openContext(serverId, kind:'ws')      // POST /api/e2ee/open, fresh msg1
  if (gen !== this.#generation) { destroy ctx; return }   // superseded by forceReconnect
  socket := new WebSocket(url, null, { headers: { 'X-TB-Ticket': ctx.ticket } })
  if (gen !== this.#generation) { close socket; destroy ctx; return }
```

- **Single-flight per server.** `forceReconnect()` fires on every foreground resume and on the silence timer; two concurrent calls must not become two handshakes. The generation counter is checked after **every** await, and a superseded sequence destroys its context rather than leaking it.
- The `/open` request has **its own timeout**, separate from `CONNECT_TIMEOUT_MS`.
- **Ticket only in `X-TB-Ticket`.** Never `?ticket=` in the URL — URLs land in ingress logs (M12).
- **No `Authorization` on a ticketed upgrade**, and the existing `?key=<apiKey>` is **removed from the URL** on the sealed path. The ticket is the credential: single-use, 30 s, bound to a context proven by the Noise handshake. A bearer beside it is plaintext to the tunnel.
- The unpinned/legacy path keeps `?key=` and stays **byte-identical** — stranding an app talking to an older streamer is a stop-work trigger.
- **No `await` between `seal` and `ws.send`.** Seal-and-send is one synchronous step, or frames reorder and the peer's strict counter closes the socket (§14).

### 2.5 Sealed `register` within 10 s

The server closes a sealed socket that has not delivered one valid sealed inbound frame within 10 s of the 101 (the ticket-thief reaper, §10). `{ type: 'register', clientId }` is already sent on open; it becomes **sealed**, and `getDeviceClientId()` is awaited **before** the upgrade rather than after it, so no await sits between the 101 and the first sealed frame.

### 2.6 Seal on every outbound write, unseal on every inbound dispatch

`WSClient.send()` and `socket.onmessage` are the only two crossings. `wsManager.send`, `acquireSession`, `releaseSession`, and `resubscribeHeldSessions` all route through `client.send`, so sealing in `send` covers every call site. Listener registration, the `WSMessage` union, and every `client.on(...)` call site are untouched.

- Inbound: **authenticate first, then compare the counter** (§5 R2 ordering). An injected frame with a bad tag reports a seal failure, never a sequence violation.
- **Strict `counter === expected`. No window, no tolerance, no reordering allowance.** Duplicate, gap, reorder, reflection, and any plaintext (non-binary / unsealable) frame on a sealed socket are each a protocol failure: close and reconnect. A rejected frame advances **neither** counter (§5 R3).
- A socket that has ever held a context never falls back to plaintext, in either direction.

### 2.7 Failure handling — one retry, then a visible error

- Any failed ticketed upgrade is treated as `E2EE_CTX_UNKNOWN`. RN cannot read the upgrade status or body (M6), so a spent/expired ticket's `401` is invisible and collapses into this path.
- **One fresh `/open` (a brand-new msg1 with a new ephemeral) plus one upgrade retry.** Then a visible error.
- After that retry fails: **no re-authentication flow, no pin change, no plaintext fallback.** The re-auth/"pair again" shape is the H2 social-engineering hazard arriving as a status code.
- **Every `/open` attempt re-runs `writeMessage1` afresh.** Re-sending the same msg1 bytes is a permanent refusal — the server keeps a replay cache keyed on the cleartext ephemeral. Retries always re-seal from plaintext; previously sealed bytes are never re-sent.
- `E2EE_DEVICE_REVOKED` is a hard failure, surfaced, never retried.
- A sealed `503 STORE_UNAVAILABLE` is transient: retry with backoff, never the re-auth path, never a pin change.
- Pinned server + failed handshake = hard, visible failure. Never plaintext.

### 2.8 Guard-class rules (carried from W1a's five adversary rounds)

- One `assertBytes(value, length)` helper on every byte field (keys, `ctxId`, ephemeral, target hash): `instanceof Uint8Array`, `BYTES_PER_ELEMENT === 1`, `byteLength === length`. Never truthiness, never `.length` — a `Float64Array(32)` passed a `.length` check on the server and ran a full handshake binding 256 zero bytes.
- **No `??` / `||` default on any argument reaching a trust boundary.** `prologue` is a required parameter; optional args are read with `Object.hasOwn`. Tested under `Object.prototype` pollution.
- The `IKpsk1` path refuses a PSK that is not exactly 32 bytes (an empty `Uint8Array` is truthy); the psk-less `IK` path for `/open` refuses **any** PSK. Both tested.
- Every piece of nonce/context/counter state and every key is an ECMAScript `#private` field.
- No `unknown` or `any` in new code (tb-mobile `CLAUDE.md`); if a boundary genuinely needs one, stop and ask.

---

## 3. Files

| Path | Action |
|---|---|
| `services/e2ee/record.ts` | **new** — `createRecordState`, `seal`, `unseal`, `recordAad`, `assertBytes`, the `bigint` counter and the 2^64 ceiling |
| `services/e2ee/context.ts` | **new** — `/open` client, msg1/msg2, ctxId + ticket, per-socket context, single-flight, rejection-code mapping |
| `services/ws-client.ts` | **modify** — generation-guarded open→ticket→upgrade, `X-TB-Ticket` header, no `?key=` on the sealed path, seal in `send`, unseal in `onmessage`, strict counter, sealed `register` |
| `services/e2ee/noise.ts` | **modify** (C-5) — psk-less `IK` branch: different protocol name, `psk` token skipped, PSK-length guards |
| `services/e2ee/pair-handshake.ts` | **modify** (C-5, C-6) — `OPEN_PROLOGUE`, `createOpenInitiator` that loads `D_priv` internally and never returns it |
| `stores/servers.ts` | **modify only if required** by the stable-server-ID / stored-key seam. Current reading: probably not required — crypto state keys off the stable server id, which already exists. Stated as a maybe rather than assumed either way. |
| `__tests__/unit/e2ee/*` | **new** — focused tests following existing mobile conventions |
| `__tests__/fixtures/e2ee-record-vectors.json` | **new** — byte-identical copy of the `v1.72.0` fixture, with a provenance header naming the tag and SHA |
| `scripts/git-hooks/ci-paths.txt` | **check and update** if any new path is not already covered |

Explicitly **not** touched: `services/authed-fetch.ts`, `services/api-client.ts`, `hooks/useTerminalStream.ts`, pairing UX, copy, D-5 persistence inversion, the require-encryption UI.

---

## 4. Interop against the `v1.72.0` fixture

The fixture is copied byte-for-byte into the mobile repo (the client consumes the fixture, not the streamer's test file). Contents mapped:

- **7 positive `records`** — including `websocket c2s counter 0`, `counter 1`, `s2c counter 0`, and **`counter 2^32`** (a counter above 32 bits). Each is reproduced byte for byte from `key`, `nonce`, `aad`, `plaintextUtf8` → `frame`.
- **12 `negative.cases`**, each with its required verdict:

| # | Case | Expect |
|---|---|---|
| 0 | version byte flipped | `seal-failed` |
| 1 | ctxId re-pointed at another context | `seal-failed` |
| 2 | direction flipped to s2c | `seal-failed` |
| 3 | channel changed to rest-request | `seal-failed` |
| 4 | counter renumbered to the expected slot | `seal-failed` |
| 5 | tag corrupted | `seal-failed` |
| 6 | body truncated by one byte | `seal-failed` |
| 7 | reflected: s2c fed back as c2s | `seal-failed` |
| 8 | counter gap (5 while 4 expected) | `sequence-violation` |
| 9 | counter repeat (base delivered twice) | `sequence-violation` on the **second** delivery only |
| 10 | rest request re-pointed at another session | `seal-failed` (AAD-level; XC2 wires the transport) |
| 11 | rest request under the percent-**decoded** path | `seal-failed` (AAD-level) |

Cases 8 and 9 are the ones that prove the *ordering* rule: they authenticate and are then refused by the counter, so a client that checked the counter first would report the wrong verdict and still look green.

- **`open`** — the psk-less `IK` vector: protocol name `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `threadbase-e2ee/1 open`, `psk: null`, both messages, `handshakeHash`, and both traffic keys. Plus `pairingMessage1RejectedHere` — a valid *pairing* msg1 that **must fail** against the `/open` prologue. Without that vector, defaulting the prologue would silently remove the domain separation.
- **`restTargetCanonicalization`** — consumed as an AAD-level test now (raw wire target, never the decoded path), so XC2 inherits a proven hash.

**Positive vectors alone are not enough** and are not treated as conformance — every defect found in the Phase 2 client sat underneath correct output. The acceptance for this layer is the isolated adversary, not a matching fixture.

---

## 5. Seen-red campaign

Every safeguard gets one mutation, reported as `<file>::<test name>` plus the **verbatim** failing assertion. A mutation that cannot be seen red verifies nothing.

| # | Safeguard | Mutation | Note |
|---|---|---|---|
| M1 | counter precision | represent the counter as `number` past 2^53 | must produce a **duplicate nonce**, not an error |
| M2 | direction binding | remove **every** binding of `direction` — AAD field, nonce bytes, **and** the header check | single-field removal leaves it rejected by the nonce and proves nothing (§15) |
| M3 | counter binding | remove **every** binding of `counter` — AAD field **and** nonce bytes | same reason |
| M4 | strict socket counter | introduce a window | a gap must be accepted |
| M5 | fail-closed | restore a plaintext fallback after a failed open or upgrade | plaintext must leave the socket |
| M6 | ticket single-use | attempt ticket reuse | the client must never try; server-side rejection observed on loopback |
| M7 | no persistence | persist context/counter | SecureStore/AsyncStorage spies must see it |
| M8 | two writers | make two `WSClient` instances share one context | a shared counter is the failure |
| M9 | no plaintext frames | write a plaintext `auth` frame **(re-added — see C-1)** and a plaintext application frame | the no-plaintext assertion must go red |
| M10 | ctxId binding | drop `ctxId` from the AAD | single-field mutation is genuinely sufficient here (§15) |
| M11 | channel binding | drop `channel` from the AAD | single-field mutation sufficient |
| M12 | R3 | advance the counter on a rejected frame | a duplicate must then be accepted |
| M13 | R2 ordering | check the counter before the AEAD | an injected bad-tag frame must then report `sequence-violation` instead of a seal failure |
| M14 | prologue | default the `/open` prologue to `PAIR_PROLOGUE` | the pairing-msg1 vector must then be **accepted** |
| M15 | exhaustion | allow the wrap at 2^64-1 | seeded via `initialCounter` |
| M16 | PSK guards | select the pattern by `psk` presence (truthiness) | an empty `Uint8Array` must then run a full `IKpsk1` |
| M17 | pollution | read an optional arg with `??` instead of `Object.hasOwn` | red under a polluted `Object.prototype` |

**Mutation-driver rules (program-wide, from W1a):** every mutation is reverted in a `finally`; `git diff --quiet` is asserted after each. A mutated module that fails to parse or import is reported `BROKEN — did not run`, **never** counted as a pass — absence of a failure line is not evidence, only an observed red is. After any interruption, check for a stranded mutation before anything else.

---

## 6. Verification

### 6.1 Real path

Real `record`/`context` objects and the real `WSClient` boundary. No mocked seal, no stubbed transition-under-test. The real store.

### 6.2 Controls

- **Positive control:** a captured sealed frame reveals its application `type` only after unseal — the capture is taken at the socket, below `WSClient`.
- **Negative control:** the same capture path, against an explicitly unsealed and unpinned control server, shows plaintext. This proves the tap can see plaintext when it is there; without it, "no plaintext observed" is unfalsifiable.

### 6.3 Real loopback against streamer `v1.72.0`

The pinned streamer runs on loopback under a **scratch `HOME`** and a separate config dir. Never `~/.threadbase`, never `~/.claude`, never a real keychain. Captures are scrubbed before evidence leaves the scratchpad — taps log argv, and the streamer once logged its full key. A private key, ticket, or device token appearing in any log or evidence is a stop-work trigger.

### 6.4 Hermes / device probe — before claiming XC1 acceptance

`BigInt` and `DataView.setBigUint64` are unverified in Hermes (M9). A throwaway benchmark screen (reusing D-3's method) runs the record vectors and the `/open` vector **on a device**, in Hermes, not in the jest/Node environment. Evidence: the counter-2^32 vector and the exhaustion ceiling both behave as in Node. Any iOS 26.x Maestro **infrastructure** failure is recorded separately from application failures. Every simulator/emulator this task boots is shut down and compared against the §0 start-state record (which is: nothing booted).

### 6.5 Repository checks

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:scripts
npm run test:e2e:mock
```

All five, with exit codes and totals reported. `test:unit` alone is a false green per the repo's own guidance. Before committing, `npx eslint` on every staged JS/TS path from `git diff --cached --name-only --diff-filter=ACMR`.

### 6.6 Isolated adversary

A sub-agent spawned fresh with **only** `NONCE-DESIGN.md`, `design.md` §3, `mobile-design.md` §4, the pinned streamer on loopback under a scratch `HOME`, and the worktree at the exact commit — none of the implementer's context. It runs at this session's effort (high); the effort is not lowered.

Every row is reported as exactly one of `rejected: <evidence>`, `succeeded: <finding>`, or `not attempted: <reason>`, each with a negative control. **An omitted row reads as covered**, so the row list is fixed in advance:

1. nonce reuse across reconnect
2. nonce reuse across foreground rollover (two live contexts during the drain)
3. reflection — a s2c record fed back as c2s
4. counter rollback
5. duplicate frame
6. counter gap
7. plaintext frame injected into a pinned server's socket
8. precision past 2^53 (seeded state — must error, never repeat)
9. `ctxId` swapped between two servers in the store
10. stripped capability info / stripped `/api/info` on a pinned server (hard failure, no fallback)
11. persisted state surviving an app kill
12. two client instances sharing a context
13. plaintext leaving `WSClient` for a pinned server under a socket spy

---

## 7. Gates and approval boundaries

1. **Plan approval** — this document. *Implementation does not begin until it is explicitly approved.*
2. **Staged diff + exact commit message** — the complete staged diff and the verbatim message are shown through the coordinator and explicitly approved before `git commit`. Conventional title, one sentence per line in the body, no AI attribution.
3. **PR gate** — before opening, inspect every open mobile PR and compare overlapping paths. Unrelated PRs are never modified, closed, merged, or commented on. If the one-PR-per-repo rule cannot be satisfied (C-7), keep the verified branch safe and report the exact blocker rather than opening a competing PR.
4. **Merge approval** — separate, fresh, explicit, **after** current CI and mergeability are shown. Rebase onto current `origin/main`, rerun every mutation and every required check, watch all required checks, then show mergeability and the exact squash title and stop. Squash-merge only on green. Confirm GitHub reports `MERGED` before treating XC1 as complete. Never push to `main`.

`tracks/STATUS.md` and `tracks/PLAN-FINISH-E2EE-2026-08-30.md` are **not edited by this track** — exact proposed updates and evidence go to the coordinator.

---

## 8. Stop-work triggers for XC1

Pause and ask immediately if: `D_priv`, a ticket, a device token or an API key appears in any log, fixture, evidence or PR; a plaintext frame is observed on a socket declared sealed; two writers hold one socket's counter state; a change would strand an app talking to an older streamer (the unpinned path must stay byte-identical); or a `dilemmas.md` entry turns out to be load-bearing for XC1.

---

# XC2 — REST envelope in `authedFetch`

**Status:** XC2 **PR #934 OPEN** (`5709337d`). User go 2026-09-01 ("start xc2"). Isolated adversary **broke it** on header casing (rows 4–5); strip is now case-insensitive. Mutation campaign **12/12 seen red** after the fix. Rebase onto `main` `8e27ea72` (#933) before merge.
**Pin:** streamer tag `v1.73.0` → `ab15fc2c2dc8231816a95bb836fb05545d51f11c` (X-server #751). Record/open fixture bytes are identical to `v1.72.0`; the envelope contract is the new artefact.
**Worktree:** `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-rest-envelope`, branch `feat/e2ee-rest-envelope`, commit `5709337d` (XC1 squash `bb5cd7f0` is an ancestor).
**PR:** https://github.com/RonenMars/threadbase-mobile/pull/934 — mobile open PRs besides this: #879 (dependabot).

Device start-state 2026-09-01T08:20Z: no iOS simulator booted, `adb devices` empty.

## XC2-0. What XC1 already left in place

- `record.ts` already seals REST AAD (channels `0x02`/`0x03`) and consumes the canonicalization vector.
- `openContext({ kind: 'rest' })` already refuses a ticket and already single-flights `/open` by `serverId:kind`.
- `contextFor` still hardcodes `CHANNEL_WEBSOCKET` for both directions — XC2 must split REST send=`0x02`, recv=`0x03`.
- `authedFetch` and `useTerminalStream` are untouched. The 2 s HTTP fallback is `api.get('/output')`, so sealing `authedFetch` seals the fallback; a spy still has to prove it.

## XC2-1. Lifecycle

One long-lived REST context per **stable server id**, never per `AuthedTarget` object.

- Opened lazily with the first sealed request in hand (`kind: 'rest'`).
- Shared by every `authedFetch` for that server. JS is single-threaded; `seal()` is synchronous; there is no `await` between `seal` and `fetch()`. Concurrent React Query calls therefore get consecutive counters, which is why the server has a window and the client does not.
- `openContextOnce` for `kind: 'ws'` must **not** be reused: it deliberately gives each waiter its own context. REST waiters share the live context.
- No persistence of `ctxId`, keys, or counters.
- Rollover (new `/open`, never in-place rekey) when any of: 24 h (`expiresAt`), 1 GiB of sealed frame bytes (send + recv), or AppState returning to `active`. Old context is kept 10 s so in-flight responses can still unseal, then destroyed. New requests use the new context immediately.
- One transparent reopen on plaintext `409 E2EE_CTX_UNKNOWN`, then a visible error. The retry re-seals the original plaintext with a new counter; sealed bytes are never resent.
- Sealed `503 STORE_UNAVAILABLE` → backoff, never re-auth, never pin change, context intact.
- `E2EE_DEVICE_REVOKED` is hard. Pinned + failed `/open` is hard, never plaintext.

## XC2-2. Wire

Pinned when `requireEncryption === true` && `serverPublicKey` is present — the same predicate as XC1's socket.

On a sealed request:

| Header | Value |
|---|---|
| `X-TB-E2EE` | `1` |
| `X-TB-Ctx` | `ctxId`, base64url unpadded, 22 chars |
| `X-TB-Seq` | decimal string of the sealed request counter |
| `Authorization` | **absent** (dropped even if a caller passed it) |
| `X-TB-Env` | base64url of the 46-byte empty record, **only** when the method cannot carry a body (`GET`/`HEAD`, or `204`/`304` responses) |
| body | the binary frame when the method can carry a body; never both body and `X-TB-Env` |

AAD target = `sha256(METHOD || "\n" || path || "\n" || query)` from the raw path string the caller passed (first `?` splits query; query has no leading `?`; path is never decoded). Fixture: `restTargetCanonicalization.hashInputUtf8`.

Response: `response.counter === request.counter` after AEAD (B2). Client REST receive is **not** a sequential counter and **not** a sliding window — `unsealMatching(frame, requestCounter, target)`. Unordered concurrent responses are therefore legal. A 304 carries the record in `X-TB-Env`. After unseal, infer `Content-Type` (`application/json` iff the plaintext is one JSON value; otherwise leave non-json so `stopSession`'s ndjson path still runs). Status stays outside the envelope.

## XC2-3. Status map (sealed request)

| Status / code | Client |
|---|---|
| `409` `E2EE_CTX_UNKNOWN` (plaintext, pre-unseal) | destroy REST context, one reopen, one retry |
| `400` `E2EE_SEQUENCE_VIOLATION` / `E2EE_SEAL_FAILED` | protocol error, no retry |
| `413` | bound, no retry |
| `426` | pin-mismatch state; never a downgrade |
| sealed `503` `STORE_UNAVAILABLE` | backoff, context intact |
| any other **unsealed** response | transport failure (H2); never `AuthError`, never cache freshness, never re-pair |
| valid sealed body (incl. sealed 401/403/304) | application semantics from the plaintext |

Unpinned servers keep today's `Authorization` path **byte-identical**.

## XC2-4. Files

| Path | Action |
|---|---|
| `services/e2ee/record.ts` | `restTargetHash`, `recordCounter`, `unsealMatching` |
| `services/e2ee/context.ts` | REST channel split in `contextFor` |
| `services/e2ee/rest-session.ts` | **new** — per-server REST registry, rollover, 10 s drain |
| `services/authed-fetch.ts` | envelope at the transport boundary |
| `hooks/useTerminalStream.ts` | only if a spy cannot prove the fallback through `authedFetch` alone |
| `__tests__/unit/e2ee-rest-envelope.test.ts` | **new** |
| `__tests__/unit/authed-fetch.test.ts` | sealed cases; existing unpinned cases must stay green |
| `scripts/xc2-mutations.js` | **new** — one seen-red row per XC2 safeguard |

Explicitly not touched unless a test forces it: pairing UX, copy, D-5, `ws-client.ts`.

## XC2-5. Seen-red campaign

Driver: `scripts/xc2-mutations.js`. Run 2026-09-01: **12/12 SEEN RED**, sources restored (no stranded mutation strings).

| # | Safeguard | Mutation | Verdict | Test / assertion |
|---|---|---|---|---|
| R1 | no Authorization on sealed (any casing) | skip the `authorization` forbid | SEEN RED | `hasHeader(..., 'Authorization')` received `true` |
| R2 | GET uses `X-TB-Env`, never a body | put the record in the body | SEEN RED | `expect(headers[HEADER_ENV]).toBeTruthy()` received `undefined` |
| R3 | never both carriers | GET body+Env, and skip the `x-tb-env` forbid | SEEN RED | POST `hasHeader(HEADER_ENV)` or GET body present |
| R4 | target is the raw path | hash the decoded path | SEEN RED | `RecordError: E2EE: the record did not authenticate` |
| R5 | response counter equals request | accept a different counter | SEEN RED | expected reject `E2EE_SEQUENCE_VIOLATION`, promise resolved |
| R6 | 409 reopens once | skip the reopen | SEEN RED | `EnvelopeError: E2EE: sealed request refused (409)` |
| R7 | unsealed 401 is not `AuthError` | throw `AuthError` | SEEN RED | `toBeInstanceOf(EnvelopeError)` |
| R8 | no persistence | write ctxId/counter to SecureStore | SEEN RED | `setItemAsync` received `"tb-e2ee-rest-counter"` |
| R9 | unpinned path unchanged | drop Authorization on an unpinned server | SEEN RED | expected `"Bearer tb_shared"`, received `undefined` |
| R10 | retries re-seal | resend the previous frame bytes | SEEN RED | `sealSecond` expected 1 call, received 0 |
| R11 | two REST callers share one context | give each caller its own send state | SEEN RED | `expect(opens).toBe(1)` received 2 |
| R12 | channel split | REST context still uses websocket channel bytes | SEEN RED | `a socket channel record must not bind a target hash` |

## XC2-6. Stop-work (XC2)

Same as XC1, plus: a plaintext body or `Authorization` header leaving `authedFetch` for a pinned server; two REST sessions for one server id each holding a live send counter.

## XC2-7. Isolated adversary (2026-09-01)

Report: `tracks/X-client/ADVERSARY-XC2.md`. Verdict **broke it** on two header-hygiene holes in `sealedFetch`:

- Row 4: only `Authorization` / `authorization` were deleted; caller `AUTHORIZATION` left on the object passed to `fetch`.
- Row 5: POST `delete headers[HEADER_ENV]` missed caller `x-tb-env`, so a binary body and a second envelope header both left.

Fix: copy caller headers through a case-insensitive forbid list (`authorization`, the four `X-TB-*` names, `content-type`), then set the protocol headers. Tests that replay the adversary probes are in `e2ee-rest-envelope.test.ts`; R1/R3 mutations re-run SEEN RED on those tests. Other 18 rows rejected. Extra findings (lazy drain, `serverId`-only bind, sealed 401 → `NetworkError`) are not nonce/plaintext breaks and were not patched.
