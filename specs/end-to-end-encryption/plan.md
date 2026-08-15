# End-to-end encryption — implementation plan

**Date:** 2026-08-14
**Status:** Approved for implementation.
**Tracked in:** [threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590) (server half) · [threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698) (client half)
**Design:** [design.md](./design.md) · [mobile-design.md](./mobile-design.md) · **Parked decisions:** [dilemmas.md](./dilemmas.md) · **Review:** [../../docs/security/2026-08-14-streamer-review.md](../../docs/security/2026-08-14-streamer-review.md)

GitHub is the worklist. This file is the phase order and the reasoning behind it; the issues carry status.

---

## Goal

Traffic between tb-mobile and tb-streamer is encrypted **to the streamer**, so the Cloudflare tunnel in the middle carries ciphertext rather than plaintext ([context.md §2.1](./context.md)).

## Phase order

### Phase 0 — `authedFetch` in tb-mobile. Blocks everything else.

There is no module in tb-mobile for "an authenticated request to a streamer". The #684 credential change needed eight edits across five files, and `lib/clientLog.ts` needed a bespoke variant because it reaches the credential through a differently-shaped object.

The design specifies per-request `X-TB-Ctx` / `X-TB-Seq` headers and a sealed body, and assumes one place where requests are constructed. That place does not exist, so "one place changes" becomes eight — each independently responsible for sequencing and replay-window handling. Build the one place first.

### Phase 1 — Measure before choosing the crypto library ([D-3](./dilemmas.md#d-3--mobile-crypto-library-pure-js-vs-native-module))

The working assumption is `@stablelib/*`. D-3 names it the assumption most likely to be overturned, and by measurement rather than argument: seal/unseal throughput on `terminal_output`-sized chunks at realistic PTY rates, on a mid-range Android device, with the JS thread already rendering the terminal.

One measurement decides the library for both repos. Take it before writing protocol code.

### Phase 2 — Handshake and pairing ([design §2.4](./design.md), [§2.6](./design.md))

`Noise_IKpsk1_25519_ChaChaPoly_SHA256`. The QR gains the server's static public key; the pair token is mixed as PSK, so a handshake proves the client scanned *this* QR. Closes the window where nothing lets the client verify which server answered. The QR format moves, so streamer and mobile ship together.

### Phase 3 — Record layer, WebSocket first ([design §3.3](./design.md), [§4.3](./design.md))

ChaCha20-Poly1305, 96-bit nonce as `direction(4) || counter(8)`, never random — reuse is then a violated invariant a test can assert on rather than a probability argued about in review. The counter surviving a rekey is the rule to test hardest.

### Phase 4 — REST envelope and unseal middleware ([design §3.6](./design.md), [D-9](./dilemmas.md#d-9--where-e2ee-sits-relative-to-the-auth-middleware))

Unseal runs **before** `authMiddleware` so the credential itself travels sealed. That puts parsing in front of authentication, which is where parsing bugs become unauthenticated vulnerabilities. Non-negotiable: unknown `ctxId` rejected before any allocation, body size bounded before decryption, never allocate proportional to an attacker-supplied length field.

Paths and query parameters stay plaintext ([D-7](./dilemmas.md#d-7--rest-paths-stay-plaintext)); bodies and responses are sealed.

### Phase 5 — Rollout, negotiated rather than forced

**This is the compatibility risk in the whole build.** tb-mobile is released and cannot be force-updated, so a server that *demands* an encrypted handshake breaks every older install the day its streamer updates.

- The server advertises capability additively on `GET /api/info`.
- The client encrypts when both sides support it and falls back to plaintext otherwise.
- `--no-e2ee` is a `serve` flag only — no `server.yaml` key, no env var ([D-8](./dilemmas.md#d-8---no-e2ee-has-no-serveryaml-key-and-no-env-var)) — so disabling encryption is a deliberate act at every boot.
- Only once old versions have drained does the server refuse plaintext.

"Always encrypted" is the destination, not the first commit.

---

## App Store export compliance — the first non-engineering cost

`tb-mobile/app.json` declares `ITSAppUsesNonExemptEncryption: false`. That is the correct answer **today**, because the app's only cryptography is the platform's own TLS, which Apple exempts.

**E2EE almost certainly makes it `true.`** The design has the client implementing its own cryptography — a Noise handshake, X25519, ChaCha20-Poly1305, through `@stablelib` or a native module ([D-3](./dilemmas.md#d-3--mobile-crypto-library-pure-js-vs-native-module)). That is not the OS's TLS, and it is not one of the narrow exemptions Apple lists (authentication only, DRM, copy protection). It protects user data with the app's own crypto, which is the case the declaration exists for.

What that pulls in, when Phase 2–4 ships rather than now:

- flipping the flag in `app.json`, which changes what App Store Connect asks at every submission thereafter
- **updating the declaration in App Store Connect itself, for both TestFlight and the App Store.** The plist key and the portal answer are two separate records of the same fact, and changing one does not change the other. A build whose plist says `true` while the portal still carries the old answer is the failure mode — TestFlight is where it bites first, because internal testers get builds long before a review sees one, and export compliance is asked per build there.
- an export self-classification under the mass-market provisions, and potentially an annual report
- the separate French declaration Apple prompts for

**Stated with its uncertainty:** this is read from Apple's published guidance, not legal advice, and export control is an area where confident inference is worth less than checking. Confirm before Phase 2 ships rather than at submission time.

It is recorded here because it is the kind of obligation discovered when a release is already cut, and because it is the first cost of this feature that no amount of engineering removes.

## Not in this work

| Item | Why separate |
|---|---|
| At-rest database encryption (TB-S-07) | Independent workstream. `cache.db` holds verbatim conversation text and needs none of the handshake, record layer or pre-auth middleware above. |
| Per-project scoping (TB-S-05) | A product decision about what a scoped grant means, not a patch. The capability model has no project dimension anywhere. |
| Upload file contents ([D-4](./dilemmas.md#d-4--uploads-encrypt-the-file-or-only-the-record-of-it)) | They live inside the user's own repository so the agent can open them, and the streamer does not mediate the agent's file reads. |
