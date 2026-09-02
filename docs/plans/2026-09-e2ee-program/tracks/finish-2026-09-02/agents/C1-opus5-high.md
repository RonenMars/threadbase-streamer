# C1 — the retry loop that turns a permanent refusal into an infinite one

**Model: Opus 5. Effort: high.** Reason: the central question — which layer issues the retries — is open, and the obvious answer is already ruled out. This is diagnosis across a log shipper, a socket close path, a timer and a query cache, from a server-side cadence. A model that settles on the first plausible story will re-propose the layer that was eliminated on 2026-09-02.

Repo: `threadbase-mobile`, worktree `../tb-mobile-worktrees/<slug>`. You hold the mobile PR slot; C2 waits behind you.

## What is known, and how well

**Proven, reproducible on demand.** Revoke a paired device server-side while the app is open and the client retries forever:

1. `403 E2EE_DEVICE_REVOKED` — a permanent condition. Correctly classified non-retryable (`services/e2ee/context.ts:80`: `retryable` is true only for `E2EE_CTX_UNKNOWN` and `E2EE_TRANSIENT`) and correctly surfaced — the Servers Status sheet reads *"This device is not paired for encryption"*.
2. Something re-issues the request anyway — 5 × 403 within seven seconds.
3. Those failures charge the server's per-source failure budget, so it starts answering **429**.
4. `services/e2ee/context.ts:212-214` maps `429` → `E2EE_TRANSIENT`, whose `retryable` is **true**. The client now believes a permanent condition is temporary and loops at roughly one attempt per 1.5 s, while the on-screen text degrades to the false *"The server is busy; retrying shortly"*.

Measured: 10 × 403 then 60 × 429 in under two minutes, still climbing when counting stopped. Full evidence: `tracks/D/evidence/d2-row8-revocation-and-the-429-laundering.md`. The same shape appeared unprompted that morning from a second device pinned to a different server identity: 168 × 400 and 43 × 429 over six minutes (`d2-field-observation-open-failure-storm.md`).

**Not known: which layer.** Ruled out — the connect-time catch at `services/ws-client.ts:231` returns without scheduling a reconnect, and `sealedFetch` throws `EnvelopeError(..., retryable: false)`. Both honour the classification. Neither the close-time path (which goes to backoff with no `retryable` check) nor the 45 s silence timer matches a ~1.5 s cadence.

**A hypothesis, not a finding:** the client-log shipper. Its `POST /api/__client-log` calls are themselves sealed, so every failed open manufactures log lines that need a context, which needs an open, which fails — a self-feeding loop at plausibly the right rate. Nobody has checked. Group G will capture the device's client log during its rig session; the owner will relay it.

**Treat `tracks/X-client/PROMPT-stop-polling-hard-refusal.md` as evidence and a shape, not as an accepted specification.** It was written before the mechanism was understood and it says so.

## Item 1 — start now, it needs nobody

**A permanent verdict per server must survive a later `429`.** Once a non-retryable code has been seen for a `serverId`, a subsequent `429` is the rate limiter reacting to our own retries, not new information, and must not reset the verdict.

This is caller-independent: it closes every candidate layer at once, whichever one turns out to be issuing the requests. It is the item worth landing first and alone.

Design notes, not instructions:

- Prefer whatever per-server state already exists over a new store.
- It must clear on events that genuinely change the condition — re-pairing, a pin change, an explicit user retry — and must **not** clear on a foreground or a network blip, or the storm returns with extra steps.
- The user-visible text must not regress. *"This device is not paired for encryption"* is the true statement; the busy message is the false one that currently replaces it.
- Never fall back to the URL credential and never downgrade to plaintext. `ws-client.ts:229-231` states this and it stays true.

## Item 2 — after the log arrives

Name the layer. Then make it consult `retryable`, because item 1 stops the loop but does not stop the layer from firing once per permanent failure.

If G cannot reproduce the storm, ship item 1 alone and record item 2 as open with the layer unknown. Do not guess the layer into a fix.

## Verification bar

- **Real objects on the production path.** The real classifier and the real caller, not a stubbed seam for the transition under test.
- **Negative control first**: with the guard absent, the test must *observe the repeated calls*. The storm has to be visible before the fix suppresses it, or the test proves nothing.
- **Positive control**: a genuinely retryable refusal (`E2EE_CTX_UNKNOWN`, `E2EE_TRANSIENT`) still retries. A fix that stops all retrying is a regression, not a fix.
- **Falsifiability mutation per rule**, reported as `<file>::<test>` with the verbatim assertion. At minimum: remove the sticky verdict → the storm test goes red; let a `429` reset the verdict → the same; break the clear-on-re-pair path → a recovery test goes red.
- Full unit suite, tsc, lint before asking for commit approval.

## Reporting

To the owner, not the user. Report: the item-1 diff shape and its mutation results as soon as they exist; whether the log identified the layer; and what you deliberately did not do. Ask the owner before opening the PR — the mobile slot is shared.

## Documents you keep current

The owner commits after each milestone and can only commit what exists. Keep these current as you go:

- `tracks/X-client/PROMPT-stop-polling-hard-refusal.md` — it is currently a hypothesis document. As the layer is confirmed or eliminated, it becomes the record of what was actually found; say which candidates you ruled out and how.
- A short findings note for anything that changes the picture — especially if the client log names a layer nobody expected, or if the storm cannot be reproduced at all.

Your milestones: item 1's reproduction red in a test · item 1 merged · the layer named or recorded unknown · item 2 merged or deferred. Report each to the owner as it happens.

## Stop-work

Anything that would make a sealed request fall back to plaintext, anything that would require force-updating released apps, or a private key or device token appearing in a log or test fixture.
