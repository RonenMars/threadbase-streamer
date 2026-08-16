# The E2EE mechanisms, in plain English

**Companion to** [design.md](./design.md), which is the authoritative version. This file explains what each moving part *is* and *why it exists*, in ordinary language, for a reader who does not want to hold a protocol in their head.

It describes the mechanisms, not their delivery status. Git and the linked PRs are the record of when each arrived.

---

## Capability negotiation at pairing and after it

**What it is.** Pairing has no credential yet, so it cannot call the authenticated `GET /api/info`. The pairing-time signal is the QR itself: the streamer includes `spk` and `v` only while its exchange will accept the handshake. After pairing, `/api/info` carries the richer `e2ee` object: whether the build supports encryption, whether it is switched on, which version it speaks, and whether it is required.

**Why there are two signals.** The streamer and the app live in two repositories that cannot merge at the same instant. A QR without `spk` takes the old pairing path byte for byte, so either half can exist without activating the other. A QR with a valid `spk` is a promise that this particular exchange accepts E2EE; once the phone sends msg1, silence or a missing msg2 is a failure rather than permission to reinterpret the attempt as plaintext.

**What "inert" means.** The build constant is still `false`, so newly printed QRs must omit `spk`/`v`, the exchange refuses to perform a requested handshake, and `/api/info` reports disabled. Everything remains behind the same closed door on all three surfaces.

**The consequence worth knowing.** Flipping that one constant is what makes the whole feature reachable. It is deliberately kept as its own tiny change, so the moment encryption goes live is a diff someone can read in ten seconds rather than a line buried in a large one.

---

## The IKpsk1 handshake, and byte-matched interop vectors

**What it is.** A short, standard conversation between the phone and the streamer that ends with both sides holding the same secret keys. `Noise_IKpsk1_25519_ChaChaPoly_SHA256` is the name of the recipe. It is two messages: the phone speaks, the streamer answers.

**What it actually buys.** Two things that did not exist before.

The phone learns *which* streamer answered. The pairing QR carries the streamer's public key, so the phone starts the conversation already knowing who it expects. Anyone else can intercept the traffic and answer, but they cannot produce a reply that decrypts, because they do not hold the matching private key. Before this, the phone accepted whatever answered.

And the streamer learns the phone genuinely scanned *that* QR. The pairing token is mixed into the maths of the handshake, so completing it proves the phone had the code — not merely that it reached the right address.

The encrypted payloads bind the product result as well as the mathematics. The phone authenticates its requested device name and access level in msg1. The streamer authenticates the device id, device token, capabilities, machine name, advertised URL, version, and downgrade pin in msg2. The outer legacy response remains for old apps, but a new app neither trusts nor stores it.

**Why it is hand-written, which is normally the wrong answer.** No maintained library implements this recipe in both places we need it: the phone's JavaScript engine and the server's Node. The design anticipated that and said what to do if it happened — follow the published specification exactly rather than inventing something.

**What the vectors are, and why they matter more than they sound.** "Vectors" here means a small file of known inputs and their exact expected outputs, committed to both repositories.

The handshake is written twice — once for the server, once for the phone, on different runtimes with different crypto libraries. Two separate readings of one specification can diverge, so the implementations were written independently, by people who could not see each other's code, and then checked against the same file.

**They match on every byte** — both messages, the transcript hash, both traffic keys. That is strong evidence that the two repositories interoperate on the committed fixture.

**The honest limit.** Matching bytes proves the two agree on that fixture. It does not independently prove that the fixture conforms to the Noise specification, rule out a shared misreading, or prove either implementation's surrounding product logic. The vectors are a strong compatibility check, not a general warrant.

---

## The device migration

**What it is.** Three new columns on the paired-devices table: the device's cryptographic identity key, whether that device is pinned to encryption, and which protocol version it agreed.

**Why it changes what a "device" is.** Until now a paired device was whoever held a secret string. Present the string, you are that device. Now a device can be identified by a key it *proved* it holds during the handshake — which cannot be copied out of a backup or read off a screen.

**The pin, and why it only moves one way.** Once a device has paired with encryption, its row records that encryption is required. Nothing the phone sends can clear it. That is what stops the cheapest attack on the whole design: an intermediary pretending to be an older, unencrypted server so the phone quietly drops back to plaintext. A pinned device refuses instead of downgrading.

The phone records the same pin only after it has authenticated and validated msg2. Its private device key is load-or-create and survives response-loss retries and later re-pairing, so the unique public key updates the same row rather than growing a ghost row each time.

**Which database, and why that is not a detail.** These columns live in `runtime.db`, not the conversation cache. The cache is disposable by design — a documented troubleshooting step deletes it, and it rebuilds itself from the agent's own files. A pinned key rebuilds from nothing. Putting them in the cache would mean a routine "clear the cache" silently stripped every device's encryption while leaving the device still able to log in: still working, quietly unencrypted, with nothing anywhere reporting a problem. The design originally named the wrong file, because the table moved after it was written.

---

## The token-consume ordering

**What it is.** A pairing code is single-use and lives 180 seconds. The change was moving the moment it gets used up: it is now spent when the pairing *succeeds*, not when it is *attempted*.

**What went wrong before.** The code was marked used almost immediately, before anything had checked the rest of the request. So a phone that sent something malformed burned the code and got an error — and its retry was told "this code was already used."

**Why that mattered beyond annoyance.** "Already used" is a designated warning sign. It is what the user sees if someone photographed their pairing QR and paired first. A warning that also fires for ordinary client mistakes is a warning nobody believes, and it was being spent on a routine error.

**Why it matters more now.** The handshake runs inside the same request. Every way a handshake can fail is another way to burn a code that was never actually replayed — and it would hand anyone who photographed a QR a way to break the real phone's pairing without gaining anything themselves.

**The rule underneath it.** Check the code, do the work, and only then spend it. Nothing between the check and the spend may pause, because a pause is what would let two requests slip through with the same code. A test proves nothing pauses, rather than a comment asking politely.

---

## The replay signal

**What it is.** When someone presents a pairing code that has already been used, the streamer now writes a warning to its log: a code was replayed, check your paired devices and revoke anything you do not recognise.

**Why it was needed.** That situation was already detected — the phone got an error. But the error went only to the phone, and the person who can actually do something about it is whoever runs the streamer. They saw nothing at all. The signal existed and was invisible to the only audience that could act on it.

**Why the wording matters.** It names the action, not just the event. "A code was replayed" tells someone that something happened; telling them where to look and what to revoke tells them what to do about it.

**What it deliberately does not do.** It stays quiet for a code that is simply unknown or expired — those are an ordinary typo or someone taking too long, and warning about them would bury the one line that means a device may have been paired without you knowing. It never writes the code itself into the log, because a code is still usable until it expires. And it is not rate-limited: a throttle would make a repeated attack go quiet, and a quiet log is indistinguishable from an attack that stopped.
