# Group W — WebSocket record layer (orchestrator brief)

Model: **Opus 5**. Effort: **high**. Reason: "nonce reuse becomes an invariant a test asserts on rather than a probability argued about" — a subtly wrong nonce or counter scheme passes casual review and every green suite. Acceptance is an **isolated adversarial verifier's** report, never W's own tests.

You are the **orchestrator** for the streamer's Phase 3. You own the design artefact (`NONCE-DESIGN.md`), the plans, every diff review, every commit-approval hand-off, three merges, and the verifier's dispatch. Two named sub-agents: an implementer and a verifier that must never share context. You report every step to **`e2ee-owner`**.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md` — §3 cryptographic guardrails are non-negotiable.
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-streamer/CLAUDE.md` + `AGENTS.md`.
4. From `origin/main` only: `specs/end-to-end-encryption/remaining-work.md` (Phase 3), `plan.md` (Phase 3 — the three things Phase 2 learned: big-endian record nonce vs little-endian handshake nonce; counter type is a decision; a rejected frame must not consume a counter slot), `design.md` §3.3–§3.6, §4.2–§4.4, §8, §9, `dilemmas.md` D-2, D-3 (the 1.6 MB/s client budget), D-9.
5. Code on `origin/main`: `src/ws-hub.ts` (150 lines: `broadcast` :49, `broadcastToClients` :74, `unicast` :89, `dispose` :103), `src/server-wiring.ts:700-810` (`handleWsOpen` and the six `ws.send(JSON.stringify(...))` at :711, :713, :756, :766, :787, :806), `src/e2ee/noise.ts` (`CipherState` :242, `split()` :362, `chachaNonce(bigint)` :224, `NOISE_MAX_MESSAGE_BYTES` :90), `src/e2ee/pair-request.ts` (D-9 applied once), `src/db/repositories/devices.repository.ts` (`e2ee_static_pub`, `e2ee_required`, `revoked_at`, `byE2eeStaticPubStmt` :134), `src/api/middleware/auth.middleware.ts:23` (`PUBLIC_POST_PATHS`), `src/types.ts:257-399` (the `WSMessage` union).

## Precondition to re-verify on arrival

- `git ls-remote --tags origin v1.70.6` present; `git show origin/main:src/e2ee/record.ts` does **not** exist (nobody started Phase 3 elsewhere). Pin the `origin/main` commit.

## Scope, in three PRs, strictly sequential

**W0 — route every send through `WSHub`.** A pure refactor: the six inline `ws.send(JSON.stringify(...))` in `server-wiring.ts` become `wsHub.unicast(ws, msg)` (or a new hub method if the message is not in the union — say so). Done means `grep -n 'ws.send(' src/` outside `ws-hub.ts` returns nothing, the WS test suite is byte-identical on the wire (positive control: a captured frame sequence before and after), and one mutation (bypass restored on one site) fails the "no bypass" test. No crypto in this PR.

