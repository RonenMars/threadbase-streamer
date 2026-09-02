# Group X-server — REST envelope, server half (orchestrator brief)

Model: **Opus 5**. Effort: **high** (raised from medium on review: a fresh verifier agent inherits this session's effort, and the adversary is where the tier matters most). Reason: the D-9 rules are already applied once in `src/e2ee/pair-request.ts`; this is reapplying a written protocol at larger scale — but it is pre-auth parsing of attacker-controlled bytes, so it carries the same **isolated verifier** as W.

You are the **orchestrator** for the streamer's Phase 4. You own the plan, every diff review, every commit-approval hand-off, the merge, and the verifier's dispatch. Two named sub-agents that never share context. You report every step to **`e2ee-owner`**.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md` — §3.
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-streamer/CLAUDE.md` + `AGENTS.md`.
4. **First: `tracks/W/REPORT-W.md`** — W1a's record, especially "two lessons", "my own errors" and the closing "For X-server and X-client" section. Then from `origin/main` only: `specs/end-to-end-encryption/remaining-work.md` (Phase 4), `design.md` §3.2, §3.4 (REST sliding window), §3.6 (the middleware pair; `countResponseBytes` prior art at `src/api/app.ts:66-83`), §4.4 (per-request revocation re-check), §6.3 (`426 E2EE_REQUIRED`, never 401), §8, §9; `dilemmas.md` D-7, D-9; **`NONCE-DESIGN.md` at the approved commit** (W's artefact).
5. Code at the W1a tag: `src/e2ee/record.ts`, `src/e2ee/context.ts`, the `/api/e2ee/open` route; `src/api/app.ts` (`app.use("*")` chain, `authMiddleware` at :121, `summarizeQuery` :53-57), `src/api/middleware/auth.middleware.ts`, `src/e2ee/pair-request.ts` (the D-9 pattern: `MAX_BASE64_CHARS` checked on the encoded length before decode).

## Precondition to re-verify on arrival

- `NONCE-DESIGN.md` exists on `origin/main` at the commit `e2ee-owner` names as approved (`git show origin/main:specs/end-to-end-encryption/NONCE-DESIGN.md`), and the W1a release tag named in the kick-off is on the remote (`git ls-remote --tags origin <tag>`) and contains `src/e2ee/context.ts`. If either fails, stop and report; do not start on a branch.

## Scope — one PR

- **Unseal middleware** registered ahead of `authMiddleware` in `src/api/app.ts`: reads `X-TB-E2EE`, `X-TB-Ctx`, `X-TB-Seq`; the cheapest rejection first — unknown or expired `ctxId` → reject **before any allocation** (a `Map` lookup, nothing else); `Content-Length` and the actual read bounded by a constant before decrypt; never allocate from a length field inside the body; unseal with `channel = 0x02`, replace the body, resolve the principal from the context's device row, re-check `revoked_at` per request as the auth middleware does today, hand off to `authMiddleware` with the (now decrypted) credential.
- **Seal on the way out** with `channel = 0x03` through W1a's `RestResponseSealer.seal(requestCounter, …)` — the response echoes the request's counter (review B2a); **at most one sealed response per accepted request counter**: a request rejected by the window or the AEAD, including through `onError`, gets a plaintext error and never a sealed body. The REST AAD carries `sha256(method ‖ "\n" ‖ path ‖ "\n" ‖ query)` (B2c) so a sealed `POST /api/sessions/A/input` cannot be re-routed to B. **Credential (B2b):** the principal comes from the context; sealed requests carry no `Authorization`; one present beside `X-TB-Ctx` must name the context's device or the request is rejected; `authMiddleware` skips when a principal is already set. **Framing you must define, not improvise (review M8):** bodiless GETs (RN drops GET bodies — a header tag over the empty plaintext + AAD), the ndjson streaming `stop` response (multi-record, each bound to the request counter + index, or an explicit exemption), multipart uploads (original `Content-Type` inside the envelope), and `writeHead`/`setHeader` interception with `Content-Type`/`Content-Length` rewritten at `end` — `countResponseBytes` is necessary prior art, not sufficient.
- **Sliding window**: RFC-6479-style 1024-bit bitmap per **REST context** (owner ruling 2026-08-29, NONCE-DESIGN.md §8: a context is bound to one channel instance — REST has its own long-lived per-device context; socket contexts are never presented on REST, reject `channel` mismatch) for `X-TB-Seq`; above the window → advance; inside with a clear bit → set; below or already set → reject. Responses need no window.
- **Downgrade enforcement**: a request presenting a device token or API key whose row has `e2ee_required = 1` without a valid `X-TB-Ctx` → `426 { error, code: "E2EE_REQUIRED" }`, never 401 — through **W1a's shared 426 helper** from the tag, never a second implementation.
- **Error shapes on a pinned context, decided and tested**: 401/404/5xx from a handler are **sealed** like any response; 426 is plaintext (no context exists to seal with); a context unknown because of a restart vs refused because the device is revoked return the two distinguishable codes W1a defined. A context revoked **between unseal and handler** (mid-flight) is rejected, not served. A sealed response is never served as a `304` from a plaintext-era ETag — decide how `If-None-Match` interacts with the envelope and test it.
- **Log hygiene**: no sealed or unsealed body is ever logged; `?key=`/`?ticket=` stay `_` in `http.request`.
- Paths and query stay plaintext (D-7). Nothing in `docs/compatibility/tb-mobile.md` renamed, removed or retyped; an unpinned device with the shared key does everything it does today.

