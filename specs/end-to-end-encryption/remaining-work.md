# E2EE — what is left

**Verified against both `main` branches on 2026-08-16.** Tracked in [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) and [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698); phase order and rationale live in [plan.md](./plan.md).

GitHub is the worklist. This file is a map of the remaining shape — it will go stale, and the issues will not.

---

## The one-line summary

The cryptographic primitives exist, but the cross-repository pairing contract is not ready to ship. Streamer #630 and mobile #766 are green; streamer #631 is merged; mobile #768 remains draft because review found security and durability defects that its green tests do not cover.

---

## Phase 2 — finishing it

### 1. Finish the streamer producer contract

- rebase and merge [streamer#630](https://github.com/RonenMars/threadbase-streamer/pull/630), which stops a disabled build from performing and pinning a requested handshake
- make newly printed QRs omit `spk`/`v` while that same capability is disabled
- authenticate `{ v, deviceName?, readOnly }` in msg1 and use it for the E2EE device row
- authenticate `{ v, deviceId, deviceToken, capabilities, publicUrl, machineName, serverVersion, e2eeRequired }` in msg2
- make E2EE device registration mandatory for success while preserving old-client response fields

### 2. Repair mobile #768 — **the blocker**

- distinguish absent `spk` from present-invalid `spk` in every real entry path
- gate pairing on valid `spk`, never pre-pair `/api/info`; after msg1, missing msg2 is a hard failure
- load-or-create the per-server `D_priv`, write a new one before msg1, and reuse it on retry and re-pair
- validate the complete authenticated msg2 and ignore outer compatibility credentials and metadata
- preserve device key, server key, and pin on label-only edits; clear them coherently only on explicit identity replacement
- refuse E2EE pairing on web instead of writing `D_priv` to localStorage
- close the persisted-server read coverage gap and remove new standards violations

### 3. The deep-link and paste confirmation gate

[mobile-design.md §3.3](./mobile-design.md). A `threadbase://pair?...` link in a message or an email reaches pairing with no camera involved, so there is no out-of-band channel and nothing the user has physically looked at. For those two paths only — never a camera scan — show the server's identity fingerprint and machine name and require an explicit confirm before the server is added.

[#766](https://github.com/RonenMars/threadbase-mobile/pull/766) supplies the component and formatter but is not wired. Merge it after #768's result contract stabilises, then add a focused wiring pass. The displayed machine name comes from authenticated msg2; the camera path stays ungated.

### 4. Auto-set the require-encryption pin — [mobile#759](https://github.com/RonenMars/threadbase-mobile/issues/759)

The control exists (`components/servers/ServerEncryptionSection.tsx`) and the user can set it by hand. Auto-set it after msg2 is fully authenticated and validated—the same pairing event at which the server pins. Do not wait for a Phase 3 sealed transport record.

### 5. The first real device test, then the go-live flip

Once 1–4 are done: flip the constant locally, dev build to a **cabled physical iPhone**, and pair against a local streamer. Prefer the phone over the simulator for anything touching key storage — the simulator's Keychain is not the Secure Enclave, so `THIS_DEVICE_ONLY` and "revoke this lost phone" behave approximately rather than actually.

On Android, go over the tunnel. Per [mobile#727](https://github.com/RonenMars/threadbase-mobile/issues/727) a release build cannot reach any `http://` address, and that failure looks exactly like an E2EE failure if you are not expecting it.

After the device evidence is recorded, `E2EE_SUPPORTED` flips in its own one-line PR and merges last. It is not needed to test; a local edit is enough.

---

## Phase 3 — the record layer

Nothing built. WebSocket first, because it is the highest-volume channel and a single ordered connection, which makes the rules simpler there than anywhere else.

- ChaCha20-Poly1305 with a nonce of `direction(4) || counter(8)`, **never random** — so nonce reuse becomes an invariant a test asserts on rather than a probability argued about
- strict monotonic counters on the socket, no window: a repeat, a gap or a reorder is a protocol violation, not a network event
- the counter surviving a rekey is the single rule to test hardest
- sends that currently bypass `WSHub` must be routed through it first — that refactor is a prerequisite, not part of the encryption
- **done means** terminal output, replay, conversation events and user messages are ciphertext on the wire, and a nonce-reuse test exists and has been seen red

Worth carrying in: the D-3 throughput budget is ~1.6 MB/s of seal+unseal in Hermes on a mid-range Android, measured. Read it as throughput, never as operations per second.

---

## Phase 4 — REST envelope and unseal middleware

Nothing built. The unseal step runs **before** `authMiddleware`, so the credential itself travels sealed — which deliberately puts parsing in front of authentication, where parsing bugs become unauthenticated vulnerabilities.

Three non-negotiables from D-9, already applied once in `parseE2eeRequest` and needed again at larger scale:

- reject an unknown `ctxId` before any allocation
- bound body size before decryption
- never allocate in proportion to an attacker-supplied length field

Paths and query parameters stay plaintext (D-7). Bodies and responses are sealed. Per-request `X-TB-Ctx` / `X-TB-Seq` go through `authedFetch` on the client — one place, which is why Phase 0 came first. **Key the crypto context off a stable server id, never off the target object**: `AuthedTarget` is structural and has no identity, so two identical literals would silently produce two sequence counters where one is required.

REST needs a sliding window rather than a strict counter, because React Query issues concurrent requests and a strict counter would reject perfectly legitimate out-of-order arrivals.

---

## Phase 5 — negotiated rollout

Nothing built. This is the compatibility risk in the whole design: released apps cannot be force-updated, so a server that *demands* encryption breaks every older install the day its streamer updates.

- `--no-e2ee` as a `serve` flag only — no `server.yaml` key, no env var (D-8), so disabling encryption is a deliberate act at every boot
- a prominent boot warning naming how many pinned devices will now be refused
- stage 1 (opt-in) → stage 2 (default on) → stage 3 (refuse plaintext), where **stage 3 is a product decision with a known app-version floor, never a date**
- rollback at any stage is an outage for pinned devices, by design — a visible failure beats a silent downgrade, and that is worth knowing before stage 2 rather than during an incident

---

## Decision register

| | |
|---|---|
| ~~**Degrade-path divergence**~~ | **Resolved by contract 2026-08-16.** Persist-before-send alone was insufficient: mobile must load-or-create and reuse `D_priv`, and once msg1 is sent an absent msg2 is a failed pairing rather than plaintext success. |
| ~~**Re-pairing a revoked device**~~ | **Decided 2026-08-16 (Ronen): allowed.** Revocation does not block a re-pair, and `revoked_at` is cleared by it. Re-pairing requires a live pair token minted on that machine, so it is an authorised act by the same person who revoked. Recorded in design.md §4.4. |
| **D-8 vs §6.5 at stage 2** | Every feature flag carries a `THREADBASE_FEATURE_*` variable by construction, so `THREADBASE_FEATURE_E2EE=0` is already the persistent off switch D-8 forbids for `--no-e2ee`. Harmless while the default is off; real when it flips. |

## Related work, not on the critical path

- [streamer#619](https://github.com/RonenMars/threadbase-streamer/issues/619) — consolidate the protocol constants into a shared package, *once both implementations are proven*. Deliberately not yet: the independence is what makes the interop vectors mean anything.
- [streamer#604](https://github.com/RonenMars/threadbase-streamer/issues/604) — the pairing QR advertises the first network interface, not necessarily the reachable one.
- [mobile#760](https://github.com/RonenMars/threadbase-mobile/issues/760) — human review of the Hebrew, Russian and Arabic encryption copy.
- `pair-endpoints.test.ts` still uses a probe-then-bind port helper that races. It will look flakier as the suite grows.
- At-rest database encryption (TB-S-07) and per-project scoping (TB-S-05) are explicitly **not** part of this work.

## Obligations that are not code

**Export compliance.** Confirmed in [streamer#625](https://github.com/RonenMars/threadbase-streamer/pull/625). `ITSAppUsesNonExemptEncryption` becomes `true` when the client wiring enters Metro's shipped graph; App Store Connect's encryption documentation is a separate upload and approval gate. TestFlight binds first. Start it alongside the corrected wiring, not alongside the server flip.
