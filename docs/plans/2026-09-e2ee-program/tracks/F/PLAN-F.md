# Group F — mobile pairing follow-ups

Worktree: `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-pairing-followups`
Branch: `fix/pair-gate-single-host`
Pinned: `origin/main` = `f3e82287` (2026-08-29), PRs #900/#901/#902 merged.
Planning-only turn — no code written.

## Close-out — 2026-08-29

Group F is closed. Four PRs merged in tb-mobile, one PR at a time, each
reviewed independently before commit approval and each rebased onto the
latest `main` before merge:

| PR | Merge commit | Closes | Summary |
|---|---|---|---|
| [#908](https://github.com/RonenMars/threadbase-mobile/pull/908) | `cbbb89f9` | #759 | Proves the require-encryption pin through the real pair path for all four corrected acceptance criteria; interop-verified against the pinned streamer. |
| [#915](https://github.com/RonenMars/threadbase-mobile/pull/915) | `e9f42990` | #831 | Collapses the two add-server implementations onto `ServerEditModal`; baseline control proved a Maestro red run pre-existed on clean `main` (filed as #909); CI caught and fixed an orphaned-i18n-key gap the deletion left. |
| [#917](https://github.com/RonenMars/threadbase-mobile/pull/917) | `a08be6bc` | #903 | Closes the crash window in `addServer`'s two persist calls — a pinned add now makes exactly one write, already carrying the pin. |
| [#919](https://github.com/RonenMars/threadbase-mobile/pull/919) | `92033156` | #904 | Forwards the authenticated `publicUrl` on the camera-scan pairing path; also lands the `ServerEditModal` rename-gap test (AUDIT-M item 5). |

Every fix shipped with a seen-red-then-reverted mutation as falsifiability
evidence, per the program's verification methodology. #698 (the mobile
E2EE tracking issue) updated: the "auto-set the pin" checklist item
ticked, and a close-out comment posted there citing all four merges.

One process note for the record: the F1 and F3a diffs were briefly
committed to the wrong branch (the one reserved for the next item in the
same worktree) before being caught and split onto their own branches
pre-push — no bad state reached `main` either time, but it is why F2's
and F3b's branches were created fresh rather than reused.

Worktrees removed post-close-out: `e2ee-pairing-followups` (tb-mobile)
and the scratch `f2-baseline` control worktree (already removed
mid-track). D1 fires on this close-out, per the owner.

**Approved 03:40** by `e2ee-owner`, after the isolated second reader confirmed
all four #759 evidence-map rows (with one completeness note on row 1:
`useTBPair.test.ts:294` is corroborating real-path evidence the map should
have cited; does not change the GAP verdict).

Order and PR shape, per owner:
- **PR F1** (test-only): the three screen-level tests for criteria 1, 2, 4,
  each with its named mutation seen red, plus the row-1
  `useTBPair.test.ts:294` citation in the PR body. On merge, tick #759's four
  boxes and close it citing the tests. Criterion 1 additionally gets an
  interop run against the pinned streamer (`@threadbase-sh/streamer@1.70.6`,
  scratch `HOME`) — it is the criterion that touches the wire.
- **PR F2**: port the 401/500/network/localhost-hint matrix onto
  `settings-flow.test.tsx` through the real `ServerEditModal` first, with one
  ported case's mutation seen red as proof, then delete
  `AddServerScreen.tsx`, the `mode==='add'` branch in `app/onboarding.tsx`,
  and `onboarding-flow.test.tsx`. Cite #833 and the zero-call-site grep in
  the PR body. Close #831.
- Then **F3** (carry-ins from Group M).
- One PR at a time. Sub-agent writes, orchestrator reviews (reviewer ≠
  author). Full verification set with captured exit codes, run in
  background/parallel mode, never foreground `--runInBand`.

## PR F1 — MERGED

PR [#908](https://github.com/RonenMars/threadbase-mobile/pull/908),
squash-merged `cbbb89f9de087264fe8b97dce3142647b064ab56`, 2026-08-29
00:54:21Z. Branch `test/require-encryption-pin-evidence` (moved off
`fix/pair-gate-single-host` before push — that branch is reset to `f3e82287`
and reserved for F2). Issue #759 closed automatically on merge, with a
citation comment linking each criterion to its test.

CI green on both the pre-rebase and post-rebase (onto #907) commits: Gate,
Setup, security/snyk, i18n, Native deps, E2E jest, Type check, Integration
tests, Lint, Unit tests all `pass`.

## PR F2 — MERGED

PR [#915](https://github.com/RonenMars/threadbase-mobile/pull/915),
squash-merged `e9f42990428c8048b0208f8b90a49387b5d4fec8`, 2026-08-29
10:48:19Z. Branch `fix/pair-gate-single-host`. Issue #831 closed
automatically on merge, with a citation comment covering #833's
provenance, the re-verified zero-call-site grep, and the coverage port.

Notable findings during implementation:
- Baseline control proved `npm run test:e2e:mock` fails identically
  (pixel-identical "[01] Pairing failed." screenshot) on unmodified
  `origin/main`, on the iPhone 17 Pro / iOS 26.1 simulator — not a
  regression from this PR. Filed as
  [#909](https://github.com/RonenMars/threadbase-mobile/issues/909).
- CI's i18n check caught a real gap `test:e2e:mock` couldn't have:
  deleting `AddServerScreen.tsx` orphaned 10 translation keys × 4
  locales. Fixed with a surgical removal (not the CI-suggested
  `i18next-cli extract`, which touched 48 files repo-wide) — 4 files,
  48 deletions, 0 additions, exactly the orphans the deletion created.

Final diff: 12 files, 127 insertions(+), 998 deletions(-). CI green on
the final rebase (onto `4b8b32d8`).

## F1 — #759 evidence map

Issue #759 ("auto-set the require-encryption pin") carries a stale headline and
a stale "Blocked on" footer from before the 2026-08-16 contract correction —
both still say the pin waits on `/api/e2ee/open` / sealed-transport wiring.
The corrected acceptance criteria in the same issue body supersede that: the
pin is written the moment a fully authenticated msg2 validates, at `addServer`
time, not at some later transport event. That write already exists on `main`:

- Every pair call site passes `requireEncryption: exchanged.e2eeRequired` (or
  `result.e2eeRequired`) into `addServer`: `app/pair.tsx:141`,
  `hooks/useTBPair.ts:91,113` (via the `PairResult.requireEncryption` field
  consumed by `OnboardingNavigator.tsx:164`), `app/settings.tsx:423`,
  `components/servers/ServerEditModal.tsx:170-180` (via
  `pendingScanMeta.current`/`handleScanSuccess`), `components/servers/AddServerScreen.tsx:214`.
- `stores/servers.ts:286` (inside `addServer`): `if (device?.requireEncryption) get().setRequireEncryption(id, true)`
  — the single writer, called only when truthy, never with `false` (comment at
  `:283-285` explains why: an unencrypted pairing must not answer the question
  with `false`).
- `stores/servers.ts:338` `setRequireEncryption` is still the one writer; a
  stray comment at `:334-336` ("that caller lands with the connection wiring")
  is now inaccurate/stale — the caller already landed via `addServer`, it just
  isn't phrased as a direct post-msg2 call the way the issue's "Fix" section
  sketched it. Worth a one-line comment cleanup when #759 is actually closed,
  not required for the criteria themselves.
- `services/pair-exchange.ts:620` refuses any msg2 with `e2eeRequired !== true`
  before `exchangeToken` ever returns, so `exchanged.e2eeRequired` is always
  `true` by the time a caller reaches `addServer` — a `false` value structurally
  cannot flow through this path today.

### Evidence table

| # | Criterion | Covering test or gap | Real path? | Verdict |
|---|---|---|---|---|
| 1 | Fully authenticated + validated msg2 calls `setRequireEncryption(serverId, true)` | No test asserts `requireEncryption: true` lands on the added server through a screen/hook. `__tests__/integration/components/PairDeepLinkScreen.test.tsx` drives the real `app/pair.tsx` + real `useTBPair` + real `stores/servers.ts` (only `exchangeToken` is mocked, which is the legitimate network boundary), but every fixture in that file uses `e2eeRequired: false`. `__tests__/unit/e2ee-require-encryption.test.ts::loadPersistedServers – encryption fields > restores the pinned server key...` does call the real `addServer(...,{requireEncryption:true})` and asserts the bit lands and persists, but it calls the store action directly, not through a screen/hook — same shape gap AUDIT-M.md flagged for the paste path. | Partial (service-through-store yes; screen-through-store no) | **GAP — needs new test** |
| 2 | Missing / malformed / false-`e2eeRequired` / unauthenticated msg2 never sets the pin and never adds a plaintext server | `__tests__/unit/services/pair-exchange.test.ts` is thorough at the service boundary: `it.each([...,'e2eeRequired',...])('rejects a message 2 with no %s')` (missing), the empty-payload and wrong-type `it.each` blocks (malformed), `'rejects a message 2 that does not require encryption'` (false), and `'rejects a tampered message 2...'` / `'fails closed when the QR key is not the key the responder holds'` / `'binds the handshake to the scanned pair token'` (unauthenticated / wrong key / wrong PSK). All of these assert `exchangeToken` rejects — real production code, not mocked. What is *not* directly asserted anywhere: that a caller screen, on catching that rejection, leaves `useServersStore().servers` empty. `PairDeepLinkScreen.test.tsx`'s failure-mode tests (`'shows a token-rejected error...'`, `'shows a translated...message for an unreachable host'`, etc.) assert the error UI and that `mockReplace`/navigation didn't fire, but none of them assert `Object.values(useServersStore.getState().servers)).toHaveLength(0)`. It is true only because `exchangeToken` throwing short-circuits before `addServer` is ever called in the source — structurally sound, not test-proven at the screen level. | Real path (service level); gap at screen level | **HOLDS at the service boundary; GAP at the screen boundary (no-plaintext-server-added assertion)** |
| 3 | Pin survives an app restart through the persisted-server read path | `__tests__/unit/e2ee-require-encryption.test.ts::loadPersistedServers – encryption fields > restores the require-encryption pin from the persisted store after memory is wiped` — seeds via `setRequireEncryption` (store call, not the real pair path), wipes in-memory state, calls the real `loadPersistedServers()`, asserts the bit comes back. The companion test `restores the pinned server key and the scoped device token, not just the pin` drives the write side through the real `addServer(...,{requireEncryption:true})` (still a direct store call, not a screen) then the same real read path. The **read** half (`loadPersistedServers`) is exercised for real either way — restart-survival is a property of the persistence layer, not of which screen wrote the record, so this criterion does not need a screen-level write to be satisfied. | Read path real; write path is direct-store, not screen | **HOLDS** — restart-survival is proven for real; the write-provenance gap already lives under criterion 1 |
| 4 | Refusal state still leaves the deliberate settings-based clearing path reachable | `EncryptionRefusalBanner` (`components/servers/EncryptionRefusalBanner.tsx`) renders inline in `app/index.tsx:457` — it is not a blocking modal/route, so ordinary navigation to Settings → server → Edit stays reachable structurally. `__tests__/unit/components/servers/EncryptionRefusalBanner.test.tsx::offers exactly two ways out, and neither of them connects` proves the banner itself offers only retry/forget, by design (no "connect anyway" — see the component's own doc comment). `__tests__/unit/components/servers/ServerEncryptionSection.test.tsx::does not clear the pin until a confirmation naming the loss is accepted` proves the settings-based clearing path itself works and calls `setRequireEncryption(id, false)`. No test renders both together — i.e. no test puts a server into the refused state and then drives a tap through to Settings → Edit → clear pin as one flow. | Two real, disjoint unit tests; no single integration test spans both | **HOLDS via composition of two real tests; GAP for one end-to-end integration test** |

### Mutations to redden new tests (per GAP, not yet written)

- **Criterion 1** — new test in `__tests__/integration/components/PairDeepLinkScreen.test.tsx` (or a new `useTBPair`-through-`addServer` integration test): resolve `exchangeToken` with `e2eeRequired: true`, confirm-and-add, then assert
  `expect(Object.values(useServersStore.getState().servers)[0].requireEncryption).toBe(true)`.
  Mutation to prove it's live: comment out `stores/servers.ts:286`
  (`if (device?.requireEncryption) get().setRequireEncryption(id, true)`) —
  the new assertion must go red; every currently-passing suite must stay green
  (since none of them assert this today).
- **Criterion 2 (screen-level half)** — extend one of the existing
  `PairDeepLinkScreen.test.tsx` failure-mode tests (e.g. `'shows a
  token-rejected error and lets the user retry'`) with
  `expect(Object.values(useServersStore.getState().servers)).toHaveLength(0)`
  right after the rejection, before the retry succeeds. Mutation: in
  `app/pair.tsx`, move the `addServer` call outside the `try` so it fires
  unconditionally (or call it before awaiting `exchangeToken`) — the new
  assertion must go red.
- **Criterion 4** — one new integration test that seeds a server with
  `requireEncryption: true` and a refusing `serverInfo`, renders the hub
  (`app/index.tsx` or a thinner host), asserts the banner shows, then
  navigates to `ServerEditModal` for that server id and drives
  `ServerEncryptionSection`'s clear-pin control to completion, asserting
  `setRequireEncryption(id, false)` fires. Mutation: make
  `EncryptionRefusalBanner` (or its host) swallow taps on the rest of the
  screen while shown (e.g. wrap it in a full-screen absolutely-positioned
  overlay) — the new test's navigation step must fail to reach Settings.

None of the four is a correctness defect on `main` today — three HOLD outright
or HOLD by composition, and criterion 1/2's gaps are missing screen-level
proof of behavior that is structurally correct but currently only proven one
layer down (service/store), the exact shape AUDIT-M.md calls out as worth
closing before calling a criterion satisfied.

## F2 — #831 host plan

### Re-verification against current `main` (`f3e82287`)

- PR #833 (modal yields window) is present: `ServerEditModal.tsx:198-199` —
  `visible={visible && confirmTarget === null && !scannerOpen}` — the modal's
  own `<Modal>` hides itself while `PairConfirmGate` or `PairScannerModal` is
  shown. The presentation defect the issue used as its motivating example is
  fixed. What's left is exactly the "two implementations, pick one" ask.
- `AddServerScreen`'s add path is still unreached in production code.
  Re-ran the issue's own greps: `grep -rn "mode=add\|mode: 'add'"
  app components hooks stores services` (excluding `__tests__`) returns
  **nothing**. The only thing that reads `mode` and branches to
  `AddServerScreen` is `app/onboarding.tsx:9-18` itself
  (`isAddingServer = mode === 'add'`), and nothing in production code ever
  pushes `/onboarding?mode=add` — every `router.push/replace('/onboarding...')`
  call site (`app/settings.tsx:373,953`, `app/_layout.tsx:148,150`,
  `components/servers/ServersStatusModal.tsx:268`) uses no mode, or
  `mode=review`. So the claim in #831 still holds verbatim against current
  `main`: `AddServerScreen`'s add path is dead in production, reachable only
  by a hand-built deep link or by rendering `<OnboardingScreen>` directly in a
  test with `mode: 'add'` mocked into `useLocalSearchParams`.
  `components/onboarding/steps/ConnectStep.tsx` (605 lines) is the screen
  onboarding actually uses for first-pairing; it does not import
  `AddServerScreen`.
- `AddServerScreen.tsx` is imported by exactly one production file
  (`app/onboarding.tsx`) and one non-import mention (`__tests__/unit/authed-fetch.test.ts:175`
  is a comment, not an import).

### What's left of #831's ask

Purely the duplication cleanup. There is no live modal-in-modal defect left —
#833 already closed that. The only outstanding problem is that
`ServerFormFields`, `PairScannerModal`, `PairConfirmGate`,
`pendingTargetFromApiKey`, and `addServer` are wired up twice
(`ServerEditModal.tsx`, 386 lines; `AddServerScreen.tsx`, 554 lines), and one
of the two copies (`AddServerScreen`'s add path) has no production caller.

### Host decision

**Converge on `ServerEditModal` as the one reachable host.** It is the smaller
diff by a wide margin:

- It is already the live, reachable path from Settings
  (`app/settings.tsx:1035`, `components/servers/ServersStatusModal.tsx:354`)
  for both add and edit.
- It already has the #833 fix and its regression test
  (`__tests__/integration/components/ServerEditModalConfirmGate.test.tsx`).
- It already carries the sections `AddServerScreen` has no equivalent for
  (`ServerEncryptionSection`, `ServerClaudeFlagsSection`) and both add/edit
  modes, so nothing needs to be built to reach parity — the opposite direction
  (making `AddServerScreen` the host) would require porting edit-mode support
  and both extra sections into a plain-route screen that no navigation target
  currently reaches, for zero live-path benefit.
- The diff is therefore: delete `components/servers/AddServerScreen.tsx`,
  delete the `isAddingServer`/`mode === 'add'` branch in `app/onboarding.tsx`
  (collapsing it back to always rendering `OnboardingNavigator`, or leaving a
  redirect to Settings' existing "Add Server" entry point if a
  `mode=add` deep link needs to keep meaning something), and retire
  `__tests__/e2e/onboarding-flow.test.tsx` (the suite is titled "Add-server
  flow" and exists specifically to cover `AddServerScreen` via
  `OnboardingScreen`).

### Coverage to preserve

- `__tests__/integration/components/ServerEditModalConfirmGate.test.tsx` (2
  tests: form-hidden-before-save, gate-gets-the-window-on-save) — keep
  passing as-is; it already covers the #833 fix on the surviving host.
- `__tests__/e2e/settings-flow.test.tsx::opens add server modal from settings`
  proves the reachable entry point still opens `ServerEditModal` in add mode,
  but only checks that the modal opens — it does not exercise field-level
  behavior (URL/API-key inputs, Hide/Show toggle, label field) or the
  network-error-handling matrix (401, 500, network-unreachable, localhost
  hint) that `__tests__/e2e/onboarding-flow.test.tsx` currently covers only
  through `AddServerScreen`. **Before deleting `AddServerScreen.tsx` and its
  e2e suite, the plan needs either**: (a) confirm `ServerEditModal` in add
  mode already exercises the same error-handling code paths through some
  other existing suite (it shares `ServerFormFields` and presumably the same
  `addServer`/fetch-error surface, so this may already be true and just
  needs to be checked file-by-file), or (b) port the missing cases from
  `onboarding-flow.test.tsx`'s `describe('Onboarding – error handling')` and
  `describe('Onboarding – API key visibility toggle')` blocks onto
  `ServerEditModal` (add mode) before the old suite is removed, so no net
  coverage is lost in the collapse.
- `__tests__/e2e/settings-flow.test.tsx::Settings – remove server flow` and
  the rest of that suite are unaffected (edit/remove is already
  `ServerEditModal`-only) but should stay green through the change since
  `ServerEditModal.tsx` itself is being touched.

### Verification for the eventual implementation PR

`npx eslint` on the touched files; `npx tsc --noEmit`; `npx jest --ci
--runInBand --testPathPattern "ServerEditModal|PairConfirm|ConnectStep|onboarding-flow|settings-flow|DisplayedServers"`
(the issue's own suggested pattern, widened to also catch the retired/ported
onboarding-flow cases); and a manual add-a-second-server pass on a simulator
per the issue's own recommended verification.
