# Dilemmas — end-to-end-encryption

Decisions parked for later. Each entry has options and a working assumption.

Everything here is a decision [understanding.md](./understanding.md) left open.
Each entry names the working assumption the design proceeds on, the alternatives, and what evidence would flip it.
Nothing here is a requirement — the requirements are in `understanding.md`.

---

## D-1 — Handshake pattern: Noise `IKpsk1` vs. alternatives

**Where:** [design.md §2.4](./design.md#24-handshake-noise-ik-over-the-pair-token-assumption)

**Working assumption:** `Noise_IKpsk1_25519_ChaChaPoly_SHA256`. The QR carries the server's static public key (`spk`), so the initiator knows the responder up front — the exact situation `IK` is specified for — and the pair token is mixed as a PSK so a handshake proves the initiator scanned *this* QR.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **`Noise_XX`** | Neither side needs prior knowledge; gives the responder forward secrecy against a static-key compromise. | Loses the entire QR-based server authentication — the client would have to trust-on-first-use, which is precisely the MITM window §2.6 closes. Also three messages instead of two. |
| **A PAKE (SPAKE2, OPAQUE) over the pair token** | Turns the low-entropy-ish token into a mutually authenticated key with no server key in the QR; QR stays short. | The pair token is 128 bits of randomness, not a human password, so the PAKE's main advantage does not apply. Adds a primitive neither side has, with fewer reviewed JS implementations than Noise. |
| **Hand-rolled X25519 → HKDF** | No library; smallest diff. | We would be choosing the key-mixing order, the transcript binding, and the identity-hiding properties ourselves. That is the part of a protocol that is easy to get subtly wrong and impossible to test for. |
| **TLS with a pinned self-signed cert** | Reuses a mature stack. | The streamer serves plain HTTP and the ingress terminates TLS at Cloudflare (`docs/guides/remote-access/cloudflare.md:109-113`) — an inner TLS would need a second, tunnelled connection. Also does not encrypt anything at rest, and does not survive the `ws://` LAN case cleanly. |

**What would flip it:** no maintained Noise implementation that works in React Native *and* Node without a native module. Then the fallback is a hand-rolled `IK`-shaped exchange, written against the Noise spec and reviewed as such — not an ad-hoc design.

---

## D-2 — AEAD and nonce discipline: counter ChaCha20-Poly1305 vs. random-nonce XChaCha20

**Where:** [design.md §3.3](./design.md#33-aead-nonces-and-the-record-layer-assumption)

**Working assumption:** ChaCha20-Poly1305 (RFC 8439), 96-bit nonce built as `direction(4) || counter(8)`, never random.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **XChaCha20-Poly1305, random 192-bit nonce** | No counter state to synchronise; reuse is statistically improbable rather than logically prevented. Already the shape `tweetnacl.secretbox` uses, so the mobile side keeps one dependency. | `secretbox` has **no AAD input**, so it cannot bind the plaintext header the envelope needs. Not in Node's OpenSSL binding, so the server gains a dependency it currently does not need. "Improbable" is a weaker property than "assertable". |
| **AES-256-GCM** | Hardware-accelerated on the server; in Node's core. | No reliable hardware AES path from JS on the client; software AES-GCM is slower and more timing-sensitive than ChaCha20. GCM's nonce-reuse failure is catastrophic (authentication key recovery), which is a worse failure mode for the same mistake. |
| **Random 96-bit nonce with ChaCha20-Poly1305** | No counter state. | 96 bits is too short for random nonces at stream volumes — the birthday bound is reachable on a busy terminal session. Rejected outright. |

**Why the counter wins:** reuse becomes a violated invariant you can assert on in a test, rather than a probability you argue about in a design review. The cost is that the counter must survive rekeys correctly, which is one clearly-testable rule (design.md §4.3).

**What would flip it:** a measurement showing the strict-ordering requirement on the WebSocket causes spurious disconnects in the field. That would mean the ordered-and-gap-free assumption about a single TCP connection is wrong somewhere in the RN WebSocket stack, and the answer would be a window on both channels rather than a random nonce.

---

## D-3 — Mobile crypto library: pure JS vs. native module

**Where:** [mobile-design.md §2](./mobile-design.md#2-cryptographic-dependency)

**Working assumption:** `@stablelib/*` — pure TypeScript, no native module, works on iOS, Android, and the `web` target with one code path.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **`react-native-quick-crypto` / `react-native-libsodium`** | Native speed, which matters exactly once — on the terminal-output stream. | No web implementation, so the `web` target needs a `.web.ts` shim anyway. Triggers `pod install`, a `Podfile.lock` change, and the four path-dependent checksums the repo maintains a script for (`tb-mobile/CLAUDE.md`, "Native Dependencies After Package Changes"). New native surface in a released app. |
| **Expo's `expo-crypto`** | Already in the Expo ecosystem. | Digest and random only — no AEAD, no X25519. Does not cover the requirement. |
| **`tweetnacl` alone** | Already a dependency, on both sides. | `secretbox` has no AAD, so it cannot bind the envelope header. Would force the header fields inside the ciphertext and leave the plaintext copy unauthenticated. |

**This is the assumption most likely to be overturned, and by evidence rather than argument.**
The measurement that decides it: seal/unseal throughput for `terminal_output`-sized chunks at realistic PTY rates, on a mid-range Android device, with the JS thread already doing terminal rendering. If pure JS cannot keep up, the decision flips to a native module and the `web` target gets a documented reduced-capability path.

---

## D-4 — Uploads: encrypt the file, or only the record of it

**Where:** [design.md §5.4](./design.md#54-the-rest-of-the-at-rest-surface)

**Working assumption:** leave upload file contents unencrypted on disk; encrypt only the streamer's database record of them.

**The conflict:** uploads are written to `<projectPath>/.threadbase-uploads/<sessionId>/` (`src/uploads.ts:60`) — inside the user's own repository — precisely so the agent can open them. Encrypting them there makes them unreadable to the thing they exist for.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **Encrypt at rest, decrypt to a temp file on agent access** | Real at-rest protection. | The streamer does not mediate the agent's file reads — the agent opens the path itself. There is no hook to decrypt at. Would require moving uploads out of the project tree and changing how they are referenced to the agent, which is a product change, not a security change. |
| **Move uploads under `~/.threadbase/uploads/` encrypted, pass a decrypted temp path to the agent** | Keeps the project tree clean; encrypts the durable copy. | The temp file is plaintext for the session's duration, so the win is partial. Changes the path the agent sees, which changes what the user sees in the conversation. |
| **Leave as-is (working assumption)** | Zero disruption. Honest: these are the user's own files, in the user's own repo, which is already unencrypted. | An upload is often a screenshot of something sensitive, and users may not expect it to persist in their working tree at all. |

**Worth surfacing to the user regardless of the outcome:** nothing today cleans `.threadbase-uploads/` up, and it is inside a git working tree. Whether it should be gitignored, retention-bounded, or both is a product question this design does not answer.

---

## D-5 — AsyncStorage on the phone: encrypt it, or reduce what it holds

**Where:** [mobile-design.md §5.2](./mobile-design.md#52-becomes)

**Working assumption:** reduce what it holds — invert `shouldPersistQuery` from opt-out to opt-in (`tb-mobile/services/query-client.ts:213-218`) and bump `persistBuster` — rather than encrypting AsyncStorage wholesale.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **Encrypted persister shim under React Query** | Covers whatever is persisted, now and later. | A key in SecureStore, a migration, and a crypto call on every persist throttle tick (1 s, `query-client.ts:189`). Protects titles and previews — after the inversion, bodies are already excluded. |
| **Drop persistence entirely** | Nothing at rest. | The persisted cache is why the app renders instantly on cold start. A real product regression for a small security gain. |
| **Reduce (working assumption)** | Smallest diff; makes the code match the comment that already claims bodies are not persisted (`query-client.ts:206-207`). | Titles and previews still land in AsyncStorage in the clear. |

**The honest framing:** on a phone with a passcode, iOS and Android already encrypt app data at rest. This is protection against a jailbroken or rooted device — which SecureStore also does not fully survive. Spending a migration on it should follow a decision that the threat is real for this product, not precede it.

---

## D-6 — Where the at-rest database key lives

**Where:** [design.md §5.3](./design.md#53-where-the-database-key-lives)

**Working assumption:** a 32-byte key file at `~/.threadbase/keys/db.key`, mode `0600`, written tmp-then-rename — the discipline `setConfigValue` already uses (`src/auth.ts:169-173`). OS keystore is a later, optional backend.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **macOS Keychain / Windows DPAPI / libsecret now** | Protects against another *user* on the machine; the conventional answer. | The streamer must read it unattended at launchd/Task-Scheduler boot with no prompt, which means an ACL-granted item any code running as that user can also read. Three platform implementations, each with its own failure modes, for a small delta in the unattended case. |
| **Operator passphrase at boot** | Genuinely protects a stolen disk. | Kills unattended start, which is the entire deployment model (launchd, systemd, Task Scheduler). Non-starter. |
| **Derive from a machine identifier** | No key file to steal. | Machine ids are not secret. Security theatre. |
| **Key file (working assumption)** | One implementation, works everywhere, correct for the realistic loss path (a copied file / a backup). | Anything running as the streamer user reads it. Does not protect a stolen laptop without full-disk encryption. |

**Stated in the design rather than hidden:** this defends against a stolen *file*, not a stolen *machine*. Full-disk encryption is the control for the latter and the docs should say so.

---

## D-7 — REST paths stay plaintext

**Where:** [design.md §3.2](./design.md#32-what-is-encrypted-and-what-is-not)

**Working assumption:** encrypt bodies and responses; leave method, path, and query parameters in the clear.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **Tunnel everything through one opaque `POST /api/e2ee/rpc`** | Hides which endpoint, which session id, and which pagination position. | Abandons the hard-coded path contract every mobile build depends on (`docs/compatibility/tb-mobile.md:9-18`) and requires a second router inside the handler. Breaks every proxy rule, access log, and trace. Two routing tables is two places for an authorization check to be forgotten. |
| **Encrypt only the session id inside paths** | Narrower leak. | Session ids are also conversation ids and deep-link targets (`docs/compatibility/tb-mobile.md:40`), so opaquing them in the URL ripples into routing, caching, and ETags for a partial win. |
| **Plaintext paths (working assumption)** | Zero contract change; one router; the existing `summarizeQuery` log protection keeps working (`src/api/app.ts:53-57`). | An observer at the ingress learns which endpoints are called, how often, with what pagination, and how large each response is. |

**What would flip it:** a threat model where traffic analysis is the actual concern — e.g. an ingress operator inferring which projects are active and when. That is a different product than the one `understanding.md` describes, and it would want padding and cover traffic too, not just opaque paths.

---

## D-8 — `--no-e2ee` has no `server.yaml` key and no env var

**Where:** [design.md §6.4](./design.md#64---no-e2ee)

**Working assumption:** a `serve` flag only. No `server.yaml` key, no `THREADBASE_*` variable.

**Reasoning:** it is the inverse of `auto_resume_on_boot`, which is *persisted* precisely so the user is asked once and never again (`src/auth.ts:196-212`). Turning off transport encryption should require a deliberate act at every boot. An operator who genuinely wants it permanently edits their launchd plist or Task Scheduler action — a visible, auditable change.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **`server.yaml` key** | Matches `default_permission_mode`, `pty_grace_period_ms`, `browser_cors`. Survives restarts without editing a plist. | Set once and forgotten, and `server.yaml` is hand-editable, so a stray line silently disables encryption for the machine's lifetime. |
| **`THREADBASE_FEATURE_E2EE=0`** | Matches the documented escape hatch for supervised instances whose argv is fixed. | Same objection, plus env vars are the least visible of the three. |
| **Flag only (working assumption)** | Highest friction for the most dangerous setting. Consistent with the flag being reported to clients as a *reason*, not a silent state. | A supervised instance genuinely cannot pass it without editing the service definition — which is the point, but is also a real operator cost. |

**Open, and worth asking the team:** if a supervised prod instance needs to disable E2EE without a plist edit, the env-var escape hatch has to exist and this decision flips. The prod-instance escape hatch is documented as the standard pattern for exactly this situation (`CLAUDE.md`, Feature flags).

---

## D-9 — Where E2EE sits relative to the auth middleware

**Where:** [design.md §3.6](./design.md#36-where-the-code-changes)

**Working assumption:** an unseal middleware runs **before** `authMiddleware` in the `app.use("*")` chain (`src/api/app.ts:120-121`), unwraps the body, and lets the existing middleware authenticate from the (now decrypted) credential.

**Alternatives:**

| Option | For | Against |
|---|---|---|
| **Unseal after auth** | Auth stays first, which reads as safer ordering. | The credential would have to remain outside the envelope, so a pinned device still presents a bearer token in the clear on every request — the leak the design set out to close. |
| **Unseal inside each route** | No middleware ordering to reason about. | Seventeen route files (`src/api/routes/`), each a place to forget. Exactly the fail-open shape the capability table avoids by being one table. |
| **Before auth (working assumption)** | One place; the credential travels sealed. | The unseal middleware itself becomes pre-auth attack surface and must be hostile-input-hardened: it parses attacker-controlled headers and ciphertext before anything has authenticated the caller. |

**The risk this creates, stated so it is designed for rather than discovered:** pre-auth code paths are where parsing bugs become unauthenticated vulnerabilities. The unseal middleware must do the cheapest possible rejection first (unknown `ctxId` → reject before any allocation), bound the body size before decryption, and never allocate proportional to an attacker-supplied length field.