Out of scope: `WSHub`, `/api/e2ee/open` (W's), `--no-e2ee` and stage flags (R), mobile.

## Sub-agents

### `streamer-envelope-engineer` — speciality: Hono middleware ordering, hostile-input parsing, the `record.ts`/`context.ts` API

Worktree `tb-streamer/.worktrees/feat/e2ee-rest-envelope`, branch `feat/e2ee-rest-envelope` from `origin/main` at or after the W1a tag; `node_modules` symlink, Node v24.15.0, `npm run lint && npm test` exit codes captured.

### `rest-envelope-adversary` — speciality: pre-auth parser abuse. **Isolated.**

Spawned fresh with only `design.md` §3, `dilemmas.md` D-9, `NONCE-DESIGN.md`, and the worktree at the exact commit. Attempts, with runnable requests against the real Hono app on loopback: unknown/expired/foreign `ctxId` (measure allocation — a heap or timing probe that shows rejection is O(1) before body read); oversized `Content-Length` and a chunked body with no length; a body whose inner length field claims 2 GiB; replay of a captured request inside and below the window; two contexts swapped (`ctxId` of A, ciphertext of B); response counter mismatch; a pinned device presenting `?key=` and a plaintext body expecting 426 not 401; a 401 path that must still trigger for a bad credential *inside* a valid envelope. Its report lists **every attempt in this brief**, each as exactly one of `rejected: <evidence>`, `succeeded: <finding>`, or `not attempted: <reason>` — an omitted row reads as covered. It runs at this session's effort (high); do not lower it.

## Verification bar

- Real path: the real `createApp` chain with a real context from a real `/api/e2ee/open` handshake in the test, a real devices row.
- Positive control (a sealed request round-trips through an untouched handler and the response unseals to the handler's JSON); negative control (with the middleware removed, the same request 401s — proves the harness exercises the middleware).
- One mutation per safeguard, `<file>::<test>` + verbatim assertion: allocation before `ctxId` lookup → the probe test fails; window widened to accept a set bit → replay accepted; length check after decrypt → oversized body decrypted; 426 replaced by 401 → downgrade test fails; per-request `revoked_at` check removed → revoked device served.
- Verifier report attached to the PR.

## Merge order and gate

- Rebase onto latest `origin/main` (W1b may land before or after you — the files are disjoint now that the 426 helper is W1a's), re-run every mutation after the rebase, CI green, squash-merge, confirm `MERGED`, report the semantic-release tag.
- **Gate you fire (via `e2ee-owner`)**: your tag is one of X-client's preconditions (REST half) and, with W1b's, the trigger for R1.

## Rules

- Plan → owner approval → implement → staged diff + exact message → the user's approval in your pane → commit.
- Conventional-commit titles, one sentence per line, no AI attribution, never push to `main`, one PR at a time in this repo.
- Persist `tracks/X-server/PLAN-X-server.md` on plan approval.
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- Stop-work: any body or key in a log; a change that would make an old client's request fail; D-7 or D-9 turning out load-bearing.

**Mutation-driver rules (program-wide, from W1a):** revert every mutation in a `finally` and assert `git diff --quiet` after each; a mutated module that fails to parse or import is reported `BROKEN — did not run`, never counted as a pass — absence of a failure line is not evidence, only an observed red is; after any interruption, check for a stranded mutation before anything else.

**Pollution sweep (program-wide, 2026-08-30):** prefer the framework accessor (Hono `c.req.header()` — immune, `Headers.get()` returns null when absent); otherwise guard with `own()` every read of a property on an attacker-shaped object — `req.headers[...]`, query objects, parsed JSON, options objects at constructor boundaries — not only `x ?? default`; Node builds `req.headers` with `Object.prototype`, so an absent header reads through a polluted prototype. One mutation per guard, red under a polluted prototype, with cleanup asserted in `finally`.
