# `record-layer-adversary` — W1a brief

Assembled 2026-08-29, ready to dispatch when `e2ee-owner` lifts the spawn hold.
Merges `tracks/W/prompt.md`'s original list with the additions from `tracks/REVIEW-2026-08-29-mega-brain.md` (M10 + "Verifier additions") and the key-hygiene class found in W1a's first implementer run.

## Dispatch rules

- **Its own worktree**, `.worktrees/audit/e2ee-record-adversary`, checked out at the **exact commit under review**, `node_modules` symlinked. Never the implementer's tree, never W's.
- **One-shot synchronous** `general-purpose` agent, so the report returns as the tool result. A named teammate loses the report; an idle notice is not a deliverable.
- **Isolated**: it gets the spec paths and the built worktree, and nothing else — no plan, no diff history, no conversation, no knowledge of what the implementer intended.
- Opus 5 / high. Do not lower it.
- It gets `NONCE-DESIGN.md`, `design.md` §3–§4, `remaining-work.md` Phase 3. It does **not** get this file's provenance or the review.

## The report format is the acceptance

Every numbered attempt below appears in the report as exactly one of:

- `rejected: <evidence>` — with the runnable code and the observed rejection
- `succeeded: <finding>` — with the exploit
- `not attempted: <reason>`

**An omitted row reads as covered, which is the "filtered sample reported as exhaustive" failure this table exists to prevent.** "Could not break it" *with the complete table* is the acceptance; an assertion without an attempt is not.

## Attempts

### Nonce and counter
1. Nonce reuse across a reconnect. (Contexts are per-socket — a reconnect is a *new* context, so a repeated `(direction, counter)` under a *new* key is expected and is not a finding. A repeat within one context is.)
2. Counter rollback.
3. Replay of a captured frame into the same context, and into another.
4. A reflected frame — a server→client record fed back as client→server.
5. `ctxId` confusion between two live contexts.
6. A frame with the right `ctxId` delivered on **another device's socket**; and a REST record (`channel 0x02`) delivered as a WS frame. Expect rejection before the AEAD, by channel or context — **say which check fired.**

### `/open` and allocation (all D-9 class)
7. Replay one captured `/open` msg1 ×1000. Count live contexts and tickets, measure heap. Expect a bound.
8. `/open` with an unknown static key, and with a revoked one. Expect refusal **before any context or ticket exists**; measure that nothing was allocated.
9. Two concurrent `/open`s for one device, then use only the second. Expect the first to expire at its provisional TTL.
10. Truncated and oversized bodies before decrypt. Expect refusal without buffering.

### Tickets
11. Consume a ticket from a second connection before the client does. Expect the client's upgrade refused, the thief's socket reaped within N s, and **no plaintext frame ever on it**.

### Attribution
12. Inject a frame carrying the socket's `ctxId`, a **wrong counter and a bad tag**. Record which code fired and whether the log line blames the device. Under §5's ordering this must be a seal failure, **not** `E2EE_SEQUENCE_VIOLATION` — the codes' frozen semantics depend on it.

### Key hygiene (a real occurrence, not hypothetical)
13. **Make an assertion fail on a state object and read what it prints.** A failing `expect(...).toBe(null)` on a context once serialised the nested record states including the traffic key `k` — into test output, and in CI into a public log.
    - The leak path is `util.inspect` / the test runner's differ, **not** `JSON.stringify` — that throws on the `bigint` counter, so it is not the protection it looks like.
    - Try it against every object the implementation exposes: record states, contexts, the registry, the ticket store, and anything a route returns on an error path.

## For W1b, and for later tracks — recorded so they are not lost

14. (W1b) Seal, then await, then send, under a slow output read. Expect no client-side sequence violation.
15. (REST) Swap two concurrent sealed responses within one context.
16. (REST) Re-route a sealed `POST /api/sessions/A/input` to session B.
17. (REST) Inject a plaintext `401`, `304` and `426` in answer to a sealed request.

