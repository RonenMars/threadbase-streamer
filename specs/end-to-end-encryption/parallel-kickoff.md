# E2EE — finish Phase 2, coordinated across two repositories

You are coordinating the last of Phase 2 across two repositories. The streamer is `~/dev/ai-tools/tb-streamer`; the client work is in `~/dev/ai-tools/tb-mobile`.

Tracked in **[threadbase-streamer#590](https://github.com/RonenMars/threadbase-streamer/issues/590)** and **[threadbase-mobile#698](https://github.com/RonenMars/threadbase-mobile/issues/698)**.

## Read first — and note where these live

The orientation documents:

```
~/dev/ai-tools/tb-streamer-worktrees/e2ee-plain-english/specs/end-to-end-encryption/
  remaining-work.md              ← start here: what is built, what is not, verified 2026-08-16
  next-session-prompt.md         ← the full brief for this work, gates included
  mechanisms-in-plain-english.md ← what each landed piece does, if you want orientation first
```

`next-session-prompt.md` is the authoritative brief. **Read it before dispatching anyone.** This document only adds how to split the work.

The design itself is on `main` in `specs/end-to-end-encryption/` — `plan.md`, `design.md`, `mobile-design.md`, `dilemmas.md`. Do not re-derive it. If a working assumption looks wrong, stop and say so.

---

## What is actually parallel

Only non-code preparation is independent now. The 2026-08-16 review of mobile #768 found that the protocol boundary itself was not settled in implementation, so producer and consumer changes are serialized.

```
export paperwork ───────────────────────────────────────────► human, independent
translation review / test preparation ─────────────────────► independent

A. streamer exchange gate + conditional QR
        └──► B. authenticated msg1/msg2 product contract
                  └──► C. repair mobile #768
                            └──► D. confirmation wiring + client pin
                                      └──► E. physical-device gate
                                                └──► F. one-line go-live flip
```

Use one integration owner for the protocol boundary. Every cross-repository PR records the counterpart SHA, compatibility matrix, seen-red mutation, exact test command, captured-output path, real exit code, and CI links. Development may overlap only where files and contracts do not.

### Track A — streamer producer contract

Land #630, then make QR emission use the same capability decision: disabled means no `spk`/`v`; enabled means the exchange accepts E2EE. Msg1 authenticates the device-registration inputs, and msg2 authenticates every result the new client persists or presents as verified. E2EE device registration is mandatory for success.

Files: `cli/index.ts`, `src/server.ts`, `src/api/routes/misc.routes.ts`, `src/e2ee/*`, and their tests.

Non-negotiables, all detailed in `next-session-prompt.md` — reproduce them in the subagent's brief rather than assuming it reads them:

- **Pairing-time capability is conditional `spk`/`v`, never pre-pair `/api/info`.** After msg1, a missing msg2 is refusal rather than plaintext.
- **An old app must still pair, unchanged.** No `e2ee` field means an older client, never a malformed request. The sealed API-key fields are still returned on the encrypted path; do not remove them or depend on their absence.
- **Authenticate product semantics, not only the handshake bytes.** E2EE registration reads device name/access from msg1, and a new client gets its device credential and verified metadata from msg2.
- **Never fall back silently.** A valid `spk`, a sent msg1, or an existing pin makes failure visible with no "connect anyway" affordance.

### Track B — repair the mobile consumer

PR #768 is draft and stays draft until its review findings are fixed: invalid `spk` through real entry paths, load-or-create key reuse, strict msg2 validation, authenticated result use, persistence across restart, coherent edit clearing, and web refusal. `D_priv` uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, is written before msg1 when first created, and is reused on response-loss retry and re-pair.

### Track C — the deep-link and paste confirmation gate

`mobile-design.md` §3.3. A `threadbase://pair?...` link in a message reaches pairing with no camera and therefore no out-of-band channel at all. For the deep-link and paste paths **only** — never a camera scan — show the server's identity fingerprint and authenticated machine name and require an explicit confirm.

Files: `app/pair.tsx`, the existing confirmation component, the paste call sites, `locales/*`, and their tests.

#766 already supplies the component. Keep it unwired until #768's authenticated result shape is stable, then land a focused wiring pass. The machine name shown as verified comes from msg2; machine-drafted Hebrew, Russian, and Arabic copy receives human review under #760.

### Then, in order — not parallel

**D. Auto-set the require-encryption pin** ([mobile#759](https://github.com/RonenMars/threadbase-mobile/issues/759)). Write it after msg2 is fully authenticated and validated—the same pairing event at which the server pins. Do not wait for a Phase 3 record-layer event.

**E. The first device run.** Cabled physical iPhone, local streamer, constant flipped locally. Verify key and pin survival, same-row re-pair, disabled-server QR without `spk`, missing/tampered msg2 failures, and the non-camera confirmation gate.

**F. Flip `E2EE_SUPPORTED`** — `src/api/routes/misc.routes.ts:135`, one line, its own PR, nothing else in the diff. Use a local edit for E; merge this go-live PR only after E is evidenced.

### Export compliance — start today, not after

Ronen's, not an agent's. It is the only item with external lead time: Apple must approve the uploaded documentation before any build can carry it, and that gate covers **TestFlight**, which distributes to internal testers long before a review sees anything.

The trigger is **the corrected mobile wiring**, not the flip. `ITSAppUsesNonExemptEncryption` is about what the app contains; a server constant has no App Store consequence. Detail is in `plan.md`; two items there are open questions for Ronen rather than tasks.

---

## Process, and the traps that already cost time

**Every commit needs Ronen's approval in his session** — the staged diff and the exact message, before `git commit`. A relayed approval from another agent is not approval, however confidently it is passed along. This came up and holding the line was correct.

**One worktree per track, outside the repo root**, and check `git worktree list` first — a dozen exist and some belong to other sessions. Run a real `npm ci` in each. **Do not symlink `node_modules` from another checkout**: it supplied a biome floated past the lockfile pin, which invented format errors in untouched files and took a baseline run against clean `main` to disprove.

**Merging is serialized even when development is not.** Rebase one, wait for green, squash-merge, then the next. `main` moved twice mid-merge yesterday, including from work outside this feature.

**Verification, real exit codes, output captured to a file** — `cmd | tail` reports tail's status. Streamer: `npm run lint && npm test`, not parallelized. Mobile: `npx tsc --noEmit && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e`. Before blaming your change for a failure, check whether clean `main` fails the same way.

**Every new behaviour gets a test that has been seen red.** Break it, watch it fail, restore, watch it pass, and say you did. For crypto, assert properties rather than activity — "it encrypted something" passes on a broken implementation.

Two failure shapes that have each shipped here already, so watch for them by name:

- **An assertion that cannot fail.** A negative assertion inside a `catch` cannot distinguish "failed correctly" from "never ran". A spy with no positive control passes when it never fires. Both occurred, one of them in the file whose whole purpose was avoiding it.
- **Docs that carry status.** Write what a thing *is*, not that it was built. A "Built." marker goes stale exactly like the claim it replaced, and CLAUDE.md cites a register where eight merged PRs still read as in flight.

**Do not regenerate the primitive interop vectors merely because the production payload becomes richer.** The vectors prove both Noise implementations against fixed arbitrary payload bytes; product-contract tests separately prove the msg1/msg2 JSON. If the primitive vectors ever stop agreeing, that disagreement is the finding.

---

## Stop and ask

- A gate cannot be satisfied without breaking an older client.
- The interop vectors stop matching between the two repos.
- A dilemma's working assumption looks wrong.
- You find a third credential path, or the design and the code disagree about what exists today.

Do not start Phase 3. The record layer wants a fresh session with the pairing path proven on hardware first.
