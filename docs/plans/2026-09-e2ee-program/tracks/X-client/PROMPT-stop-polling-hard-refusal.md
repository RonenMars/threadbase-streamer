# The client keeps polling a server that hard-refused the handshake

**Status, 2026-09-02 (C1): item 1 is BUILT AND VERIFIED on a branch. Item 2 is OPEN — the retrying layer is still unidentified.**

This file began as a brief written from a hypothesis. It is now the record of what was actually found. The parts that were guesses are marked as such, and the candidates that have been eliminated are listed with the evidence that eliminated them, so the next session does not re-propose one of them.

Repo: `threadbase-mobile`. Branch `fix/e2ee-permanent-refusal`, off `origin/main` `26815a16`. Not yet a PR.

---

## The mechanism — confirmed, reproduced twice, no longer a guess

A permanent refusal launders itself into a retryable one:

1. `403 E2EE_DEVICE_REVOKED` is a permanent condition, correctly classified non-retryable (`services/e2ee/context.ts:80` — `retryable` is true only for `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT`) and correctly surfaced as *"This device is not paired for encryption"*.
2. Something above the transport re-issues the request anyway — 5 × 403 within seven seconds.
3. Those failures charge the streamer's per-source failure budget, so it starts answering **429**.
4. `services/e2ee/context.ts:212-214` maps `429` → `E2EE_TRANSIENT`, whose `retryable` is **true**. The client now believes a permanent condition is temporary and loops at roughly one attempt per 1.5 s, while the on-screen text degrades to the false *"The server is busy; retrying shortly"*.

Measured (D2 row 8, deliberate revocation): 10 × 403 then 60 × 429 in under two minutes, still climbing when counting stopped. The same shape appeared unprompted that morning from a second device pinned to a different server identity: 168 × 400 and 43 × 429 over six minutes, pinned at exactly 30 failures/minute.

Evidence: `tracks/D/evidence/d2-row8-revocation-and-the-429-laundering.md`, `tracks/D/evidence/d2-field-observation-open-failure-storm.md`.

**`mapOpenFailure` is not the bug and has not been changed.** A `429` really is transient. What was wrong is that a transient answer was allowed to overwrite a verdict already reached.

---

## Which layer issues the retries — STILL UNIDENTIFIED

This is item 2 and it is not answered. What follows is the elimination record.

### Ruled out, with evidence

**The websocket connect-time catch — `services/ws-client.ts:229-231`.** Read on `origin/main` `26815a16`:

```ts
if (error instanceof OpenError && !error.retryable) return
this._scheduleReconnect()
```

It returns *without* scheduling a reconnect, and the comment above it states the rule that it must never fall back to the URL credential. It honours the classification. **Not the source.**

**`sealedFetch` — `services/authed-fetch.ts:348-351`.** An `OpenError` out of `acquireRestContext` is rethrown as `EnvelopeError(err.code, err.message, path, err.retryable)`, so a non-retryable open stays non-retryable. **Not the source.**

These two are the obvious candidates and they were already eliminated before C1 started. A model that settles on the first plausible story will re-propose one of them.

### Considered and found not to match

**The websocket close-time path.** It goes to backoff with no `retryable` check, so it is a genuine gap — but the backoff cadence does not match the observed ~1.5 s.

**The 45 s silence timer** (`WS_SILENCE_TIMEOUT_MS`, `hooks/useTerminalStream.ts:25`). Wrong order of magnitude for a ~1.5 s cadence. It is a real defect in its own right — measured at 3.1 context opens/min against a 5/min limit, 62 % of the budget burned at idle (`d2-row6-silence-timer-churn.md`) — and it belongs to C2, not here.

### Still a hypothesis — nobody has checked it

**The client-log shipper.** `POST /api/__client-log` is itself sealed, so every failed open manufactures log lines that need a context, which needs an open, which fails — a self-feeding loop at plausibly the right rate. **This has not been verified.** It needs the device's own client log, which group G is to capture on hardware. Do not implement against it.

---

## Item 1 — built, and it does not depend on naming the layer

**A permanent verdict per server, which a later `429` cannot reset.**

`openContext` is the one point both channels funnel through — websockets via `openContextOnce` (`ws-client.ts:200`), REST via `rest-session`'s opener. A verdict consulted there, in front of the network, closes every candidate layer at once, whichever one turns out to be issuing the requests. That is why item 1 was safe to land first and alone.

### The rules as built

| | Rule | Where |
|---|---|---|
| R1 | A non-retryable `OpenError` out of the handshake records a verdict for that `serverId`, with the pin it was reached under | `context.ts` `openContext` |
| R2 | While a verdict stands, the open throws the remembered error immediately — no network call | `context.ts` `openContext` |
| R3 | A retryable outcome (`429`, 5xx, unreachable) neither records nor clears | `context.ts` `openContext` |
| R4 | A different `serverPublicKey` drops the verdict and proceeds | `context.ts` `openContext` |
| R5 | A successful handshake drops the verdict | `context.ts` `openContext` |
| R6 | Re-pairing drops the verdict | `stores/servers.ts` `addServer` |
| R7 | An explicit user retry drops the verdict | `hooks/useSession.ts` `retryFailed` |

**It does not clear on a foreground or a network blip**, and each was checked rather than assumed: `rest-session.onAppState` only sets `needsRollover`; `ws-client.forceReconnect` is untouched, deliberately, because it fires on every foreground *and* on the 45 s timer; an unreachable server maps to `E2EE_TRANSIENT`, which R3 makes inert.

**The user-visible text does not regress.** The remembered message is the one the verdict was reached under, so *"This device is not paired for encryption"* is what every later caller sees. The busy message can no longer replace it, because it only exists on a request that is no longer made.

### Verification

- **Negative control, run first, against unmodified `origin/main`:** twelve attempts against one `serverId` produced **12 requests** and the message degraded from the true one to the busy one at the `429` boundary. The storm is real and was observed before anything suppressed it.
- **Positive controls:** a `429` alone, a 5xx, and an unreachable server all keep retrying and record nothing. A fix that stopped all retrying would fail these.
- **Five falsifiability mutations, each seen red, each turning exactly one test red.** Full table in `tracks/X-client/FINDINGS-C1-permanent-refusal.md`.
- Gates: unit 1848/1848 (187 suites), integration 472/472, jest e2e 59/59, `tsc` 0, `eslint` 0.

### One consequence, stated rather than buried

Making every non-retryable code sticky means the mispinned-device case (the 17 Pro, `400 E2EE_HANDSHAKE_FAILED`) no longer self-heals when the hostname points back — recovery becomes one Retry tap. The trade is deliberate: through a Cloudflare tunnel every device collapses to `127.0.0.1` and shares one budget, so a self-healing storm costs the whole fleet. Flagged to the owner rather than decided silently.

---

## Item 2 — what is left

Name the layer, then make it consult `retryable`. Item 1 stops the loop; it does not stop the layer firing once per permanent failure.

If group G cannot reproduce the storm, item 1 ships alone and item 2 is recorded open with the layer unknown. **Do not guess the layer into a fix.**

---

## Related, not the same thing

The server-side gap is separate and is already fixed in the streamer (shipped in `v1.74.0`): the `readMessage1` failure branch used to emit no `e2ee.*` event at all, so a device stuck this way was undiagnosable server-side. That fix does not remove the need for this one — it only makes the next occurrence visible.
