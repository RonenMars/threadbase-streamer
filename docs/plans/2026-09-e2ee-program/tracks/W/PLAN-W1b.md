# W1b — seal the socket

**Status:** **APPROVED by `e2ee-owner` 20:40 (day 2)**, with three amendments applied below.
**Precondition:** **`v1.71.0` on the remote** (W1a's tag), and `NONCE-DESIGN.md` at that tag.
**Roles:** the implementer sub-agent writes; **W reviews and does not author** — the session that reviews a diff must not be the session that wrote it.
**Branch:** `feat/e2ee-ws-sealing`, own worktree, from the tag's commit.

W1a built the record layer and left every transport unwired. W1b is the wiring for the socket, and nothing else — the REST middleware is another track's.

## Scope

1. **Per-socket sealing in `WSHub`.** `broadcast` currently serialises **once** and sends one buffer to N clients; per-socket contexts mean **N seals for N sockets**. Measure it on a terminal-output-sized frame and report the number rather than asserting it is fine — the hot path is exactly where a "microseconds" claim goes unchecked.
2. **The ticket travels in a request header, not the URL.** `?ticket=` lands in every ingress access log — Cloudflare logs full request URLs — and single-use plus 30 seconds bounds that damage without removing it. React Native's `WebSocket` accepts custom headers, so the ticket never needs to touch a URL. Accept it from `X-TB-Ticket`, consumed **single-use**; `?key=` stays only for unpinned legacy devices. Re-read M12 and `NONCE-DESIGN` §10/§12 before implementing.
   **The log test asserts the ticket never appears in `http.request` at all — not even reduced to `_`**, because a header that is never a query parameter has nothing to reduce.
3. **A pinned device presenting `?key=` is refused through W1a's 426 helper** — not a second implementation of the pin check.
   **W1a's stated limit carries over and is not W1b's to close:** a pinned device presenting the *shared* API key resolves to the `legacy` principal with no device row, so the pin cannot bite there. That is the stage-3 shared-key problem the design already names, not a gap in this PR.
4. **Strict `counter == expected` on the socket**, no window; a violation logs `e2ee.sequence_violation` and closes with reason **`E2EE_SEQUENCE_VIOLATION`**.
5. **A socket's close destroys its own context** — `registry.destroy(ctxId)` on close, and **never** the device's REST context, which must survive so the HTTP replay fallback keeps working while the socket is down. A reconnect is a **new** `/open`. Test: after close the old `ctxId` is unknown, and the same device's REST context still resolves and still seals.
6. **Revocation reaches live sockets** — wire `POST /api/devices/:id/revoke` to the registry's `destroyDevice`, which W1a shipped and W1b connects. The route currently has no reach into the hub or the registry.

## Carried in from the six adversary rounds — these are requirements, not ideas

- **Narrow the bare `catch {}` in `handleWsMessage` to JSON parsing only.** It currently swallows everything, and W1b puts sealing inside its reach — a seal failure would become a silently dropped frame. A seal failure gets its **own** close reason, `E2EE_SEAL_FAILED`, distinct from a sequence violation: **a seal failure is a server-side fault; a sequence violation is a claim about the peer.**
- **Seal-and-send is one synchronous step.** Any `await` between `seal` and `ws.send` reorders frames, and the peer's strict counter then closes the socket. There is an `await getOutputLines(...)` on that path today.
- **Ticket consumption is a synchronous map delete before any `await`.** Otherwise two upgrades race one ticket.
- **State the `@hono/node-ws` ceiling.** It hardcodes its `WebSocketServer` with no `maxPayload`, so `ws`'s 100 MiB default applies and a frame is fully assembled before any record-layer bound runs. W1b either constructs its own server with a bound, or accepts the ceiling and **reaps any socket that has not sent a valid sealed frame within N seconds** — and says which.
- **Per-direction frame ceilings**: client→server frames are small control messages (64 KiB is generous); server→client `terminal_replay` needs its own, larger bound. The server bounds c2s, the client bounds s2c.
- **App-level `ping` frames are sealed like any other frame and consume counters.** That is correct and costs nothing — worth one sentence so nobody "optimises" it away, since WebSocket protocol pings are invisible to the client's JS layer and its silence timer depends on the app-level frame.

## Done means

Terminal output, replay, conversation events and user messages are **ciphertext on the wire** — a capture of a real socket shows no plaintext `type` field — with a **negative control** proving the capture harness sees plaintext when sealing is off.

Four tests, each **seen red** before it passes:

| | Test |
|---|---|
| a | **Nonce reuse** — no **`(ctxId, direction, counter)`** repeats across a full session including a reconnect, **and the two `ctxId`s differ**. *(An earlier draft said `(direction, counter)`, which is false as written: §8 makes a reconnect a new context whose counters legitimately restart at 0. The pair-plus-distinct-ctxId assertion is what makes the restart safe, and asserting the narrower tuple would have failed on correct behaviour.)* |
| b | **Ticket single-use under a race** — two concurrent upgrades with one ticket, exactly one accepted |
| c | **Revocation during a live context** — the socket closes, the context dies, the next frame in either direction is rejected, and **other sockets' broadcasts are unaffected** |
| d | **Broadcast independence** — a broadcast to N sockets seals N distinct `(direction, counter)` pairs, and a slow client does not block the hub (asserted, not merely measured) |

## Method, unchanged from W1a because it worked

Real `WSHub`, real `ws` sockets on a loopback server, real record states — no stubbed cipher for the transition under test. One mutation per safeguard, applied, **seen red**, reverted, reported with the failing test name and verbatim assertion. The driver applies inside `try`, reverts in `finally`, asserts a clean tree after every mutation, and halts rather than counting a patch whose target has moved. The campaign is re-run on every refreeze, never carried forward.

**An isolated adversary is the acceptance**, in its own worktree at the exact commit, briefed from `ADVERSARY-BRIEF.md` — including the rules that file now carries: assert that no buffer renders at all, every detector needs a negative control, and a test that cannot run is not a pass.

## Explicitly not in W1b

The REST unseal/seal middleware and its sliding window; `X-TB-Seq`; the `Authorization`-names-the-context rule; `--no-e2ee`; anything mobile; and the stage-2 `e2ee` flag default, which is R's and is user-gated.
*(An earlier draft of this line said `E2EE_SUPPORTED` was the pending flip. That constant already flipped in #674, v1.69.0 — the flip still waiting on evidence and an explicit decision is R's stage-2 default, not this one.)*

---

## Rulings, 2026-08-29 evening (independent reviewer AGREE on both, owner relayed)

### Q1 — a ticketed upgrade carries no `Authorization`

Ticket consumption moved from `ws.routes.ts` into `auth.middleware.ts`, because the principal must come from the context before the route runs. The reviewer traced the tree and confirmed the property the ruling exists to create: **the context is set in exactly one place** — the ticket block, with a principal built from that context's own device row — and **every fall-through path sets a principal but never a context**.

- `consumeTicket` stays **before** the revoked/mismatch checks; both refusals are terminal, so no `wouldConsume` peek.
- **Verified independently:** the two `await next()` calls above the `/ws` branch are early returns (public paths, local-only paths), so **nothing awaits before the consume on the ticket path**.
- **A1** — the tail (`ctxId` → context → device row → principal + `revoked_at` re-check + credential-mismatch refusal) is **one exported helper** beside `refuseUnsealedIfPinned`; the REST track consumes it for `X-TB-Ctx` rather than forking a copy.
- **A2** — invariant, as a test and in §13: *a context-attached socket's `principal.deviceId` always equals its `context.deviceId`; a credential beside a ctx or ticket must name the same device or the connection is refused.* The **shared API key names no device and is therefore a mismatch, not an exemption.**
- **A3** — client rules into §11/§13.

**The `401`-not-`426` contract item.** A ticket-only upgrade whose ticket is spent or expired gets `401` — there is no credential left to resolve a device principal from, and `426` needs one. **Resolved better than the status code:** React Native cannot read an upgrade's HTTP status at all, so *any* failed upgrade on a ticketed socket is handled as `E2EE_CTX_UNKNOWN` — one fresh `/open`, one retry, then a visible error, **never the re-auth path**. The contract cannot depend on a status the acting party never sees.

### Q2 — option 2: the 10 s deadline, and nothing else

A **10 s first-valid-sealed-inbound-frame deadline** from the 101, counted on **any** valid sealed inbound frame — *not* coupled to `register`, which is one way a client satisfies it rather than the condition itself. 10 s stands; 15 s (the client's own connect timeout) is the only permitted fallback, never lower.

**The 60 s inbound-liveness rule is withdrawn for good.** It would have reaped attentive idle users: the app-level `ping` is **server→client only**, and the four client→server types are all user-driven, so a phone watching a session sends nothing inbound while the user reads. *The rule could not tell a thief from an attentive user — both are silent inbound.*

**Option 4 (provisional socket, context attached at first sealed frame) was tabled and withdrawn:** `handleWsOpen` sends `session_list` and `cache_ready` **synchronously at open**, and `sendTo` with no context takes the legacy plaintext path — so option 4 would have put those frames, including every session's project path, **in the clear on a socket meant to be sealed**. The mirror image of the close-window case `everSealed` already closes.

**The residual, in the reviewer's words:** a thief holds a TCP slot and hub membership on an **orphaned** context (the legitimate client has re-opened to a fresh `ctxId`), receives only low-frequency global broadcasts, **never a session subscriber**, for **≤10 s**.

### The invariant that survives whichever option wins

> **A socket that consumed a ticket is never on the plaintext send path.**

Half already held (`everSealed` is set at attach, not at first seal). The other half was a real gap: `sendTo` never consulted it and fell through to plaintext. **Unreachable today — but unreachability was doing the work, not a guard.** Now drop-and-close, with M16 red on the restored fall-through.

## Open: `authenticateContext`'s destroy-on-mismatch — with the reviewer

**W's position, and the decisive argument: destroying on a credential mismatch is a DoS vector.** `X-TB-Ctx` carries the `ctxId` **in a plaintext header on every sealed request**, so it is observable to exactly the on-path party this design assumes. If a mismatch destroys the context, anyone who sees one request can kill that device's context repeatedly by forging a mismatched credential beside the observed id.

- **Revoked** — trigger is a fact about our database, unforgeable; the destroy is required.
- **Mismatch** — trigger is a header **the attacker supplies**; refusing is the whole requirement, and destroying hands them a weapon.

Harmless on the WS path (the ticket is spent) and **not** harmless on the REST path — and *a helper whose effect is safe for its first caller and dangerous for its second is the wrong thing to freeze at a tag*. Ruling expected: helper returns a verdict, caller applies the effect. **Adversary row either way:** observe a `ctxId`, then try to destroy that context with a mismatched credential.

## Cross-track

X-server has GO for a bounded `context.ts` edit (`#window` on REST contexts; `unsealRequest` → `unsealUnchecked` + `#window.admit()`, ~:155–240). W's edits are `TICKET_HEADER` (~:51) and the appended helper (>:656) — **no textual overlap**. Whoever merges second rebases and re-runs the **full** campaign with an adversary row for the merged file.

**`NONCE-DESIGN.md` is owned by the implementer for this PR.** W promised a rev12 and withdrew it: the implementer had already written §8, §13 and §15 in its worktree, and sending a copy would have created **two writers on one file** — the exact hazard this programme guards against, and an absurd one to create in the last mile over a document about not creating it. W reviews the §-edits as part of the diff and asks for changes rather than editing behind it.

---

## The frozen cross-track seam — `authenticateContext`

**Freezes at W1b's merge**, the way W1a's four codes froze at its tag. The REST track builds against this text and rebases onto W1b's merge, so **no interim shape may be merged**.

```ts
export type DevicePrincipal = Principal & { kind: "device"; deviceId: string };

export type E2eeContextAuth =
  | { ok: true; principal: DevicePrincipal }
  | { ok: false; reason: "device-revoked" | "credential-mismatch" };

export function authenticateContext(args: {
  context: E2eeContext;                  // already resolved by the caller
  devicesRepo: DeviceLookup | null | undefined;
  presented: string | undefined;         // credential beside the context; undefined = none = ordinary success
}): E2eeContextAuth;
```

**Never destroys. Never logs.** Invariant: `principal.deviceId === context.deviceId` — the principal comes from the **context's device row**, never from the credential.

Design decisions and why, since each is a place a WS-shaped helper would not have fitted REST:

| Decision | Reason |
|---|---|
| Takes the **resolved context**, not a `ctxId` | "No such context" is the caller's outcome, not the helper's; and a `ctxId` input lets the deadline expire *between* the caller's resolve and the helper's own lookup, giving two answers in one request |
| `reason` only — **no status, no body** | HTTP policy inside a two-consumer helper. REST maps `reason` to statuses, W1b maps it to close reasons |
| **No logging** | REST calls it per request; a logging helper is a log line per request |
| Discriminated result, not a boolean or a throw | The two callers apply different effects to the same verdict — which is the whole ruling. A throw makes both re-derive the outcome from a message |
| **Never destroys** | Destroy only on a trigger our database owns (`revoked_at`); never on an attacker-supplied header. Otherwise the safeguard becomes a **DoS**: `ctxId` travels in a plaintext header, so anyone who sees one request could kill that context repeatedly |

Three semantics **named in the type** because each is a fail-open the REST track cannot close after the freeze:

1. **No store, unreadable store, or a throwing `get()` is a refusal** — never success, never a throw out of the helper. *A downgrade guard that defaults to allowing the downgrade is not a guard.*
2. **`device-revoked` covers a missing row as well as a set `revoked_at`** — absent ≠ invalid, and neither is success.
3. **`credential-mismatch` includes a credential naming *no* device** — the shared API key is a mismatch, not an exemption. "Names another device" read literally would exclude it.

Plus: read `revoked_at` with `Object.hasOwn`, so a row lacking the column cannot read as live.

## Filed, not built: streamer #743

**`registry.destroy()` unmaps but does not invalidate.** It deletes from `#contexts`/`#byDevice`, sets no dead flag, and `sendState()` has no post-destroy refusal — while `ws-hub` holds its **own** reference to the same object. So a holder of a destroyed context keeps sealing and unsealing successfully.

Revocation is safe today **only because** `destroyDevice` is paired with `wsHub.closeContexts()`, whose close path drops the hub's reference. Any future caller that destroys without telling the hub leaves **a live socket sealing on a context the registry no longer knows about** — no error, no log, a connection outliving its own revocation. One `#destroyed` flag checked in `sendState`/`receiveState` away from impossible.

**Not in W1b or the REST PR** while both have `context.ts` open — the stop-and-coordinate case.

**A zeroing task was considered and deliberately not filed:** after W1a's migration the JS-side buffer is already zeroed at import (`allocUnsafeSlow` → `createSecretKey` → `fill(0)`) and a `KeyObject` **cannot be wiped from JS**. The only real mechanism is dropping references for GC, which is a different and much weaker property. Filing it as written would have produced a ticket nobody could complete.

---

## Merge requirement: the squash title must be a releasing type

**`feat(e2ee): …`** (or `fix`), **never `refactor`/`chore`.** X-server, X-client and R1 all key off the release tag, and W0's `refactor` cut none — `.releaserc.json` releases on `feat`/`fix`/`perf` and nothing else.

The intended title goes in the message sent for approval, so it is agreed before the merge rather than discovered after.

**Verify the classification on the merged commit by calling `generateNotes` directly** — with the repo's preset config and the real commits since the last tag — **not** `semantic-release --dry-run --no-ci`.

That is #742's lesson: run from a non-`main` branch, the dry run **exits 0 having never reached `generateNotes`**, because semantic-release stops at "this branch is not a release branch". A green that means the code never ran, in the tool we were using to check whether releases work.

The direct call is also what proved that fix, with a control: same script, same commits, only the preset version differing — the broken one threw, the pinned one completed.
