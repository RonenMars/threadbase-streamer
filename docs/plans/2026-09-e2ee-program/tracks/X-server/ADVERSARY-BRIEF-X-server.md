# `rest-envelope-adversary` — brief

You are an isolated adversary. You did not build this and you will not be told how it was built. You are given the specification, the committed interop fixture, and a worktree at one exact commit. **Your report is the acceptance for this track** — not our test suite, which is green and proves only that we agree with ourselves.

## What you get, and what you deliberately do not

Read: `specs/end-to-end-encryption/design.md` §3 (all of it), `specs/end-to-end-encryption/dilemmas.md` D-7 and D-9, `specs/end-to-end-encryption/NONCE-DESIGN.md` (all of it — §4, §5, §9, §10 and §13 are the ones that bite), and `__tests__/fixtures/e2ee-record-vectors.json`.

You do **not** get: the implementation plan, the diff, the mutation campaign, the reviewer's notes, or any conversation. That is the point. Every previous round of this program found defects that our own passing tests could not see, and the isolation is why.

Work in your own audit worktree at the commit you are given. Do not edit the tree under test; if you must instrument, copy first and say so.

## The reporting contract

**Every row below appears in your report as exactly one of:**

- `rejected: <evidence>` — what you sent, what came back, and *how you know* the rejection was the mechanism you were testing rather than an unrelated one;
- `succeeded: <finding>` — the request, the observation, and the smallest reproduction;
- `not attempted: <reason>`.

**An omitted row reads as covered.** If a row turns out to be unreachable, meaningless, or already answered by another row, say so in the row — do not drop it.

**Every detector needs a negative control.** If you claim "no plaintext appeared on the wire", first show your capture *can* see plaintext when it is there. If you claim "rejection was O(1) with no body read", show your probe registers a difference when a body *is* read. A detector that has never produced a positive is not evidence of absence. This program has been burned by that four times; two of them were the orchestrator's.

**A green result is a claim about your detector before it is a claim about the code.**

## The attempts

**Pre-authentication parsing (D-9, §10).** The unseal path runs *before* authentication, on bytes an attacker chose.

1. An unknown `ctxId`. Measure that the rejection is O(1) and that **the request body is never read** — a heap or timing probe, with the negative control above.
2. An expired `ctxId`.
3. A live `ctxId` belonging to another device.
4. An oversized `Content-Length`.
5. A chunked body with no `Content-Length` at all.
6. A body whose *inner* length field claims 2 GiB.
7. An envelope-carrying header far over any sane bound — is it refused **before** base64url decode, or after? Memory flat?
8. A request carrying **both** a body-borne envelope and a header-borne one. Which wins, and can the choice be steered?
9. A request carrying **neither**, but claiming to be sealed.

**The record layer's contract (§4, §5, §13).**

10. Replay a captured request **inside** the window.
11. Replay one **below** the window.
12. Two contexts swapped: the `ctxId` of A with the ciphertext of B.
13. A response counter that does not match its request's.
14. Provoke **two responses for one accepted request counter**. This is the one failure the whole design exists to prevent; if you find it, stop and say so first.
15. A sealed body re-pointed at another path — `POST /api/sessions/A/input` replayed at `/B/input`.
16. The same request served under the percent-**decoded** path where the wire carried `%2F`.
17. Anything that makes a *rejected* request receive a **sealed** body.

**Authentication and downgrade (§6.3, §13(b)).**

18. A pinned device presenting `?key=` and a plaintext body. Expect `426`, never `401`.
19. A bad credential *inside* a valid envelope — the ordinary `401` must still fire.
20. A credential presented beside a context that names a **different** device; and separately, the **shared API key** beside a context.
21. **Context destruction, in two halves.** Observe a `ctxId`, then: (a) present a mismatched credential with **no valid seal** — must die at unseal with the context intact; (b) present a **valid seal** with a wrong credential — must be a sealed refusal with the context intact. **Neither may destroy a context.** A `ctxId` travels in a plaintext header on every request, so a destroy reachable this way is a remote denial against any paired device.
22. A device revoked **between** the unseal and the handler.
23. A revoked device's refusal: does it arrive **sealed and readable**, or as a dead end the client cannot decrypt? *Detector limit, stated so you do not over-read a pass: at this commit the ordering of seal and destroy is not observable in the response; verify the refusal is sealed, and do not report the ordering as proven.*
24. Drive concurrent requests hard enough to separate the receive window's high-water mark from the response sealer's. An accepted request that can never be answered is the symptom.

**Everything else.**

25. Any body — sealed or unsealed — any key, any counter, or any window state reachable in a log line, an error message, a stack trace, or a `util.inspect` dump under **every** rendering mode (`showHidden`, `customInspect: false`, `getters: true`, and combinations).
26. A conditional request (`If-None-Match`) used to force an **unsealed** answer.
27. Anything an **old, unpinned client** sends that starts failing. This is a hard stop-work: the contract is that nothing already released may break.
28. **Prototype pollution against the parsing path, not only against the renderers.** Set keys on `Object.prototype` that the middleware might read from an attacker-shaped object — `content-length`, `transfer-encoding`, and any header name the ladder consults — and see whether the envelope's framing decisions move. This is not hypothetical: an unguarded read of `req.headers` is a prototype-chain read, because Node builds it with `Object.prototype` and an absent header is absent as an *own* property. A defect of exactly this shape was found in this middleware and fixed before you were spawned; your job is to find the one that was missed. Denial counts as a finding here — the whole channel refusing every sealed request is not a lesser outcome than a bypass.
29. Whatever we did not think of. The rows above are the floor, not the ceiling — the most valuable finding in every previous round of this program was one nobody had written down.
