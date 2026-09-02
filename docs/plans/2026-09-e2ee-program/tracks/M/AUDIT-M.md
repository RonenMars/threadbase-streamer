# Group M — mobile pairing trust-boundary audit

Session `e2ee-M-opus5-high [109d97]`. Owner ref recorded: `e2ee-owner [ddde5e]`.

## Pins

| What | Value |
|---|---|
| tb-mobile `origin/main` | `229faf6bfb703d8f189512cbb1b79c9829cf09f4` (2026-08-28 19:24:58 +0300, #899) |
| tb-streamer tag `v1.70.6` | `0069afc103109e90fa08ac051634c894fdc42eea` (on remote) |
| tb-streamer `origin/main` | `76d6d420ee1753153b929c63c5942daee23a9124` |
| Interop package | `@threadbase-sh/streamer@1.70.6` exact, installed under a scratch `HOME` (exit 0) |
| Worktree | `../tb-mobile-worktrees/e2ee-pairing-audit` on `fix/e2ee-pairing-audit`, own `npm ci` (exit 0) |
| PRs | #768, #766, #782, #833 all `MERGED` |

## The seven rows

| # | Guard | Covering test | Real path? | Verdict |
|---|---|---|---|---|
| 1 | `services/pair-exchange.ts:202` (`SERVER_PUBLIC_KEY_SHAPE`); `app/pair.tsx:66` (`params.spk !== undefined`) | `pair-exchange.test.ts:137` (4 cases) + neg. control `:153`; `PairDeepLinkScreen.test.tsx:321` | deep link YES; scanner NO; paste NO | **DEFECT (coverage)** |
| 2 | `pair-exchange.ts:518` `raw == null` → `e2ee-refused`; `:151` `NON_RETRYABLE_EXCHANGE_KINDS` | `pair-exchange.test.ts:751`; `PairScannerPermissionRefresh.test.tsx:197`; `PairDeepLinkScreen.test.tsx:349` | YES | **HOLDS** |
| 3 | `services/e2ee/pair-handshake.ts:186-219` | `pair-exchange.test.ts:589` (reads keychain inside `fetch`) + neg. control `:615`; reuse `:703`, `:737` | YES | **HOLDS** |
| 4 | `pair-exchange.ts:509-609` `readPairHandshakeReply` | `pair-exchange.test.ts:554` (outer and inner disagree on every field); `:876`, `:928`, `:940`, `:951` | YES | **HOLDS** |
| 5 | `stores/servers.ts:470` `identityReplaced`; `:477-518` | `servers.test.ts:502` (preserve) / `:528` (clear, both branches) | PARTIAL — via `editServer` directly, not `ServerEditModal` | **HOLDS** |
| 6 | `pair-exchange.ts:263` before `beginPairHandshake`; `secure-store.web.ts:17` | `pair-exchange.test.ts:998` + legacy control `:1015` | YES | **HOLDS** |
| 7 | `stores/servers.ts:531` `loadPersistedServers`; `:179` `serverConfigFromPersisted` | `e2ee-require-encryption.test.ts:170` (pin only); `servers.test.ts:553` (helpers only) | PARTIAL | **DEFECT** |

## Defect 1 — item 1: two of three entry surfaces have no malformed-`spk` test

The guard itself is correct and well covered at the parser. What is missing is the surface.

- **Deep link — covered, and the model.** `PairDeepLinkScreen.test.tsx:321` renders the real screen, real `parsePairUri` (the module mock at `:9` spreads `requireActual` and only wraps the parser in `jest.fn`), asserts the damaged-key copy, `exchangeToken` not called, and no retry affordance.
- **Scanner — no test.** `PairScannerModal.tsx:77` calls the real `parsePairUri`, and `PairScannerPermissionRefresh.test.tsx:23` keeps it real. But no test scans a QR whose `spk` is malformed. Every `spk` in that file is in a comment.
- **Paste — no test, and the harness hides it.** `jest.setup.js:9` sets `global.__DEV__ = true`. `hooks/useTBPair.ts:203` returns `finishMockSequence()` under `__DEV__`, which resolves `onSuccess({ url, apiKey: token })` without ever parsing. `ConnectStepManual.test.tsx` never flips the flag, so its two confirm-gate tests (`:123`, `:138`) exercise the mock, not `resolveCredentials`. Only `__tests__/unit/hooks/useTBPair.test.ts:33` sets `__DEV__ = false`.

**Positive control that passes green and should not:** a `ConnectStep` paste test with `spk` of 42 characters currently reaches the confirm gate and adds a server, because the DEV branch never parses. That is the green-but-wrong result house rule 2 asks for.

Proposed mutations:
- Scanner: `pair-exchange.ts:202` → `if (false && spkRaw !== null && !SERVER_PUBLIC_KEY_SHAPE.test(spkRaw))`. A new scanner test must go red; today nothing does.
- Paste: `useTBPair.ts:203` → delete the `__DEV__` early return. A paste test written with `__DEV__ = false` must stay green; today the existing tests would break, proving they depend on the mock.

## Defect 2 — item 7: the key material never round-trips through the real loader

`e2ee-require-encryption.test.ts:170` does drive the real `loadPersistedServers` (PR #776 made the `AsyncStorage` import static, `stores/servers.ts:5`), but it asserts one field: `requireEncryption`.

`servers.test.ts:553` covers `serverPublicKey`, `deviceId`, `deviceToken`, `deviceCapabilities`, `publicUrl` — but through `parsePersistedServers` + `serverConfigFromPersisted` only, and it **hands `{ apiKey: 'key-abc', deviceToken: 'dt_9' }` in as literals**. So the line that actually recovers the scoped credential —
`stores/servers.ts:554`, `await SecureStore.getItemAsync(secureKeyForDeviceToken(entry.id))` — is asserted by nothing. A reader that dropped it would leave `requireEncryption: true` with no device token and no pinned key: the split state design §6.1 exists to prevent.

Proposed mutation: `stores/servers.ts:555` → `?? undefined` becomes `undefined`. Whole suite must stay green today; that is the defect.

Fix shape (test-only): extend the `loadPersistedServers` case to seed the device-token and server-key material, wipe memory, load, and assert `serverPublicKey` and `deviceToken` alongside the pin.

## Stale documentation found (not defects)

- `stores/servers.ts:146-157` and `__tests__/unit/stores/servers.test.ts:421-434` both still claim `loadPersistedServers` "cannot be executed by any test in this repo" because of a dynamic `import()`. PR #776 made that import static and `e2ee-require-encryption.test.ts:184` executes the function. This stale rationale is *why* defect 2 exists — the coverage stopped at the helpers on a constraint that no longer holds.

## Observations carried to the owner, no fix proposed

1. **`pendingTargetFromPaste` fallback** (`services/pair-confirm-target.ts:58-70`) labels a pairing `kind: 'e2ee'` with a fingerprint taken from the *pasted* `spk` when the exchange returned no proved key. In production that state is unreachable (a present `spk` either throws or returns proved). It is reachable under `__DEV__`, where the gate then presents an unverified key as verified. Cosmetic in a dev build; noted because it is the "verified-looking fingerprint for an unproved key" shape.
2. **`addServer` persists twice, unordered** (`stores/servers.ts:261-292`): `config` omits `requireEncryption`, so `persistServerList` runs once inside `set()` without the pin and again from `setRequireEncryption`, neither awaited. `servers.test.ts:451` asserts the *last* payload carries the pin, which holds under a FIFO mock; `expo-secure-store` documents no ordering guarantee across two `setItemAsync` calls. Demonstrating it needs an out-of-order mock, and the root-cause fix (serialise `persistServerList`) touches shared store code outside the seven items. Owner's call.
3. **Contract wording vs code on `v`**: issue #698 item 1 lists "wrong `v`" as a malformed-`spk` hard error. `parsePairUri:210-212` deliberately *drops* a bad `v` instead, because branching on `v` would make the downgrade reachable by editing one character; the version check lives at the handshake (`pair-exchange.ts:528`, `:555`). The code's reasoning is the better one — flagging the divergence, not proposing a change.
4. **Deep-link empty-param assumption**: `PairDeepLinkScreen.test.tsx` mocks `useLocalSearchParams` to hand `spk: ''` directly. That expo-router really delivers `''` rather than `undefined` for `?spk=` is assumed, not proven. The `buildPairUri` allowlist depends on it.

## Streamer contract cross-check (v1.70.6)

`src/e2ee/pair-payload.ts:115-139` and `src/server.ts:2306-2315` match mobile's `PairHandshakeReplyWire` field for field. Both versions are `1` (`pair-request.ts:18`, `types/api.ts:498`). `this.publicUrl` is `string | null` (`server.ts:377`), so the key is always on the wire — mobile's "absent key is malformed, `null` is a value" rule is safe. Interop run still owed for items 3 and 4.

---

# Interop run — real `@threadbase-sh/streamer@1.70.6` on loopback (2026-08-28 21:40 IDT)

Rig: scratch `HOME` under the session scratchpad, `--host 127.0.0.1 --port 8791 --feature e2ee=true`, throwaway API key on argv, own `runtime.db`. Real `~/.threadbase` mtime `1787915429` before and after — untouched. Streamer stopped, harness deleted, worktree `git status --porcelain` empty. Harness kept out of git at `scratchpad/interop-rig/interop-harness.ts.txt`.

Only the keychain was mocked. The network, the Noise handshake, message 2 and the streamer's device registry are real. `jest-expo` installs expo's winter `fetch`, which cannot open a socket under jest, so `globalThis.fetch` was replaced with a `node:http` implementation — the transport is substituted, the protocol is not.

Server facts: `/api/info` → `e2ee: { supported: true, enabled: true, version: 1, required: false }`, `publicUrl: null`, `serverIdentityKey` 43 chars matching mobile's `SERVER_PUBLIC_KEY_SHAPE` exactly.

## Item 4 — msg2 on real bytes: HOLDS

```
{"e2eeRequired":true,"publicUrl":null,"machineName":"Ronens-MacBook-Pro.local",
 "capabilities":["history:read","session:control","fs:browse","fs:upload","notifications","admin"],
 "apiKeyIsDeviceToken":true,"serverPublicKey":"KisQXaHZOCq9AkPI76uzV-ZR0wfP7uYjNPzdkF1m5yI",
 "url":"http://127.0.0.1:8791"}
```

`publicUrl` really is `null` on a LAN pairing, so mobile's "`null` is a value, absent is malformed" rule is exercised on the wire and not merely reasoned about. `apiKey === deviceToken` — the sealed compatibility key is not the credential. `url` is the typed address, not the advertised one.

## Item 3 — one device row across a re-pair: HOLDS

```
{"dPrivReused":true,"devicesBefore":1,"devicesAfter":1,
 "firstDeviceId":"6dd8b95f-0b87-4e60-bb95-ccc1d4dcf9c4",
 "repairDeviceId":"6dd8b95f-0b87-4e60-bb95-ccc1d4dcf9c4","sameDeviceRow":true}
```

Two separate pairings with two separate pair tokens, one `D_priv`, one device row with the same `deviceId`. The registry after the run:

```
{"deviceId":"6dd8b95f-...","name":"M interop phone","e2ee":true,
 "capabilities":["history:read","session:control","fs:browse","fs:upload","notifications","admin"],
 "revokedAt":null}
```

`name` is the value carried in **message 1's authenticated payload**, so msg1's authenticated `deviceName` lands on the server row — the outbound half of GATE 4, confirmed on real bytes.

## DEFECT 3 (new, found only by the interop run) — an unclassified crypto error escapes the `PairExchangeError` taxonomy

A `spk` of 43 valid base64url characters that is not a valid X25519 point passes every existing guard and throws a **bare `Error`** out of `exchangeToken`:

```
{"ctor":"Error","name":"Error","message":"X25519: invalid shared key"}
```

Path: `parsePairUri:202` accepts it (`SERVER_PUBLIC_KEY_SHAPE` is a charset-and-length regex). `decodeServerStaticKey:130` accepts it (length 43, decodes as base64). `createNoiseInitiator` accepts it. It fails at the DH inside `started.handshake.writeMessage1(...)` — `services/pair-exchange.ts:307` — which sits **outside** the `try/catch` that wraps `beginPairHandshake` at `:274-284` and outside the `fetch` try at `:327`. Nothing wraps it.

Consequences on both real entry paths:

- `app/pair.tsx:121` → `resolveErrorMessage` sees neither a `PairUriError` nor a `PairExchangeError`, logs `pair.exchange unrecognized`, and shows `scanner.errors.generic`. `canRetryPairFailure:37` returns `true`, so the screen offers **"Try again" on a link that can never succeed**.
- `PairScannerModal.tsx:92` → `setCanRetry(!(failure instanceof PairExchangeError) || …)` is `true` for the same reason.

Why no existing test catches it: `pair-exchange.test.ts:778` uses `vectors.keys.clientStaticPublic`, a *valid* point that is the wrong key (→ `e2ee-handshake`); `:860` uses `'nope'`, the wrong *length* (→ `e2ee-malformed`). A well-shaped-but-invalid point is neither, and `parsePairUri`'s regex cannot distinguish it — only a real curve operation can.

Severity: **fails closed** — no server added, no plaintext retry, no downgrade. This is a failure-classification defect, not a trust-boundary breach: the error is hard, but it is not the *classified* hard error item 1's contract describes, and the retry affordance is wrong. Fix is a source change (bring `writeMessage1` inside the guarded region and map to `e2ee-malformed`), so it needs its own plan and does not belong in either approved test-only PR.

Mutation to see red: none needed to prove the defect — the failing observation above is the evidence. For the fix, the regression test is `exchangeToken({ serverPublicKey: 'A'.repeat(43) })` asserting `kind: 'e2ee-malformed'`; reverting the guard makes it throw a bare `Error` again.

---

# CORRECTION — 2026-08-28 21:55 IDT, after the sub-agent's report arrived

The `mobile-pairing-trust-boundary-engineer` report reached this session late (it had completed at 21:34; two idle notices carried no content). It independently reproduced items 2, 3, 4, 7 and the stale-comment finding, and corrected two of my conclusions. Both corrections verified here before being accepted.

## Item 6 flips: HOLDS → DEFECT (coverage). The table's headline is now four rows hold, three are defects.

`package.json:187` uses the **root** `jest-expo` preset, whose haste block is:

```
{"defaultPlatform":"ios","platforms":["android","ios","native"]}
```

`web` is absent, so **jest never resolves `services/secure-store.web.ts`**. Confirmed by grep: the only occurrences of `HAS_SECURE_KEYCHAIN` anywhere under `__tests__` are inside `pair-exchange.test.ts`'s own mock factory (`:19`, `:23`), which supplies the value itself. No test imports the real web module.

So `pair-exchange.test.ts:998` proves the *branch* in `exchangeToken` reacts correctly to a false `HAS_SECURE_KEYCHAIN` — which is worth having — but nothing proves the web build actually reports `false`. Flip `secure-store.web.ts:17` from `false` to `true` and the whole suite stays green while the web build writes `D_priv` to `localStorage`, which is precisely what item 6 forbids and what mobile-design §5.2 calls the value that must not be stored under a weaker guarantee.

My original verdict rested on reading the two files and the branch test and not asking whether the web file is reachable by the runner at all. That is the gap the methodology's "positive control proving the harness sees what it claims" exists to catch, and I did not apply it here.

## Item 1: my mechanism was wrong; the conclusion stands, and the real hole is bigger

I wrote that `ConnectStepManual.test.tsx` exercises `useTBPair`'s `finishMockSequence()` branch because `jest.setup.js:9` sets `__DEV__ = true`. Wrong on both counts:

- `ConnectStepManual.test.tsx:12-14` does `jest.mock('@/hooks/useTBPair', () => ({ useTBPair: jest.fn() }))` — the whole module is replaced, so the real hook body never runs and `finishMockSequence()` is never *reached*, not mis-branched. `__DEV__` is irrelevant in that file.
- Independently, `fillAndConnect` types a `tb_…` key (`:114`), so `classifyPairCredential` returns `api-key` and `ConnectStep.tsx:138` takes the non-pair-uri branch; `parsePairUri` at `ConnectStep.tsx:146` never runs either.

The real `useTBPair` body **is** exercised, in `__tests__/unit/hooks/useTBPair.test.ts`, which does set `__DEV__ = false` at `:33`. So the production paste path is covered — just never with an `spk`. Its `:99` case parses a real `threadbase://` URI and asserts `exchangeToken` is called *without* `serverPublicKey` (`:125-130`).

**The sharper statement of item 1's defect**, which supersedes mine: deleting `serverPublicKey: parsed.spk` from `PairScannerModal.tsx:89` or from `hooks/useTBPair.ts:80` leaves the entire suite green, while a scanned or pasted E2EE QR silently pairs in **plaintext**. Those two lines are the downgrade the item forbids and nothing watches either of them. That is a live silent-downgrade hole in the harness, not merely a missing malformed-key case.

**PR (b)'s planned mutation is therefore invalid** and must change: "drop the `useTBPair.ts:203` `__DEV__` early return and watch the existing paste tests break" would prove nothing, because those tests do not reach the hook. The correct mutations are the two `serverPublicKey:` deletions above.

## Item 5: the preservation assertion is weaker than I recorded

`servers.test.ts:502` verifies the device static key survives a label-only edit with a **not-deleted** assertion on `deleteItemAsync`, not a read-back, and the SecureStore mock in that file (`:12-16`) is a bare `jest.fn()` with no backing map. Nothing drives `editServer` through `ServerEditModal` either — `ServerEditModalConfirmGate.test.tsx` only renders the add case (`serverId={null}`). So a regression in how the modal assembles its patch — a normalised URL differing from the stored one on a pure rename, flipping `identityReplaced` to `true` — is caught by nothing. Verdict stays HOLDS at the store-action level; the real-path caveat is larger than "driven via `editServer` directly".

## Observation 2 restated: not a race, a crash window

My "unordered writes" framing was wrong in its mechanism. `persistServerList` builds its list synchronously and its first `await` is *on* `SecureStore.setItemAsync` (`:143`), so both calls are recorded in order, synchronously, during `addServer`. `servers.test.ts:451` asserting `.pop()` is therefore deterministic, not FIFO-mock luck.

What remains real: nothing asserts the first blob is the pin-less one, and a crash between the two writes leaves a persisted record with `serverPublicKey` set and `requireEncryption` absent — which `encryptionPinRefuses` reads as unpinned. Collapsing to one write would cross the "one writer of the pin" comment at `:289-291`, so it is a design call. The P2 issue should say this, not "no ordering guarantee".

## New finding beyond the seven

`components/onboarding/steps/ConnectStep.tsx:167-177` — `commitScan` omits `publicUrl` from its `onPaired` payload, while `app/pair.tsx:139` forwards it. The authenticated `publicUrl` from message 2 is discarded on the onboarding camera-scan path only. Low severity (nothing reads `publicUrl` today, per #722), but it is an authenticated value being dropped on one of three paths, and the two paths disagree.

## Not covered by item 7, noted for completeness

`e2ee-require-encryption.test.ts:171` only exercises the `secureRaw` branch of `loadPersistedServers`. The AsyncStorage migration at `stores/servers.ts:536` and the legacy single-server migration at `:576-608` remain untested. Both sit outside item 7's scope.

---

# Falsifiability mutations (round two)

Every safeguard gets one mutation that must turn a test red. A mutation that stays green is the finding.

## Measured by the sub-agent, in its own worktree at `e35124b0`

| # | Item | Mutation | Result |
|---|---|---|---|
| M1 | 1 | `app/pair.tsx:66` `params.spk !== undefined` → `params.spk` | RED |
| M2 | 2 | `pair-exchange.ts:518` `if (raw == null)` → `if (false)` | RED |
| M3 | 3 | `pair-handshake.ts:200` `if (encodedKey !== storedKey)` → `if (false)` | RED |

**M1 is the most legible evidence in the audit.** Dropping the empty-string case from the deep-link allowlist does not merely flip an assertion — the rendered tree shows the downgrade happening: `PairDeepLinkScreen.test.tsx :: refuses an empty server key instead of pairing in plaintext` fails with `Unable to find an element with text: The server key in this pairing code is damaged…`, and what renders instead is a generic "Pairing failed." **beside a live `pair-deep-link-try-again` button**. The empty `spk` was dropped, the flow took the legacy path, and the UI invited the user to retry into it. That is absent-vs-present-invalid collapsing, on screen.

M2: `exchangeToken — the pairing handshake › fails hard when the reply carries no message 2 at all` — `- Object { "kind": "e2ee-refused" }` / `+ [TypeError: Cannot read properties of undefined (reading 'noise')]` at `pair-exchange.test.ts:762`.

M3: seven tests red across two suites, including the flagship ordering case — `has this device static key durably in SecureStore by the time the request goes out`, `expect(received).toBeDefined()` / `Received: undefined` at `pair-exchange.test.ts:609`.

Baseline before any mutation, on `3c7ca880`: unit + integration EXIT 0, 228 suites / 2140 tests green.

Note on line numbers: #900 removed ten lines from `stores/servers.ts`, so targets renumbered — item 5's `identityReplaced` 470→464, item 7's `requireEncryption` read 199→193, the deviceToken read 555→548-549.

## Measured by the orchestrator, for PR (b)

| # | Item | Mutation | Result |
|---|---|---|---|
| B1 | 1 | delete `serverPublicKey: parsed.spk`, `PairScannerModal.tsx:89` | RED (was green before PR (b)) |
| B2 | 1 | delete `serverPublicKey: parsed.spk`, `useTBPair.ts:80` | RED (was green before PR (b)) |
| B3 | 6 | `secure-store.web.ts:17` `false` → `true` | RED (was green before PR (b)) |

B1 — `PairScannerPermissionRefresh.test.tsx :: PairScannerModal — the QR server key › forwards a well-formed server key to the exchange`:
`Expected: ObjectContaining {"serverPublicKey": "BBB…"}` / `Received: {"deviceName": "Threadbase Mobile (ios)", "token": "pt_x", "url": "https://a.test"}`.

B2 — `useTBPair.test.ts :: useTBPair — the pasted URI server key › forwards the pasted server key and reports the pairing as encrypted`: the received call omits `serverPublicKey` entirely.

B3 — `secure-store-web-refusal.test.ts`: `reports that it is not a keychain` (`Expected: false / Received: true`) and `refuses an encrypted pairing and writes no device key`. Negative control `still pairs a legacy QR that offered no server key` stayed green under the same mutation, so the refusal is targeted rather than a build that cannot pair at all.

**That all three were green before PR (b) is the defect, and it is the whole of items 1 and 6.**

## Process incident — two writers in one worktree

At 21:59 the orchestrator edited `e2ee-pairing-audit` while the sub-agent was running mutations in it; the agent had not yet picked up the 18:57Z message re-pointing it to `e2ee-mutation-runs`. The agent detected two dirty files it had not written, declined to stash or revert them under the stashing policy, and stopped with a stop-work notice rather than measure in-progress work and report the inverse of its own finding.

Nothing was lost: `git diff --stat 3c7ca880 e35124b0` is empty — #900 squashed a single commit, so the merge is tree-identical — and M1–M3 stand.

Rule adopted program-wide as a result: **a dispatched agent is presumed resident in its tree until it acknowledges the move, and the orchestrator never edits that tree in the meantime.** The orchestrator is the likely second writer precisely because it is the one that merges.

## Round two complete — all ten mutations, `audit/e2ee-mutation-runs` @ `e35124b0`

Every revert verified by SHA-1 match against the pre-mutation file, not by exit code. Tree clean afterwards.

Baseline: 228 suites / 2140 tests. Caveat recorded: in a 228-suite parallel batch `PairDeepLinkScreen.test.tsx :: exchanges the token, adds the server, and lands on the hub` fails and passes alone (16/16, exit 0) — load artifact per the repo's isolation rule, not a defect.

### Seven reddening mutations — all RED

| # | Item | Mutation | Failed |
|---|---|---|---|
| M1 | 1 | `app/pair.tsx:66` `!== undefined` → truthiness | 1 / 87 |
| M2 | 2 | `pair-exchange.ts:518` `raw == null` → `false` | 1 / 71 |
| M3 | 3 | `pair-handshake.ts:200` key-reuse guard → `false` | 7 / 83 |
| M4 | 4 | `pair-exchange.ts:385` inner `machineName` → outer | 2 / 71 |
| M5 | 5 | `servers.ts:464` `identityReplaced` → `true` | 1 / 38 |
| M6 | 6 | `pair-exchange.ts:263` web guard → `false` | 1 / 71 |
| M7 | 7 | `servers.ts:193` `requireEncryption` read → `undefined` | 3 / 50 |

**M4** names the attack in the diff: `Expected: "authenticated-machine"` / `Received: "outer-machine"` — the unauthenticated outer envelope winning.

**M6** is worse than a bypassed guard. The pairing *succeeds*: `Received promise RESOLVED instead of rejected. Resolved to value: {"apiKey": "dt_authenticated", "e2eeRequired": true, "serverPublicKey": "Q77bN0q9…"}`. Web completing an encrypted pairing and pinning itself to it — the state that writes `D_priv` to `localStorage`.

**M1**, rendered tree verbatim:

```
<View testID="pair-deep-link-screen">
      Pairing failed
    <Text>Pairing failed.</Text>
    <View accessible={true} testID="pair-deep-link-try-again">
      <Text>Try again</Text>
```

One character of allowlist truthiness turns a hard refusal into a generic failure *with a live retry button* — the app inviting the user to retry a QR whose server key it silently discarded.

### Expected-green half — the two defects proven

| # | Mutation | Result |
|---|---|---|
| G1 | `secure-store.web.ts:17` `false` → `true` | **GREEN**, 228/228 suites, 2140/2140 |
| G3a | delete `serverPublicKey: parsed.spk`, `PairScannerModal.tsx:89` | **GREEN**, 2140/2140 |
| G3b | delete it at `useTBPair.ts:80` | **GREEN**, 2140/2140 |
| G2 | `servers.ts:548-549` deviceToken read → `undefined` | **RED** — #900 bites |

On the merged tip you can tell the web build its `localStorage` shim is a keychain, or delete either silent-downgrade line outright, and 2140 tests still agree. That is items 6 and 1, stated at full rigour. G2 going red on `restores the pinned server key and the scoped device token, not just the pin` at `expect(restored.deviceToken).toBe('dt_9')` confirms #900 does what it claims.

### Item 6 resolution mechanism, proven empirically

`moduleNameMapper` rewrites `@/services/secure-store.web` to a real path; `moduleFileExtensions` appends `.ts`; `haste.platforms` governs only **bare** specifiers and is never consulted. Demonstrated in one run: explicit path yields `false`, bare specifier yields `true`, same file.

**The limit, now stated in the test file and the PR body**: an explicit-path test pins the **constant**, not the **wiring**. `pair-exchange.ts:6` imports the bare specifier, which under this preset resolves to the native module in every test, permanently. Metro selects `.web.ts` for the web bundle and no test here can see that choice. So the test catches an edited constant and would *not* catch `secure-store.web.ts` being renamed, deleted, or de-selected by Metro — web would silently get `true` and the suite would stay green. Adding `web` to `haste.platforms` would close it and would change resolution for every existing test, so it is deliberately not done.

### Process note

A foreground `--runInBand` full run exceeds the 600s limit and was killed mid-run once, leaving a mutation applied; the SHA fingerprint surfaced it. Full suites go in the background or in parallel mode — never foreground `--runInBand`.
