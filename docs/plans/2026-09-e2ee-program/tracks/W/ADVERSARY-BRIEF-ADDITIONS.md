# `record-layer-adversary` — attempts added by the 2026-08-29 review

These are **in addition to** `tracks/W/prompt.md`'s original list (nonce reuse across reconnect and rekey, counter rollback, replay into the same and another context, truncated and oversized bodies, `ctxId` confusion, a reflected frame).

Every row is reported as exactly one of `rejected: <evidence>` / `succeeded: <finding>` / `not attempted: <reason>`. An omitted row reads as covered, which is the failure the table exists to prevent.

## W1a

1. **Replay one captured `/open` msg1 ×1000.** Count live contexts and tickets, measure heap. Expect a bound. (§8 provisional contexts, per-device cap, rate limit.)
2. **`/open` with an unknown static key, and with a revoked one.** Expect refusal *before* any context or ticket exists; measure that nothing was allocated.
3. **Consume a ticket from a second connection before the client does.** Expect the client's upgrade refused, the thief's socket reaped within N s, and no plaintext frame ever on it.
4. **Inject a frame carrying the socket's `ctxId`, a wrong counter and a bad tag.** Record *which* code fired and whether the log line blames the device. Under §5's ordering this must be a seal failure, not `E2EE_SEQUENCE_VIOLATION`.
5. **Two concurrent `/open`s for one device, then use only the second.** Expect the first to expire at its provisional TTL.
6. **A frame with the right `ctxId` on another device's socket; and a REST record (`channel 0x02`) delivered as a WS frame.** Expect rejection before the AEAD, by channel or context — and say which check fired.
7. **A frame captured before a key change and replayed after it** (only meaningful under §6 Alternative A). Must be rejected twice over — by the counter and by the key — and the report says which fired first.
8. **Reflection, rollback, truncated and oversized bodies, `ctxId` confusion** — as originally briefed.

## W1b

9. **Seal, then await, then send, under a slow output read.** Expect no client-side sequence violation — seal-and-send must be one synchronous step.

## Later tracks (recorded here so they are not lost)

10. Swap two concurrent sealed REST responses within one context.
11. Re-route a sealed `POST /api/sessions/A/input` to session B.
12. Inject a plaintext `401`, `304` and `426` in answer to a sealed request.

## Key-hygiene class (added 2026-08-29, after a real occurrence)

13. **Make an assertion fail on a state object and read what it prints.** A failing `expect(...).toBe(null)` on a context serialised the nested record states including the traffic key `k` — straight into test output, and in CI into a public log. Fixed by making `k` non-enumerable, with a test and its own red mutation.
    - The leak path is `util.inspect` / the test runner's differ, **not** `JSON.stringify` — `JSON.stringify` on a record state *throws* on the `bigint` counter, so it is not the protection anyone might assume.
    - Attempt this against every object the implementation exposes: record states, contexts, the registry, the ticket store, and anything a route returns on an error path.

## Second-review rows (2026-08-29, re-review)

14. **REST provisional cliff.** Open a REST context, wait past 30 s without sending a request, then send the first sealed request → expect `E2EE_CTX_UNKNOWN`. Confirm whether anything in msg2 warned the client that the advertised lifetime was conditional.
15. **REST target canonicalization.** Seal a request for a path containing `%2F` with a two-parameter query; serve it with the path percent-decoded and the parameters reordered → the target hash must fail unless both sides used the raw wire request-target.
16. **`/open` rate-limit collapse.** Drive N ≥ 6 `/open`s from one source address (the tunnel case, where every caller is `127.0.0.1`) → does legitimate multi-device recovery trip the global 5/min bucket? Measure the re-open-storm shape after a simulated restart.
17. **Eviction order.** Open three same-kind contexts for one device with the **oldest actively in use** → record which is destroyed, and whether an in-flight request on an evicted context is dropped without a client-visible retryable code.
18. **`RestResponseSealer` saturation.** Accept more than `MAX_OUTSTANDING` request counters, then seal the response for the evicted oldest → expect a **retryable** outcome, never a dead-end `E2EE_SEAL_FAILED`.
19. **Key hygiene, extended.** `util.inspect(state, { showHidden: true })`; force the `/open` 500 path (make `writeMessage2` throw) and grep its logged `err` for key bytes; inspect a raw `HandshakeKeys` value, which is a plain object the `hideKey` wrapper never touches.
