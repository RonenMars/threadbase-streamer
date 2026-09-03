# Streamer: emit the app-level `{ type: "ping", ts }` the record layer already documents

Agent note. Mobile issue #946's streamer half.
Branch `fix/e2ee-ws-app-ping`, worktree `tb-streamer/.worktrees/fix/e2ee-ws-app-ping`, off `origin/main` `d9148f25`.
Owner mirrors this file; this agent does not commit it.

## 1. Diagnosis re-verified from `origin/main`, and one broken grep caught

Re-verified rather than trusted. The first form used was `git grep -E 'type:\s*"ping"'`, which returned nothing — **and so did its positive control** for `session_list`. `git grep -E` is POSIX ERE and does not support `\s`, so the emptiness was the grep, not the code. Re-run with `[[:space:]]`:

| Grep | Result |
|---|---|
| `type:[[:space:]]*"session_list"` in `src/`+`cli/` | **6 hits** (positive control passes, including the bare `type: "session_list",` line form a multi-line literal would use) |
| `type:[[:space:]]*"ping"` in `src/`+`cli/` | 2 hits: `src/types.ts:339` (the declaration) and `src/ws-hub.ts:257` (the comment) |
| `-F '"ping"'` in `src/` (no regex at all) | the same 2 |

**Confirmed: nothing in `src/` constructs or sends an app-level ping.** The type is declared, the send path documents sealing it, and no code emits it. Nine `{ type: "ping" }` constructions exist in `__tests__/`, where the frame is used as a generic broadcast vehicle.

Also confirmed: `src/ws-hub.ts:488` `client.ping()` inside a 30 s `setInterval` is the only idle liveness signal, and it is a WebSocket **protocol** ping, invisible to `onmessage`.

## 2. Counter consumption — the concern is structurally void, not merely small

The brief asked what the change does to counter consumption and to any rekey threshold the counter feeds.

