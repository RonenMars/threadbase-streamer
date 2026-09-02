# F3 — carry-ins from Group M (planning only)

Worktree: `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-pairing-followups`
Branch: `fix/pair-followups-f3`, based on `origin/main` = `e9f42990` (includes F1 #908, F2 #915).
No code written this turn.

**Approved** by `e2ee-owner`, in the plan's own order. Split into two PRs:
- **F3a = #903** (store-only, item 3).
- **F3b = #904 + item 1's rename-gap test** together (one-line fix plus
  test-only, disjoint from the store).

Condition added on #903's test: asserting exactly one
`setItemAsync('threadbase_servers', …)` call proves the *count*, not the
*content* — also assert the single persisted payload carries the full
record (server fields, `activeServerIds`/`displayedServerIds` membership,
`requireEncryption: true`), so a "skip the inline persist" fix cannot
silently drop the list membership the inline write used to carry. Keep the
unpinned add's single write as the negative control.

`Closes #903` / `Closes #904` in the respective PR bodies. D1 fires when
F3b merges.

## PR F3a — MERGED

PR [#917](https://github.com/RonenMars/threadbase-mobile/pull/917),
squash-merged `a08be6bc13896fcb61a99cfb2f9fdb9d1bdc9d94`, 2026-08-29
14:29:09Z. Branch `fix/addserver-single-persist` (split off from
`fix/pair-followups-f3` before push, learning from the F1/F2 branch
mixup — `fix/pair-followups-f3` reset to clean `e9f42990` for F3b).
Issue #903 closed automatically on merge.

Owner requested two additional assertions before clearing (content of
the single write's own payload — `requireEncryption: true`,
`hasEverHadServer: true`, `activeServerIds` membership — not just a
write-count check, since a `.pop()`-based helper wouldn't distinguish
"1 write with the pin" from "2 writes, last one pinned"). Added by the
orchestrator directly, re-verified with the mutation before re-review.

Diff: 2 files, 36 insertions(+), 1 deletion(-). CI green.

## PR F3b — MERGED

PR [#919](https://github.com/RonenMars/threadbase-mobile/pull/919),
squash-merged `92033156` (43d5e571017699a4c734f4d50564d529), 2026-08-29
18:11:18Z. Branch `fix/pair-followups-f3`, based on `a08be6bc`
(fast-forwarded from `e9f42990` mid-planning, per the owner's
correction — the rename-gap test needed to run against F3a's
just-merged single-persist behaviour). Issue #904 closed automatically
on merge.

Two items landed together: the one-line `publicUrl` forward fix for
`ConnectStep.commitScan` (test seen red first), and the
`ServerEditModal` edit-mode rename-gap test (AUDIT-M item 5), with a
mutation in `ServerFormFields.splitUrl` proving the test actually
guards the identity-preservation invariant.

Diff: 3 files, 208 insertions(+). CI green. All three F3 items closed —
#903 (F3a), #904 and the rename gap (F3b).

## Item 1 — `ServerEditModal` → `editServer` rename gap (AUDIT-M item 5)

**Current state re-verified against `e9f42990`:**
- `__tests__/unit/stores/servers.test.ts` `'preserves the device key, server key and pin on a
  label-only edit'` (~line 502) drives `editServer` directly (not through the modal) and
  asserts `deleteItemAsync).not.toHaveBeenCalledWith(...)` — a not-deleted assertion, not a
  read-back. The file's `expo-secure-store` mock (top of file) is a bare `jest.fn()`, no
  backing map, so a read-back isn't even possible there today.
- `__tests__/integration/components/ServerEditModalConfirmGate.test.tsx` only renders add
  mode (`serverId={null}`); `ServerEditModalAddFlow.test.tsx` (sibling, add-mode only) is the
  same shape. Nothing renders `ServerEditModal` with `serverId` set and drives Save.
- The device static key lives at `` `threadbase_e2ee_device_key_${id}` `` — written by
  `services/e2ee/pair-handshake.ts` (`deviceStaticKeyStoreKey`, not exported), read/written
  through `@/services/secure-store`, the same module `stores/servers.ts` imports. `editServer`
  itself never touches that key on a pure rename (no url/apiKey identity change), so
  "survives" is a true no-op today — the risk AUDIT-M flags is a *regression* in how the
  modal assembles its patch (e.g. `ServerFormFields`' URL normalisation disagreeing with the
  stored `url`, which would make `editServer` treat the rename as an identity change and wipe
  everything).

**Test to add:** new file `__tests__/integration/components/ServerEditModalEditFlow.test.tsx`
(sibling to the existing `ServerEditModalAddFlow.test.tsx`), following `e2ee-require-encryption.test.ts`'s
pattern of mocking `@/services/secure-store` (not `expo-secure-store`) with a real backing
`Map`, so `getItemAsync`/`setItemAsync`/`deleteItemAsync` actually round-trip:

1. Seed `useServersStore` with one server (`serverPublicKey`, `deviceToken`, `requireEncryption: true`)
   via the real `addServer(...)` (as `servers.test.ts`'s `addPinnedServer()` helper does), so the
   store's own persisted-list bookkeeping is real, not a hand-built `setState`.
2. Pre-seed the backing map at `` `threadbase_e2ee_device_key_${id}` `` with a sentinel value
   (standing in for what `pair-handshake.ts` would have written at pairing time — that module is
   not otherwise exercised by this test, only the key it uses).
3. Mock `PairScannerModal` and `wsManager` the same way `ServerEditModalAddFlow.test.tsx` does.
4. Render `<ServerEditModal visible serverId={id} onClose={jest.fn()} />` (edit mode), change
   only the label field, press Save.
5. Assert, via a real read-back:
   - `getItemAsync('threadbase_e2ee_device_key_' + id)` still returns the sentinel (device key
     survived).
   - `getItemAsync('threadbase_api_key_' + id)` still returns the original api key.
   - `useServersStore.getState().getServer(id)` has `serverPublicKey` and `requireEncryption`
     unchanged, and `label` updated.
   - (`identityReplaced` isn't a field on `ServerConfig`/exposed directly — the observable proxy
     for "identity was NOT replaced" is exactly these three survivals; a flip to `true` inside
     `editServer` is what deletes them, per `servers.ts`'s `identityReplaced` branch.)

**Mutation to see it red:** in `ServerFormFields`' `splitUrl`/URL-reassembly path (or directly
in the test, by having `ServerEditModal`'s `commitSave` normalise a trailing detail
differently), force the label-only edit's reassembled `url` to differ from the stored one by
one character — the real `editServer` must then take the "URL changed" branch, and the new
survival assertions must go red. (Exact mutation site to be picked at implementation time,
after re-reading `editServer`'s identity-comparison logic — this is a plan, not yet verified
red.)

**Verdict:** test-only, no source change identified as needed — same as AUDIT-M's own verdict
("HOLDS" at the store level). Implementable as scoped.

## Item 2 — #904, `ConnectStep.commitScan` drops `publicUrl`

**Re-verified against current `origin/main`:** issue #904 is open, P3/tech-debt, confirms the
fix as `add publicUrl: result.publicUrl ?? undefined` to `commitScan`'s payload.

- `components/onboarding/steps/ConnectStep.tsx`, `commitScan` (now at line ~165, not the
  audit's 167-177 — file has shifted slightly but the omission is unchanged): builds the
  `onPaired` payload with `deviceId`, `deviceToken`, `capabilities`, `serverPublicKey`,
  `requireEncryption` — no `publicUrl`.
- `app/pair.tsx`'s `commitPending` (~line 130): the equivalent `addServer(...)` call includes
  `publicUrl: exchanged.publicUrl ?? undefined`.
- `components/onboarding/OnboardingNavigator.tsx`'s `handleEnter` (~line 160) already forwards
  `paired.publicUrl` into `addServer` when it commits — so `PairResult` carries the field and
  the navigator is ready for it; the only gap is `ConnectStep` never populating it on the scan
  path.

**Code change:** one line in `ConnectStep.tsx`'s `commitScan`:
```
publicUrl: result.publicUrl ?? undefined,
```
placed alongside the existing `serverPublicKey`/`requireEncryption` lines, matching
`app/pair.tsx`'s phrasing exactly.

**Test to add:** no existing test drives `ConnectStep`'s real `handleScanSuccess`/`commitScan`
(`ConnectStepManual.test.tsx` mocks `useTBPair` and only exercises the manual-paste path;
`OnboardingNavigator.test.tsx` mocks `ConnectStep` entirely). New test in
`__tests__/integration/components/ConnectStepScan.test.tsx`:

1. Mock `PairScannerModal` to capture its `onSuccess` prop (same substitution class as
   `ServerEditModalAddFlow.test.tsx`'s scanner stub, but capturing instead of discarding the
   callback) and `PairCameraIdentityCard` as a no-op (or use a fixture with no
   `serverPublicKey` so `handleScanSuccess` calls `commitScan` directly without the camera-
   fingerprint gate — simpler, and still a real, reachable shape: a legacy/non-e2ee QR).
2. Render the real `ConnectStep` with an `onPaired` spy.
3. Invoke the captured `onSuccess` with a fixture `ExchangeResult` that includes a non-null
   `publicUrl`.
4. Assert `onPaired` was called with `publicUrl` equal to the fixture's value.

**Mutation to see it red:** the fix line itself — delete it (i.e. run the new test against the
current buggy `commitScan`) — must fail with `publicUrl` missing/undefined in the received
call. This doubles as the "seen red before the fix" proof: write the test first against
unpatched code, confirm red, then add the one-line fix, confirm green.

**Verdict:** small, matches #904's own suggested fix and test note. Implementable as scoped.

## Item 3 — #903 (P2), crash window in `addServer`

**Re-verified against current `stores/servers.ts`** (line numbers shifted since the audit,
per its own note about #900 renumbering):

- `addServer` (~line 230-292): builds `config` without `requireEncryption`, does one `set()`
  that calls `persistServerList` synchronously-but-unawaited inside the setter (~line 283),
  then — outside `set()`, also unawaited — calls `get().setRequireEncryption(id, true)`
  (~line 286) when `device?.requireEncryption` is true. `setRequireEncryption` (~line 338) does
  its own `set()` + its own `persistServerList` call. So a pinned add persists twice: once
  without the pin, once with it.
- The "one writer of the pin" comment sits on `setRequireEncryption` itself (~line 334-336):
  "The one writer of the pin. The design has it auto-set on the first successful encrypted
  connection too; that caller lands with the connection wiring, and writes the same bit
  through here." Read plainly, this says: *every* call site that wants to set
  `requireEncryption` on a server — today's `addServer`, and a future first-successful-
  encrypted-connection call site — must go through `setRequireEncryption`, never assign the
  field directly. That is the boundary item 3's task description says not to cross.

**A fix that stays inside `stores/servers.ts` and does not cross that boundary:**

The double-persist is not required by the "one writer" rule — the rule is about who *assigns
the field*, not about how many times the result gets flushed to disk. `addServer` can keep
`setRequireEncryption` as the only place that writes `requireEncryption`, while still
producing exactly one disk write for the pinned case, by skipping the initial persist when a
pin write is about to immediately follow:

```ts
set((state) => {
  const servers = { ...state.servers, [id]: config }
  const activeServerIds = ...
  const displayedServerIds = ...
  if (!device?.requireEncryption) {
    persistServerList(servers, activeServerIds, displayedServerIds, true)
  }
  return { servers, activeServerIds, displayedServerIds, hasEverHadServer: true }
})

if (device?.requireEncryption) get().setRequireEncryption(id, true)
```

`setRequireEncryption` is unchanged — still the sole function that assigns the `requireEncryption`
field — and still the one that persists when it runs. `addServer` only decides *whether* the
inline persist runs, which is bookkeeping already local to `addServer`, not a new writer of the
bit. Effect: a pinned add now performs exactly one `SecureStore.setItemAsync('threadbase_servers', …)`
call, and that one blob already carries `requireEncryption: true` — there is no longer a window
where the disk holds `serverPublicKey` with the pin absent, because the first (and only) time
this server's record touches disk, the pin is already decided. An unpinned add is unchanged
(one persist, as today).

**Test to add:** extend `__tests__/unit/stores/servers.test.ts`'s existing
`'records the pinned server key and the pin, in memory and on disk'` test (~line 448) with an
assertion on write *count*, not just content:
```ts
const serverListWrites = setItemAsync.mock.calls.filter(([key]) => key === 'threadbase_servers')
expect(serverListWrites).toHaveLength(1)
```
**Mutation to see it red:** revert to the current two-call shape (restore the unconditional
`persistServerList` inside the initial `set()`) — the new assertion must go red (length 2, not
1). This is the regression test #903 itself asks for ("add a test that asserts the first
persisted blob already carries the pin" — the stronger, sufficient version of that ask is
"there is no separate first blob at all").

**Verdict: implementable within the `stores/servers.ts`-only constraint.** The change is
confined to `addServer`'s function body (conditional persist) and does not touch
`setRequireEncryption`'s signature, behavior, or its role as sole writer of the field, and
touches no file outside `stores/servers.ts` plus its own test file. Recommend proceeding with
this shape rather than reporting back, pending owner approval.

## Order for implementation (pending approval)

Same house style as F1/F2: one PR at a time, sub-agent writes, orchestrator reviews.
Suggested order — item 3 (P2, most impactful) first, then item 2 (#904, one line), then item 1
(test-only, no open issue tracks it). Owner may reorder.