**W1a — design artefact, primitives, context, open.**
- `specs/end-to-end-encryption/NONCE-DESIGN.md`: nonce `direction(4) ‖ counter(8)` big-endian, `0x00000001` client→server, `0x00000002` server→client; `bigint` counter on the server (state the client's obligation: a `bigint` or a two-`number` representation that errors, never wraps, above 2^53 — plan.md); AAD `version(1) ‖ ctxId(16) ‖ direction(4) ‖ counter(8) ‖ channel(1)`; a rejected frame leaves the counter unadvanced; rekey = `Noise Rekey()` on both cipher states, counter resets to 0 **only** as part of a rekey; sender refuses at `2^64-1`; the two bounds (24 h, 1 GiB) and the foreground rekey; what survives a socket close, a streamer restart, a revocation. This file is **owner-approved before W1a code**, and the verifier reviews it first.
- `src/e2ee/record.ts`: `seal`/`unseal` over Node `crypto` `chacha20-poly1305` with the AAD above; separate keys and directions; the counter is owned by the record state, never passed in by a caller.
- `src/e2ee/context.ts`: registry keyed by `ctxId = HKDF(h_ss, "tb-e2ee-ctx-id", 16)`; lookup rejects unknown/expired ids before any allocation (D-9); contexts die on streamer restart (in-memory only), on revocation, on the bounds; per-device teardown for `POST /api/devices/:id/revoke`.
- **The shared 426 helper** lives here, next to the context registry and the device lookup: given a principal (device token or API key) and the request's context state, answer "pinned and plaintext → `426 { error, code: "E2EE_REQUIRED" }`". W1b (the WS upgrade) and X-server (REST) both consume it from W1a's tag; neither re-implements it.
- **Distinguishable rejection codes**: a context unknown because the streamer restarted (or expired) gets a code the client can act on with one transparent re-handshake; a context refused because the device is revoked gets a different code that must surface as a hard failure. Two failures collapsed into one code was a P1 in the prior program; X-client's §4.3 depends on this distinction.
- Interop fixtures for the client (sealed frames with keys, counters, AAD and expected ciphertext) committed under `__tests__/fixtures/` and **their path named in the W1a PR body**, so X-client's precondition check has something concrete at the tag.
- `POST /api/e2ee/open` in a **route file** under `src/api/routes/` (not `server.ts` — Group P shares that file), added to `PUBLIC_POST_PATHS`: Noise `IK` msg1/msg2 against the device's stored `e2ee_static_pub`, refused if the row is missing or `revoked_at` is set, returns `{ ctxId, expiresAt, ticket }` inside the encrypted msg2 payload; `ticket` single-use, 30 s, bound to the `ctxId`. The `summarizeQuery` log protection (`src/api/app.ts:53-57`) must reduce `?ticket=` to `_` — a test says so.
- Done means: unit tests on the real `record.ts` state object (never a stubbed cipher): nonce never reused within a context, forced repeat rejected, out-of-order/gap/duplicate each rejected, AAD mutation (`ctxId`, `seq`, `channel`, `direction`) fails decryption, rejected frame does not advance, **counter survives a rekey correctly** (the rule tested hardest: the test that would pass if the counter reset outside a rekey has been seen red), `2^64-1` refusal. Interop fixtures committed for the client (X-client) to consume.

**W1b — seal the socket.** Per-socket sealing in `WSHub` (`broadcast` currently serialises once for N clients — N seals now; measure it on a terminal-output-sized frame and report the number), `GET /ws?ticket=<t>` accepted alongside `?key=` for unpinned devices, a pinned device presenting `?key=` refused through W1a's 426 helper (do not implement the REST 426 here), strict `counter == expected`, violation → `e2ee.sequence_violation` log line and a policy close, rekey on the bounds. Done means terminal output, replay, conversation events and user messages are ciphertext on the wire (a capture of the real socket shows no plaintext `type` field), and the nonce-reuse test exists and has been seen red. Three more W1b tests, each seen red: (a) **ticket single-use under a race** — two concurrent upgrades with the same ticket → exactly one accepted; (b) **revocation during a live context** — socket closed, context destroyed, the next frame in either direction rejected, and other sockets' broadcasts unaffected; (c) **broadcast independence** — a broadcast to N sockets seals N distinct `(direction, counter)` pairs, and a slow client does not block the hub (assert, not only measure).

Out of scope: REST unseal middleware and the REST sliding window (X-server), `--no-e2ee` (R), anything mobile, #619 consolidation, at-rest encryption.

## Sub-agents

### `streamer-record-layer-engineer` — speciality: `WSHub`, `src/e2ee/*`, Node `crypto` AEAD, the Noise `CipherState`

Worktree: `tb-streamer/.worktrees/feat/e2ee-record-layer` on branch `feat/e2ee-ws-hub-routing` for W0, then `feat/e2ee-record-layer` for W1a and `feat/e2ee-ws-sealing` for W1b (one branch open at a time). `node_modules` symlink per CLAUDE.md, Node v24.15.0, `npm run lint && npm test` with exit codes captured; `npm test` takes ~10 minutes, run it in the background.

### `record-layer-adversary` — speciality: breaking AEAD framing and counter state machines. **Isolated.**

Spawned fresh (a `general-purpose` agent with no prior context), for W1a and again for W1b, with **only**: the paths of `design.md` §3–§4, `remaining-work.md` Phase 3, `NONCE-DESIGN.md`, and the worktree at the exact commit under review. It gets no plan, no diff history, no conversation. Its brief: attempt, with runnable code against the real `record.ts`/`context.ts`/`WSHub` objects, nonce reuse across reconnect and rekey; counter rollback; replay of a captured frame into the same and another context; truncated and oversized bodies before decrypt; `ctxId` confusion between two live contexts; a reflected frame (server→client record fed back as client→server). Its report lists **every attempt in this brief**, each as exactly one of `rejected: <evidence>`, `succeeded: <finding>`, or `not attempted: <reason>` — an omitted row reads as covered, which is the "filtered sample reported as exhaustive" failure. "Could not break it" with that table is the acceptance; an assertion without an attempt is not. The adversary runs at this session's model and effort (Opus 5 / high) — do not lower it.

## Verification bar

- Real path: the real `WSHub` with real `ws` sockets on a loopback server; the real `record.ts` state object; a real devices row for `/api/e2ee/open`.
- Positive control (a sealed frame round-trips and the `type` field is readable only after unseal); negative control (with sealing disabled the capture shows plaintext — proves the capture harness sees plaintext when it exists).
- One mutation per safeguard, reported as `<file>::<test>` + verbatim assertion: counter not advanced → duplicate accepted; direction dropped from AAD → reflection accepted; rekey resets counter outside rekey → reuse; window introduced → gap accepted; length check removed → oversized body allocated.
- Verifier report attached to the PR description for W1a and W1b.

## Merge order and gates

- W0 → tag; W1a → tag; W1b → tag. Rebase onto latest `origin/main` before each, CI green, squash-merge, confirm `MERGED`, then `git ls-remote --tags` for the semantic-release tag. Group P may merge between your PRs; rebase **and re-run every mutation**, not only the suite — a rebase can silently neutralise a mutation test's assumptions.
- **Gates you fire (through `e2ee-owner`, never directly)**: `NONCE-DESIGN.md` owner-approved **and** W1a's tag on the remote → X-server kicks off. W1b's tag is one of X-client's preconditions.

## Rules

- Plan → owner approval → implement → staged diff + exact message → the user's approval in your pane → commit.
- Conventional-commit titles, PR body one sentence per line, no AI attribution, never push to `main`, one PR at a time in this repo.
- Persist `tracks/W/PLAN-W.md` on each plan approval (W0, W1a, W1b sections).
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- **Stop-work**: a private key or ticket in any log or fixture; two writers holding one context's counter; a plaintext frame observed on a socket declared sealed; a dilemma (D-2, D-9) turning out load-bearing.

**Pollution sweep (program-wide, 2026-08-30):** prefer the framework accessor (Hono `c.req.header()` — immune, `Headers.get()` returns null when absent); otherwise guard with `own()` every read of a property on an attacker-shaped object — `req.headers[...]`, query objects, parsed JSON, options objects at constructor boundaries — not only `x ?? default`; Node builds `req.headers` with `Object.prototype`, so an absent header reads through a polluted prototype. One mutation per guard, red under a polluted prototype, with cleanup asserted in `finally`.