**There is no rekey threshold on `origin/main` to reach.** NONCE-DESIGN §6 (user's ruling, 2026-08-29) removed in-place rekey entirely, and the code matches: `git grep -E 'rekey|bytesSealed|rekeyDue' -- src` returns **three comment lines asserting their absence** and no implementation. `record.ts:23` states it directly. So the brief's hypothesis — *"a rekey path previously reached only under load may now be reached by an idle session"* — cannot occur: the WS channel has no rekey, no byte-count trigger, and no key generation.

The only counter threshold that exists is exhaustion, §7 `MAX_COUNTER = 2n ** 64n - 1n`, refuse-don't-wrap:

- cost of the change: **one s2c WS counter per sealed socket per 30 s** = 2/min, 2 880/day.
- time for pings alone to reach `2^64`: ~**1.75 × 10^13 years**.
- and a WS context dies with its socket (§8, no grace window), so no socket accumulates across reconnects. A reconnect is a new context with counters legitimately at 0 — §8 is explicit that this is not a counter reset.

**Nothing keys off "the counter did not advance".** §5 R4 makes the counter owned by `RecordState` and never passed in; grepping every `.counter` / `#n` read outside `record.ts` returns exactly one hit, and it is a comment in `context.ts:290` telling a caller *not* to read `state.counter`. So un-freezing an idle socket's s2c counter is observable to nothing.

Net: counter cost is real, bounded, and reaches no threshold. No record-layer change is required — the change is confined to `ws-hub.ts`'s caller, so §4's isolated-adversarial-verifier gate is not triggered. Flagged for the owner rather than assumed.

## 3. The seal-then-send ordering hazard — proved absent, not argued unlikely

`ws-hub.ts:243` warns that an `await` between `seal` and `ws.send` reorders frames and trips the peer's strict `counter == expected` (§5 R2). A periodic timer is the shape that warning describes, so it needs a proof.

1. `sendTo` is synchronous end to end: `context.sendState(CHANNEL_WS).seal(memo.plaintext)` then `ws.send(frame)`, with no `await` and no promise between them.
2. `RecordState.seal` is synchronous. `src/e2ee/record.ts` and `src/e2ee/context.ts` contain **no** `async`, `await` or `Promise` at all (grepped).
3. The emission site is the existing `setInterval` callback in `startPing`, itself synchronous.
4. Node runs a synchronous block to completion on one thread, so two `sendTo` calls cannot interleave. Counter order therefore equals `ws.send` order, and `ws` preserves FIFO per socket.

That is a proof from the absence of suspension points. The corollary worth a comment at the emission site: the hazard would be **created** by making that callback `async`.

### The ordering hazard that is real, and where it bites

Not the seal/send pair — the **placement relative to the two guards already in `startPing`**:

- guard 1, stale context: `registry.get(context.ctxId) !== context` → `closeForE2ee(client, E2EE_CTX_UNKNOWN, "maintenance")`
- guard 2: `readyState !== OPEN` → `continue`

Emitting the ping **before** guard 1 seals on a registry-invalidated context, which **throws** — `contextCanSeal(stale) === false` is asserted at `__tests__/e2ee-ws-sealing.test.ts:1683`. The socket would then close with `E2EE_SEAL_FAILED` instead of `E2EE_CTX_UNKNOWN`: a §9 semantic change that tells a client "unrecoverable server fault" for what §9 defines as the recoverable case.

Two **existing** assertions pin the correct placement, so this mutation already has its red test:

- `expect(sockets[0].send).not.toHaveBeenCalled()` — `e2ee-ws-sealing.test.ts:1631`
- `expect(sockets[0].close).toHaveBeenCalledWith(1008, E2EE_CTX_UNKNOWN)` — `:1627`

**Decision: the ping is emitted after both guards, beside `client.ping()`.**

## 4. Plaintext clients, and clients with no context yet

**Plaintext (legacy `?key=`) sockets** take the `sendTo` branch with no context and receive `{"type":"ping","ts":…}` as a text frame. Read-only check of tb-mobile `origin/main` `services/ws-client.ts:311-322`: `handlers.get(msg.type)` misses, no default case, no throw, then wildcard handlers fire. And `git grep -F "'ping'"` over mobile `services/ hooks/ components/` returns **nothing** (positive control on `'session_update'` returns hits in three files), so no handler exists to misbehave. The frame is inert except for resetting the silence timer.

Sending it to plaintext sockets too is deliberate: the client's 45 s timer is unconditional, so an unpinned client redials just as often — only more cheaply. Emitting to every socket fixes the churn for both paths and is what "the same send path as every other frame" already means, `sendTo` handling both.

**Mid-handshake:** the hub has no such state — `addClient(ws, context)` receives a context already built from the ticket. The analogue is the *unproven* socket (context attached, no inbound frame yet). A ping seals fine there (send state is independent of receive state) and must **not** clear the unproven timer, or the ticket-thief reaper at §10 stops firing. `clearUnproven` is called only from `receive()`, so it does not — pinned by a test, because that is the ticket-thief defence.

With production constants the question is moot anyway: the unproven deadline is 10 s and the first ping is at 30 s.

## 5. Cadence: reuse the 30 s timer

Client window is 45 s (`WS_SILENCE_TIMEOUT_MS`, tb-mobile `hooks/useTerminalStream.ts:25`). Existing protocol-ping interval is 30 s.

**Reuse it rather than add a timer.** One schedule cannot drift against itself, there is one place to change cadence, and the interleaving argument in §3 above is made once instead of twice. 30 s leaves a 15 s margin; one lost ping does exceed the window, which is correct — a socket dropping frames should be redialled.

## 6. Verification plan

`vi.useFakeTimers()` + `advanceTimersByTimeAsync(30_000)` against the real `startPing` is already the established convention in this file (`:1624`, `:1678`), so **no constructor seam is needed** — the real 30 s constant is exercised.

- **Real objects, real wire:** real `http.Server`, real Hono app, real `/api/e2ee/open` handshake, real `WSHub`, real `ws` sockets, real `RecordState` both ends. Faking **only `setInterval`** leaves socket I/O and the harness's `poll()` on real timers, so the frame is captured off the wire before the client's record layer touches it.
- **Negative control proving causality:** capture the `ws` client's `'ping'` event separately from `'message'`. Over one interval the protocol ping is observed on the `'ping'` channel while the JS-layer message channel carries exactly the app ping — so "the JS layer sees nothing from a protocol ping" is a fact about the protocol, not a harness that sees nothing.
- **Positive control:** the same harness reads the sealed ping's plaintext header at the expected counter and unseals it under the client's own key.

Mutations that must go red:

| Mutation | Test |
|---|---|
| remove the ping emission | the idle-session-gets-a-ping-inside-45 s test |
| send it unsealed to a sealed client | the wire-is-ciphertext assertion (no plaintext `type`, unseals at the expected counter) |
| cadence above the client's window | the constant-relationship test |
| emit before the maintenance guard | **existing** `:1627` / `:1631` |
| let a ping clear the unproven timer | the ticket-thief reaper test |

Only two tests in the suite advance timers past 30 s, both in `e2ee-ws-sealing.test.ts`, and both assert `send` was **not** called on the stale sockets they are about — which my placement preserves. No other test reaches the ping interval, so no existing assertion is perturbed by the extra frame.

`tsc` is its own gate (babel strips types), run separately from lint and the suite.
