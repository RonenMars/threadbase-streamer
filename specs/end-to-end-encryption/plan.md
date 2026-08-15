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

`Noise_IKpsk1_25519_ChaChaPoly_SHA256`. The QR gains the server's static public key; the pair token is mixed as PSK, so a handshake proves the client scanned *this* QR. Closes the window where nothing lets the client verify which server answered.

The QR format moves, and so does the pairing exchange, across two repos that cannot merge atomically. Rather than shipping them together, the **capability negotiation from Phase 5 is built first** — `GET /api/info` carries `e2ee`, the client attempts a handshake only when the server advertises one at a version it understands, and everything Phase 2 adds sits behind that. A half-landed state is then inert rather than broken, and the two repos can merge independently in any order. The cost is small and it is not extra work: Phase 5 requires this negotiation regardless.

**Phase 2 carries a cost the phase order did not budget for: there is no Noise library to adopt.** [D-1](./dilemmas.md#d-1--handshake-pattern-noise-ikpsk1-vs-alternatives) named its own flip condition — no maintained implementation that works in React Native *and* Node without a native module — and that condition holds as of 2026-08-15. `noise-protocol` and `noise-handshake` both depend on `sodium-universal` (native on Node, WASM in a browser), which Hermes cannot run. `@niomon/noise-js` is 8 downloads a week and was last published in 2022. `salty-crypto` is a single-author `1.0.0-rc` at ~50 downloads a week, which is not what belongs in a pre-auth code path. `@chainsafe/libp2p-noise` is genuinely pure JS but is a libp2p component — protobuf handshake payloads, peer-id semantics, no generic `IKpsk1` API.

So the handshake is written twice against the spec: Node `crypto` on the server, `@stablelib` on the client, with shared test vectors and a cross-implementation interop test proving the two agree on the transcript. This is D-1's own prescribed fallback rather than a departure from it, but it is the second non-engineering-free cost this feature carries after export compliance, and it is recorded here for the same reason.

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

**Confirmed 2026-08-15**, as this section asked. The conclusion holds and two of the consequences below were wrong; both are corrected in place.

What that pulls in, when Phase 2–4 ships rather than now:

- flipping the flag in `app.json`. **The boolean has no second record — but there is a second obligation, and it is an upload rather than an answer.**
  - *The boolean:* ASC reads it out of the uploaded binary and shows it as read-only build metadata (TestFlight → Builds → *build* → Build Metadata → "App Uses Non-Exempt Encryption", reading `No` on build 1.0 (203) today). There is nothing to keep in sync and no portal answer that can drift. The failure mode is deleting the key, not forgetting to mirror it — when the key is *absent*, ASC prompts per build and stores its own answer, which is the only way the two-records problem arises.
  - *The documentation:* **Distribution → App Information → App Encryption Documentation**, which takes a file upload, is app-level rather than per-build, and can be provided before a build is submitted. Apple's criterion there, verbatim: documentation is required if the app contains *"Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system."* That is exactly this design — standard algorithms, in addition to the OS's TLS — so the requirement is triggered by the second bullet rather than the first, which covers proprietary algorithms. The section is empty today and correctly so.
- **an annual self-classification report is required, and a CCATS review is not.** The earlier "potentially an annual report" can be firmed up, in our favour: because the algorithms are published standards (X25519, ChaCha20-Poly1305, Noise) rather than proprietary, the app self-classifies under License Exception ENC §740.17(b)(1). That path requires a report to BIS and the ENC Encryption Request Coordinator — `.csv` only, twelve fields per item — and explicitly excludes items for which a CCATS is issued. The two are alternatives; we are on the reporting side of the fork, which is the lighter one. The standard-versus-proprietary distinction does not change the plist boolean, only what follows it.
- the separate French declaration Apple prompts for

**The trigger has not fired yet, and this was checked rather than assumed.** The Noise client merged to tb-mobile `main` in #758, so the natural worry is that the obligation already attached. It has not: outside tests, nothing imports `services/e2ee/*`, so the module is not reachable from Metro's entry graph and is not in a shipped bundle. The trigger is still the pairing wiring, as written above. Worth re-checking at that point, because TestFlight distributes builds to internal testers long before a review sees one.

**The artifact is the French encryption declaration, and only that.** Apple's [reference page](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/) splits it three ways: encryption limited to the operating system needs nothing; **an industry-standard algorithm not provided by the OS needs the French declaration**; a proprietary algorithm needs a CCATS *and* the French declaration.

We are in the middle case. **No CCATS** — that is for proprietary algorithms, and every algorithm here is an IETF standard (X25519 RFC 7748, ChaCha20-Poly1305 RFC 8439, SHA-256, HMAC, HKDF). Noise not being an IETF standard does not move us into the proprietary bucket: the criterion is about *algorithms*, and the framework only composes standard ones.

The French declaration applies only when distributing in France, and this app does — France (EUR) is in its 175-region availability list, checked rather than inferred from the count.

The form is **"Déclaration et demande d'autorisation d'opérations relatives à un moyen de cryptologie"**, annexe 1, at `https://cyber.gouv.fr/documents/330/crypto_declaration-demande_autorisation_operations_annexe1_v2.pdf` (verified live, 2.3 MB). Note the annexe number: annexe 2 of décret 2007-663 is the classification criteria, not a form, and a widely-copied link to a `crypto_form_fourniture_prestation_annexe2` PDF is dead. Submission is email to `controle@ssi.gouv.fr` with subject `[formalités] <brand> – <product name>`, attaching the completed electronic form and a signed scan, or two copies by post. There is no online portal.

**The lead time is real, and it is Apple's rather than ANSSI's.** [Apple's overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance) gives the sequence as: determine requirements, submit documentation, **await approval**, then attach the approved documentation to a beta build or an app version build. Apple reviews the upload before any build can carry it, and that gate covers **TestFlight as well as App Review** — TestFlight is the earlier of the two, so it is the one that binds.

Two distinct gates are easy to conflate here. ANSSI's acknowledgement of the declaration may not be needed at all; Apple's approval of the uploaded document is separate, is stated in Apple's current text, and cannot be skipped. **Start this in parallel with the wiring, not after it.**

Apple also describes the French declaration as covering categories including "Secure Communications", which is what this is.

**Two things still open:**

- **Whether ANSSI's acknowledgement is required before uploading to Apple**, or whether the completed form suffices. Several write-ups say the latter, but the clearest source is from 2016 and is not in Apple's current text. Resolvable at no cost through App Store Connect's own questionnaire (the **+** beside App Encryption Documentation), which walks through the questions and names the forms it wants; it is more authoritative than any third party and commits to nothing.
- **The self-classification report deadline.** Believed to be 1 February covering the prior calendar year, but eCFR blocks automated access to §740.17(e)(3) and a compliance date should not be asserted from memory. Low risk to settle late — annual reporting, not a gate on shipping.

**Stated with its uncertainty:** this is read from Apple's and BIS's published guidance, not legal advice. The classification is unremarkable for a mass-market app using standard algorithms, but export control is an area where confident inference is worth less than a lawyer's ten minutes.

It is recorded here because it is the kind of obligation discovered when a release is already cut, and because it is the first cost of this feature that no amount of engineering removes.

## Not in this work

| Item | Why separate |
|---|---|
| At-rest database encryption (TB-S-07) | Independent workstream. `cache.db` holds verbatim conversation text and needs none of the handshake, record layer or pre-auth middleware above. |
| Per-project scoping (TB-S-05) | A product decision about what a scoped grant means, not a patch. The capability model has no project dimension anywhere. |
| Upload file contents ([D-4](./dilemmas.md#d-4--uploads-encrypt-the-file-or-only-the-record-of-it)) | They live inside the user's own repository so the agent can open them, and the streamer does not mediate the agent's file reads. |
