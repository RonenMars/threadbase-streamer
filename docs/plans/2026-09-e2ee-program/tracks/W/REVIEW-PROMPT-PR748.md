# Review prompt — streamer PR #748 (paste into a fresh Claude Code session at ~/dev/ai-tools/tb-e2ee-program)

Review streamer PR #748 (`RonenMars/threadbase-streamer`, branch `feat/e2ee-ws-sealing`, +3028/−54, 13 files) as an independent reviewer with no prior context. It seals the WebSocket transport per device context on top of the E2EE record layer that shipped at tag `v1.71.0`. Report findings only — do not edit code, do not comment on the PR, do not approve/reject; your output is a ranked findings list for the program owner.

**Budget discipline: this review must stay cheap.** Read only what this prompt names. Do not read the whole repo, the whole spec folder, or the program's tracks/ history — six adversary rounds and a 25-mutation campaign already ran against this branch; your value is a fresh pair of eyes on the diff against the spec, not re-deriving that work.

## Read, in this order, nothing else

1. `gh pr diff 748 --repo RonenMars/threadbase-streamer` — the entire review target.
2. `git show v1.71.0:specs/end-to-end-encryption/NONCE-DESIGN.md` (in tb-streamer/) — only §5 (record rules R1–R4), §8 (context lifecycle), §9 (error codes and who each code makes a claim about), §10 (`/open`, ticket), §13 (server rules incl. `authenticateContext` "never throws / never destroys / never logs").
3. `tb-e2ee-program/CLAUDE.md` §3 (crypto guardrails) — one page.
4. If (and only if) a specific finding needs it: the touched file's surrounding code via `git show`.

## Invariants to check the diff against (each is a claimed property; try to falsify it in the diff)

1. **Nonces**: every seal path derives the nonce as `direction(4)‖counter(8)`; no random nonce, no counter reuse, counter owned by the record state — a reconnect is a NEW context (fresh ctxId), never a resumed counter.
2. **Strict monotonic WS counters, no window**: any repeat/gap/reorder closes with `E2EE_SEQUENCE_VIOLATION`; a seal failure closes with `E2EE_SEAL_FAILED` (server fault ≠ peer claim — the two must never collapse, including in the send-path error mapping).
3. **Ticket**: single-use, consumed synchronously (no `await` between check and consume), accepted from the `X-TB-Ticket` header only, never logged even reduced; no `Authorization` processed on a ticketed upgrade; a spent/expired ticket → 401 with no device inference.
4. **`authenticateContext`** (the seam frozen for the REST track): pure verdict `{ok,principal} | {ok:false, reason: "device-revoked"|"credential-mismatch"|"no-device-store"}`; never throws (including a hostile row accessor), never destroys, never logs; `principal.deviceId` comes from `context.deviceId` by construction; missing row ⇒ `device-revoked`; credential naming no device (shared API key) ⇒ `credential-mismatch`; null/throwing store ⇒ `no-device-store` (mapped to 503 STORE_UNAVAILABLE, not 403).
5. **No plaintext escape on a sealed socket**: a socket that consumed a ticket must have no reachable plaintext send path (`everSealed`, `sendTo` fallthrough); `handleWsOpen`'s synchronous sends must be sealed on a ticketed socket; the bare-catch in message handling must not swallow seal failures.
6. **Prototype pollution**: no bracket read on `req.headers`/query/options objects without `own()` or Hono's `c.req.header()`; check especially the 10 s first-frame deadline option and `e2ee.routes.ts`'s `content-length` read.
7. **Lifecycle**: socket close destroys its own context and never the device's REST context; revocation reaches live sockets; every context created by an upgrade path that then refuses (capability refusal, falsy `ws.raw`) is destroyed — no orphan without a deadline.
8. **Bounds before allocation**: `maxPayload` set on the actual `WebSocketServer` in use; nothing allocates proportional to an attacker-supplied length before the bound.
9. **Released clients unbroken**: the legacy `?key=` path still works for unpinned devices; pinned devices refused via the existing 426 helper; no response field removed or renamed; the four frozen code strings unchanged.
10. **Tests prove what they claim**: for the tests added in this diff, spot-check ~5 of the most security-relevant for vacuity (would the assertion fail if the guard were deleted? does the negative control discriminate, or would it pass either way?).

## Output format

Ranked findings, most severe first. For each: file:line in the diff, the invariant number it violates, a concrete failure scenario (inputs/state → wrong outcome), and confidence (CONFIRMED = you traced the path; PLAUSIBLE = shape looks wrong but not fully traced). Explicitly list which of the ten invariants you checked and found to hold. "No findings" on an invariant is a valid result; a vague concern without a scenario is not a finding. Finish with a one-paragraph verdict: merge-safe as-is, or blocked by findings N, M.