## What is *not* a finding

- A repeated `(direction, counter)` in two **different** contexts. §6: a new key is a new context; uniqueness is scoped per context.
- The absence of in-place rekey. It was removed deliberately by the user's ruling; `rekey()` should not exist.
- Traffic keys appearing inside `__tests__/fixtures/*.json`. Those are the interop vectors, deliberately committed, and are the same values published on `main` since #631.

## Evidence hygiene for the adversary itself (added after round 1)

Round 1's finding-B demo printed a full 32-byte traffic key into its report, which then had to be kept out of `tracks/` and the PR body by hand.

**Demos and assertions print key LENGTHS or HASHES, never bytes.** `expect(rendered).not.toContain(sha256(key).slice(0,16))` proves the same thing as quoting the buffer and cannot leak. The assertion style is what propagates key material into CI logs, and a leak-hunting test that leaks is its own finding.

## The assertion shape for key-hygiene checks (from W1a round 2)

**Assert that no buffer renders at all**, rather than searching a rendering for a known key:

```js
const rendered = inspect(obj, { showHidden: true });
expect(rendered.includes("<Buffer") || rendered.includes('"type":"Buffer"')).toBe(false);
```

Three properties make this the right shape and `expect(rendering).not.toContain(secret)` the wrong one:

1. **No key bytes appear in the test**, in its failure output, or in anything capturing either — a `not.toContain` failure prints the whole rendering, so the assertion proving keys are hidden publishes them the first time it fails.
2. It catches key material the test **did not know to look for** — a second key, a chaining key, a nested state object added later.
3. It needs no needle, so it cannot rot when the key it hunted is renamed or moved.

Pair it with a control: a plain object holding the same value **must** render, or the detector is passing because it sees nothing at all.

## Every detector needs a negative control

Not optional. A detector that silently never fires is indistinguishable from a clean result. The strongest evidence produced in W1a was a 40,000-iteration fuzz whose negative control — a stand-in carrying the pre-fix bookkeeping — the same harness caught.

## A test that cannot run is not a pass

Program-wide, from two instances in W1a.

A mutation campaign reports a safeguard as verified when the mutated code makes its test go **red**. Two ways that inference silently breaks:

1. **The mutated module fails to parse**, so no test runs and no `×` line is printed — and a driver scanning for failures reads the absence as "the property held". This produced a false green on the `#private` mutation, i.e. on exactly the safeguard that round of work existed to add. The driver must print `BROKEN — the mutated module did not run — this is not evidence` and halt.
2. **The test was deleted.** A bad edit removed four route tests and the suite stayed green, because a deleted test does not fail — it stops existing. Only re-running the campaign against the current tree found it.

**Absence of a failure line is not evidence. Only an observed red is.** Pair this with the driver rule: apply inside `try`, revert in `finally`, and assert `git diff --quiet` after every mutation.

## W1b rows (added at W1b plan approval)

1. **Seal, then await, then send**, under a slow output read — expect no client-side sequence violation. Seal-and-send must be one synchronous step.
2. **Two concurrent upgrades with one ticket** — exactly one accepted. Ticket consumption must be a synchronous delete before any `await`.
3. **Oversized frames through the WebSocket server** — the framework hardcodes its server with no payload bound, so a frame is fully assembled before any record-layer check. Establish whether W1b owns the server with a bound or reaps silent sockets, and test whichever it chose.
4. **Revocation with several live sockets and a REST context** — every context for that device dies and its sockets terminate, while *other devices'* broadcasts are unaffected.
5. **The ticket in logs** — drive a real upgrade and assert the ticket appears nowhere in `http.request`, not even reduced. It travels in a header, so unlike `?key=` there is nothing to redact and its absence is the property.
6. **Socket close** — the socket's own context is destroyed and its `ctxId` is unknown afterwards, while the same device's REST context still resolves and still seals.
