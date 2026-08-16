# E2EE — finish Phase 2 and take it to a real device

It coordinates both repos. The streamer is `~/dev/ai-tools/tb-streamer`; the mobile work happens in `~/dev/ai-tools/tb-mobile`.

Tracked in **[threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590)** (server) and **[threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698)** (client).

---

## Read before writing anything

Do not re-derive the design. It exists, it is cited to source, and the Phase 2 contract was corrected after the adversarial review of mobile #768 on 2026-08-16. This file incorporates that correction; older handoffs do not override it.

- `specs/end-to-end-encryption/remaining-work.md` — **start here.** What is built, what is not, verified against both `main` branches on 2026-08-16.
- `specs/end-to-end-encryption/mechanisms-in-plain-english.md` — what each landed piece does and why, if you want orientation before detail
- `specs/end-to-end-encryption/plan.md` — phase order and the reasoning behind it
- `specs/end-to-end-encryption/design.md` — server half · `mobile-design.md` — client half
- `specs/end-to-end-encryption/dilemmas.md` — the parked decisions, each with its working assumption and what would flip it

If you think a working assumption is wrong, say so and stop. Do not silently re-decide one.

---

## What already exists — do not rebuild it

**Streamer `main`:** the server identity key; the `e2ee` capability object on authenticated `GET /api/info`; `Noise_IKpsk1_25519_ChaChaPoly_SHA256` in `src/e2ee/noise.ts` with committed interop vectors; the `devices` runtime migration with `e2ee_static_pub` / `e2ee_required` / `e2ee_version`; the pair-token consume ordering; the `pair.token_replayed` warn line; the handshake wired into `POST /api/pair/exchange` (#626); and `tb-streamer identity` (#631).

**Mobile `main`:** the post-pairing capability read and `serverSpeaksE2ee`; `services/e2ee/noise.ts` and `services/e2ee/pair-handshake.ts` with the same interop vectors; the per-server require-encryption control in `components/servers/ServerEncryptionSection.tsx`.

**Open work:** streamer #630 is the exchange capability gate; mobile #766 is an unwired confirmation component; mobile #768 is intentionally still draft. Its CI is green, but review found a malformed-`spk` downgrade, generate-and-overwrite `D_priv`, unvalidated msg2, unauthenticated persisted response fields, incoherent edit clearing, and silent web key storage. Green is not approval.

**The interop vectors match byte for byte** — both messages, the transcript hash, both traffic keys, the PSK. Two implementations written from the specification without seeing each other. Do not casually regenerate them; if they ever stop matching, that disagreement is a finding, not a nuisance.

---

## Scope for this session

**Finish Phase 2 and get it running on a real device. Then stop and report.**

In order:

1. **Finish the streamer producer contract:** exchange gate (#630), conditional `spk`/`v` QR, authenticated msg1 registration inputs, and authenticated msg2 result.
2. **Repair and re-review mobile #768:** strict parser, load-or-create `D_priv`, strict msg2 validation, authenticated result use, coherent persistence/edit behavior, and native-only E2EE pairing.
3. **Land and wire the deep-link and paste confirmation gate** (#766, then its focused wiring pass).
4. **Auto-set the require-encryption pin after fully validated msg2** and close [mobile#759](https://github.com/RonenMars/threadbase-mobile/issues/759) against that event, not a Phase 3 transport record.
5. **Run the first real device gate** with a local-only `E2EE_SUPPORTED` flip.
6. **Merge the one-line `E2EE_SUPPORTED` PR last**, after the device evidence is recorded.

Do not start Phase 3. The record layer deserves a fresh session with the pairing path proven on hardware first — a handshake bug found while debugging a record layer is one bug wearing two costumes.

---

## Hard gates — do not pass these

**GATE 1 — pairing-time capability comes from the QR, not `/api/info`.**

`GET /api/info` is authenticated, and pairing is the operation that creates the credential. The streamer emits `spk`/`v` only when the exchange will accept E2EE. A valid `spk` makes the client send msg1; absent `spk` takes the byte-identical legacy path; malformed present `spk` is a hard error.

The client call site then:

- calls `beginPairHandshake` when the parsed QR carried a valid `spk`
- sends `e2ee: { v: 1, noise: base64(msg1) }` in the exchange body
- reads `e2ee` off the response and completes with `readMessage2`
- treats absent msg2 after sending msg1 as a hard failure, never a plaintext result
- handles `E2EE_HANDSHAKE_FAILED`, `E2EE_MALFORMED` and `E2EE_VERSION_UNSUPPORTED` distinctly; the version case is non-retryable with the same QR and never auto-falls back

**GATE 2 — load-or-create `D_priv`, and persist a new key BEFORE message 1.**

Not after. The server registers the device's public half before it can tell the client about it, so a client that discards its private half when a response fails leaves the server holding a key it can never use — a device row that looks correctly provisioned and fails in Phase 3, weeks from its cause.

Writing first is not enough if every attempt overwrites the saved value. A response-loss retry and a later re-pair load and reuse the same per-server key, so the server updates the same device row. A label-only edit preserves it. Explicitly forgetting or replacing the server identity clears the device key, server key, and pin together.

Use `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The default Keychain class syncs to iCloud and restores to a new device, which would make "revoke this lost phone" incomplete.

**GATE 3 — the old app must still pair, unchanged.**

A released tb-mobile build sends `{ token, clientPublicKey }` and nothing else, and cannot be force-updated. The server treats an absent `e2ee` field as an older client and never as malformed. A newly printed QR from a disabled or old server has no `spk` and takes today's plaintext path.

The sealed API-key fields and duplicated outer device fields are still returned on the encrypted path for released clients. A new client ignores them and uses the authenticated device credential from msg2.

**GATE 4 — authenticate everything the E2EE path stores or presents as verified.**

Msg1 authenticates `{ v, deviceName?, readOnly }`, and the server uses those values for the E2EE device row. Msg2 authenticates `{ v, deviceId, deviceToken, capabilities, publicUrl, machineName, serverVersion, e2eeRequired }`. The client validates the complete shape, requires `e2eeRequired === true`, and ignores the outer compatibility copies. An E2EE registration that cannot produce a device id and device token is a failed pairing, not best-effort success.

**GATE 5 — never fall back silently.**

A server that a device has pinned, or a server whose valid `spk` caused msg1 to be sent, answering as though it cannot encrypt is a hard, visible failure with no "connect anyway" affordance.

**GATE 6 — web never stores `D_priv`.**

The web SecureStore shim is localStorage. A pair URI with `spk` is refused with the native-app explanation and never falls back. Legacy no-`spk` pairing and the separately labelled manual API-key path remain available.

---

## Detail on each step

### 1. The client call site

The three refusal codes are distinct on purpose. `E2EE_VERSION_UNSUPPORTED` is visible and non-retryable with the same QR. “Deliberate fallback” means leaving the failed attempt and intentionally using a QR without `spk` or the manual API-key path; it never means an automatic plaintext retry of the same exchange.

`parsePairUri` must distinguish absent `spk` from present-invalid `spk`. The former selects the legacy path; the latter throws before `exchangeToken`. `v` is validated as part of the offered pairing format, not used as an independent reason to fall back.

### 2. The deep-link and paste confirmation gate

`app/pair.tsx` rebuilds a `threadbase://` URI from route params, so a tapped link in a message or an email reaches pairing with no camera and no out-of-band channel at all.

For the deep-link and paste paths **only** — never a camera scan — show the server's identity fingerprint and authenticated machine name and require an explicit confirm before the server is added. A camera scan is exempt because pointing a camera at a screen *is* the out-of-band channel; a tapped link has none and must borrow the user's attention instead.

#766 supplies the component and formatter but not the call-site wiring. Its machine-drafted Hebrew, Russian, and Arabic copy remains under #760 for human review.

### 3. Auto-set the pin

The control exists and a user can set it by hand. Set it automatically only after msg2 has been fully authenticated and validated. The server pins at that same pairing event; waiting for a Phase 3 sealed transport record would create a split state and make #759 impossible to finish in Phase 2.

Both routes write the same bit and produce the same hard failure. Clearing it stays a deliberate act with a plain-language confirmation naming what is lost.

### 4. Device gate and `E2EE_SUPPORTED`

`src/api/routes/misc.routes.ts`. One line, its own PR, nothing else in the diff. It is the moment the feature becomes reachable and it should be readable in ten seconds.

Use a local edit for the device gate. Merge the one-line PR only after the hardware evidence and export-compliance state are ready; the decision to test is not the decision to ship.

### 5. The device run

Flip the constant locally, dev build to a **cabled physical iPhone**, pair against a local streamer over the LAN.

Prefer the phone over the simulator for anything touching key storage: the simulator's Keychain is not the Secure Enclave, so `THIS_DEVICE_ONLY` and "revoke this lost phone" behave approximately rather than actually. For the protocol itself the simulator is fine.

On Android, **go over the tunnel**. Per [mobile#727](https://github.com/RonenMars/threadbase-mobile/issues/727) a release build cannot reach any `http://` address, and that failure looks exactly like an E2EE failure if you are not expecting it. Know which transport you are on before drawing any conclusion from a connection error.

What to actually verify on the device, beyond "it paired":

- the pin is set automatically, and survives an app restart
- a second pairing to the same server reuses the same device row rather than growing a second one
- backgrounding and returning does not break the session
- a disabled server prints a QR without `spk` and pairs through the legacy path
- malformed `spk`, wrong responder key, tampered msg2, and missing msg2 all fail visibly
- the deep-link and paste confirmation appears, while the camera path stays direct

---

## The wiring is what triggers export compliance — start the paperwork in parallel

Not the `E2EE_SUPPORTED` flip. `ITSAppUsesNonExemptEncryption` is about what the **app** contains, so flipping a server constant has no App Store consequence at all. Do not sequence the two together.

`@stablelib` is already in tb-mobile's `package.json`, but the obligation has not attached yet: outside tests nothing imports `services/e2ee/*`, so it is not reachable from Metro's entry graph and not in a shipped bundle. **The corrected mobile wiring in step 2 is precisely what changes that.**

The gate binds at **TestFlight**, not only App Review — and TestFlight distributes to internal testers long before a review sees a build. Apple's sequence is: determine requirements, submit documentation, *await approval*, then attach it to a build. That approval cannot be skipped, so it wants starting alongside the wiring rather than after it.

Details, including the self-classification path and what is still unresolved, are in [plan.md](./plan.md). Do not re-derive them; two items there are open questions for Ronen rather than tasks.

---

## Decisions already made — do not re-open

- **Re-pairing a revoked device is allowed**, and clears `revoked_at`. Ronen decided this on 2026-08-16. Re-pairing requires a live pair token minted on that machine, so it is an authorised act by the same person who revoked. This is recorded in `design.md` §4.4.
- **`@stablelib` is the client crypto library** (D-3, resolved by measurement on a Xiaomi 11 Lite).
- **The handshake is hand-written against the Noise specification** (D-1, flipped — no maintained implementation works in both Hermes and Node).
- **`rootKeyConfirm` does not exist.** The transcript hash already proves both sides derived the same keys.
- **Pairing-time capability is conditional `spk`/`v` in the QR**, not `/api/info`; after msg1, missing msg2 is a refusal.
- **`D_priv` is load-or-create and reused** across retries and re-pairs.
- **The new client trusts only the authenticated msg1/msg2 contract**, never outer compatibility copies.
- **The client auto-pin is written after fully validated msg2**, not after a Phase 3 record.
- **Web refuses E2EE pairing** rather than storing `D_priv` in localStorage.

## Decision still open — do not resolve it in code without asking

- **D-8 versus §6.5 at stage 2.** `THREADBASE_FEATURE_E2EE=0` is already a persistent off switch that D-8 forbids for `--no-e2ee`. Harmless while the flag defaults off; a real hole when it flips. Not due until Phase 5.

---

## Out of scope — do not drift into these

- Phase 3 (record layer), Phase 4 (REST envelope), Phase 5 (rollout stages and `--no-e2ee`)
- At-rest database encryption (TB-S-07) and per-project scoping (TB-S-05)
- Consolidating the protocol constants into a shared package ([streamer#619](https://github.com/RonenMars/threadbase-streamer/issues/619)) — deliberately not yet, because the independence of the two implementations is what makes the interop vectors mean anything

---

## Process

One PR per change per repo. Never commit to `main`. Work in dedicated worktrees outside the repo root — several belong to other sessions, so check `git worktree list` and `gh pr list` rather than assuming what is taken.

Run a real `npm ci` in each new worktree. Do not symlink `node_modules` from another checkout: it silently supplied a floated biome that invented format errors in untouched files and cost real time to diagnose.

Show Ronen the staged diff and the exact commit message and wait for **his** approval in your session before **every** commit. A relayed approval from another session is not approval. Conventional titles, no AI attribution, one sentence per line in GitHub text.

**Verification**

- tb-streamer: `npm run lint && npm test`, not parallelized, ~300 s.
- tb-mobile: `npx tsc --noEmit && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e`.

Capture output to a file and read the real exit code — `cmd | tail` reports tail's status. Before blaming your own change for a failure, check whether clean `main` fails the same way.

**Every new behaviour gets a test that has been seen red.** Break it deliberately, watch it fail, restore, watch it pass, and say you did. For crypto, assert properties rather than activity: a test that says "it encrypted something" passes on a broken implementation. The ones that carry weight are that a handshake against the wrong static key fails, that a tampered ciphertext is rejected, and that the pair token actually binds the handshake rather than being mixed in and ignored.

Watch for the assertion that cannot fail. A negative assertion inside a `catch` block cannot distinguish "failed correctly" from "never ran", and a spy with no positive control passes when it never fires.

## Stop and ask

- A gate cannot be satisfied without breaking an older client.
- The interop vectors stop matching between the two repos.
- A dilemma's working assumption looks wrong.
- You find a third credential path, or any place where the design and the code disagree about what exists today.
