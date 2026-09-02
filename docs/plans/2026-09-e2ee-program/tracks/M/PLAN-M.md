# PLAN-M — Group M remediation

Owner ref: `e2ee-owner [ddde5e]`. Audit table accepted and PRs (a)/(b) approved 21:40 IDT; interop accepted and PR (c) approved as option 1 shortly after.

Worktree: `../tb-mobile-worktrees/e2ee-pairing-audit`, branch `fix/e2ee-pairing-audit` from `origin/main` @ 229faf6b. One PR at a time in tb-mobile; rebase onto latest `origin/main`, squash-merge on green, confirm `MERGED` before branch deletion.

Evidence: `AUDIT-M.md` (seven-row table, interop bytes, three defects).

## PR (a) — item 7: prove the key material through the real loader — APPROVED

Test-only, plus deleting two stale comments.

1. `__tests__/unit/e2ee-require-encryption.test.ts` — extend the `loadPersistedServers – encryption fields` describe so the read-back is driven by the real write path (`addServer`) and asserts `serverPublicKey`, `deviceToken`, `deviceId`, `deviceCapabilities` and `publicUrl` alongside `requireEncryption`.
2. `stores/servers.ts:146-157` — delete the "cannot be executed by any test in this repo" paragraph. False since #776 made the `AsyncStorage` import static.
3. `__tests__/unit/stores/servers.test.ts:421-434` — delete the same stale claim, keep the still-true note about driving the reader with the exact bytes the writer produced.

Mutation seen red: `stores/servers.ts:554-555` → `const deviceToken = undefined`.
**Baseline recorded 2026-08-28: with that mutation applied, `e2ee-require-encryption` + `stores/servers` = 48 passed, 0 failed.** That silence is the defect.

## PR (b) — item 1: the two uncovered entry surfaces — APPROVED

Test-only.

1. Scanner: a malformed-`spk` QR through `PairScannerModal.handleScanned` with the real `parsePairUri`, asserting `exchangeToken` is never called and the damaged-key copy renders.
2. Paste: a `ConnectStep` test with `__DEV__ = false` so `useTBPair` takes `resolveCredentials` instead of `finishMockSequence()`, asserting a malformed `spk` never reaches the confirm gate.

Mutations: `pair-exchange.ts:202` guard disabled → the scanner test must go red; dropping the `useTBPair.ts:203` `__DEV__` early return → the existing paste tests must break, proving they depended on the mock.

## PR (c) — defect 3: classify the invalid-curve-point failure — APPROVED (plan owner-approved, diff not yet)

Source change.

1. `services/pair-exchange.ts:307` — bring `started.handshake.writeMessage1(...)` inside the guarded region; map a DH failure to `e2ee-malformed` (non-retryable classification already exists), reusing the damaged-key copy both entry paths render for the other malformed cases.
2. `app/pair.tsx:121` and `PairScannerModal.tsx:92` unchanged — the generic branch stays the right fallback for a genuinely unknown error.

Tests: a well-shaped invalid X25519 point through `exchangeToken` against the real `@stablelib/x25519` (no mocked curve), and the same point through the deep-link screen asserting no retry affordance.
Positive control: the existing wrong-length case at `pair-exchange.test.ts:860`. Negative control: the valid-wrong-key case at `:778` staying `e2ee-handshake`.
Mutation: revert the guard widening → the new test fails with the bare `Error: X25519: invalid shared key`.

## Issues to file before close-out

- **P2** — `addServer` fires two unawaited `persistServerList` writes (`stores/servers.ts:261-292`), the first without the pin. `servers.test.ts:451` passes under a FIFO mock; `expo-secure-store` documents no ordering guarantee. Candidate for Group F, owner decides.
- **P3** — `pair-confirm-target.ts:58-70` presents an unverified `spk` as a verified `kind: 'e2ee'` fingerprint under `__DEV__`. Production unaffected.
- **P3** — `PairDeepLinkScreen.test.tsx` assumes expo-router yields `''` rather than `undefined` for `?spk=`; `buildPairUri`'s allowlist depends on it. Driving the real router is not cheap — `jest.setup.js:29` mocks `expo-router` wholesale for every suite.

## Verification set (each PR, exit codes captured)

`npx tsc --noEmit && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e`.
Any suite failure re-run in isolation per tb-mobile CLAUDE.md before it is blamed on the change.

---

## Close-out

Group M audited the merged mobile pairing repair against the seven contract items of #698 on the real entry paths. **Four items held; three were defects, all fixed and merged; one further defect was found by interop and fixed.** Every verdict is backed by a mutation seen red, and the two coverage defects by a mutation that stayed green when it should not have.

| Item | Verdict | Closed by |
|---|---|---|
| 1 — absent vs present-invalid `spk` | defect (coverage) | #901 |
| 2 — gated on `spk`, no msg2 is a failure | holds | M2 red |
| 3 — `D_priv` load-or-create before msg1 | holds | M3 red, interop |
| 4 — complete authenticated msg2 | holds | M4 red, interop |
| 5 — label-only edit preserves identity | holds | M5 red |
| 6 — web refuses E2EE | defect (coverage) | #901 |
| 7 — persisted read-back | defect | #900 |
| invalid curve point (beyond the seven) | defect | #902 |

Merged, in order: `e35124b0` (#900), `b97449e3` (#901), #902.

**What the audit actually found.** Two guards were unwatched in a way a green suite concealed: deleting `serverPublicKey: parsed.spk` from either pairing surface left 2140 tests passing while a scanned or pasted encrypted QR paired in plaintext, and telling the web build its `localStorage` shim was a keychain left the same 2140 tests passing. Neither is visible by reading the code — both required measuring what the suite does *not* catch. The third defect was invisible to any fixture: only a handshake against a real streamer surfaced a 43-character key that is not a point on the curve throwing a bare `Error` out of `exchangeToken`.

**Two of the orchestrator's own conclusions were wrong and were corrected by the sub-agent**: item 6 was first reported as holding, when jest never resolves `.web.ts` files under the root `jest-expo` preset; and item 1's mechanism was misattributed to `__DEV__` when the test file mocks the hook wholesale. Both were verified independently before the correction was propagated. The first table sent to the owner said five rows held; four do.

**Deferred, with issues filed:** #903 (P2, `addServer`'s two unawaited persists leave the pin absent if the app dies between them), #904, #905, #906 (P3). Item 5's `ServerEditModal` → `editServer` gap and the Metro-selection half of item 6 go to Groups F and D respectively — neither is closable in jest.

**Gate fired:** Group M's close-out is what unblocks Group F. #759 is untouched and remains F's.
