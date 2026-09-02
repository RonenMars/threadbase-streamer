# E2EE — parallel execution plan

Companion to [remaining-work.md](./remaining-work.md); read that first for phase content. This file is the *how to staff and sequence it*, modeled directly on the methodology `orchestrator` used for `ai-investigation-claude/tracks/` (verified by asking that session directly, 2026-08-28 — see decisions log at the bottom).

**Revision 2 — re-verified against both `origin/main` branches on 2026-08-28 19:50 IDT by `e2ee-owner`.** Revision 1 (same day, 19:07) assumed streamer #630 and mobile #768/#766 were still open; they are not. Every group below is re-scoped to what is actually left. The plan of record is the copy in the streamer repo at `specs/end-to-end-encryption/parallel-execution-plan.md`; `tb-e2ee-program/tracks/` mirrors it.

## What changed between 2026-08-16 and 2026-08-28

| Item | 08-16 state (remaining-work.md) | 08-28 state on `origin/main` |
|---|---|---|
| streamer #630 (exchange gate) | green, unmerged | **MERGED** 08-16 → 20c0bef2 |
| streamer msg1/msg2 authentication, conditional QR, mandatory registration | to do | **MERGED** 08-18 as #649 → ed339df8 (`cli/pair-banner.ts` extracted; `readOnly` required; `publicUrl: string \| null`) |
| `E2EE_SUPPORTED` | `false`, "flips last on the user's go" | **`true` since #674, merged 08-23, released v1.69.0.** The PR body's device-evidence and export-compliance gates were **unchecked at merge**; no comment records the evidence. Deployments are unaffected because the `e2ee` feature flag still defaults `false` (`src/feature-flags.ts:94`). The remaining user-gated flip is therefore the **stage-2 flag default**, not the constant. |
| mobile #768 (Noise handshake in pair exchange, the blocker) | draft with review defects | **MERGED** 08-20 → 952209ba |
| mobile #766 (confirm-gate component) | unwired | **MERGED** 08-18; **wired** by #782 (08-20), copy by #783/#804, modal-hosting fix #833 (08-22), e2e races #853 (08-23) |
| mobile #759 (auto-set pin) | open | Still open, but the code path exists: every pair call site passes `requireEncryption: exchanged.e2eeRequired` into `addServer`, which routes through the single `setRequireEncryption` writer (`stores/servers.ts:292`), and `pair-exchange.ts:596` refuses a msg2 whose `e2eeRequired !== true`. Needs seen-red evidence on the real path and the issue closed. |
| `ITSAppUsesNonExemptEncryption` | `false` | Set `true` by #806 (08-20), **reverted to `false` by #862 (08-25)** after App Store Connect rejected build 205 for a missing encryption declaration. The app ships `@stablelib` crypto under a `false` declaration until ANSSI's approval is uploaded. User's paperwork, not a track; it gates any TestFlight build reaching testers. |
| streamer release tag | — | **v1.70.6** (0069afc1). Mobile tracks pin `@threadbase-sh/streamer@1.70.6` exact. |
| mobile main | — | 229faf6b (`ios-v210`, `android-v59`), expo 57.0.18, react-native 0.86.3, `@stablelib/*` 2.0.1 |
| `parallel-execution-plan.md` on `docs/e2ee-parallel-plan` | — | **Never committed or pushed** — untracked file in worktree `../tb-streamer-e2ee-plan` (branch at 1.70.5). This revision becomes PR 0. |
| streamer #667 (device run does not cover `publicUrl: null`) | — | Open P3, folds into D |
| mobile #831 (two add-server implementations; the reachable one hosts the gate in a modal) | — | Open P2, folds into F |
| Phase 3/4/5 (record layer, REST envelope, rollout) | nothing built | **Still nothing built.** No `NONCE-DESIGN.md`, no `e2ee/record.ts`, no `/api/e2ee/open`, no unseal middleware, no `--no-e2ee`. Six WSHub-bypassing sends remain in `src/server-wiring.ts:711-806`. |

## The two axes

Every group below was assigned on two axes, per the orchestrator's own rule:

- **Model/effort tier** — not task size, but *how much of the task is judgment under uncertainty vs. execution of a fully specified change*. "If a wrong answer would look plausible and pass review, go up a tier; if a wrong answer fails loudly (tests, CI, a script), go down."
- **Parallel vs. sequenced** — forced to sequence by any one of three tests: (a) same files/modules in the same repo, (b) one track's *output* is another's *input* (a merge, a release tag, or a published design artifact), (c) a shared runtime resource (rig ports, a device, a pinned dependency version) that can silently change under a running track.

## Groups (revision 2)

| Group | Model / effort | Track(s) | Repo | Why this tier |
|---|---|---|---|---|
| **P** — pairing contract close-out | Sonnet 5 / medium, **plan-first** | Audit streamer #590's remaining checklist against `main` (single-use token under a failed mandatory registration, no orphan device row, seen-red legacy-compat and interop evidence); close the gaps, each rule with its own mutation; close #590's Phase 2 section | streamer | The diff, if any, is small, but "what is refused, what is rolled back, what an old client still gets" are trust-boundary semantics — a wrong rule ships silently. Sonnet/medium only on condition that the rule list is owner-approved before any diff and each rule has a mutation test. |
| **M** — mobile pairing trust-boundary audit | Opus 5 / high | Adversarial audit of the merged #768 repair on `main` against the seven items (absent-vs-invalid `spk` through real entry paths, gate on valid `spk`, `D_priv` load-or-create/reuse, full msg2 validation ignoring outer fields, coherent clearing, web refusal, persisted read-back); fix whatever it finds, plan-gated per defect | mobile | The 08-16 review found defects the green suite missed; nobody has yet reviewed the merged repair adversarially. A false "it holds" verdict looks plausible and ships a broken trust boundary — the exact failure this tier rule targets. |
| **W** — WS record layer | Opus 5 / high, **+ isolated verifier** | W0: route the six WSHub-bypassing sends through `WSHub`. W1a: `NONCE-DESIGN.md`; `e2ee/record.ts` (ChaCha20-Poly1305, `direction(4)‖counter(8)` big-endian, `bigint` counter, AAD per §3.3); `e2ee/context.ts` registry (ctxId, lifetimes, destroyed on restart/revocation, restart-vs-revoked codes distinguishable); **the shared 426 helper** (consumed by W1b and X-server from the tag); `POST /api/e2ee/open` + single-use WS ticket; client interop fixtures with their path in the PR body. W1b: per-socket sealing in `WSHub`, `/ws?ticket=`, strict monotonic counter, `e2ee.sequence_violation` close, rekey with the counter rule. | streamer | "Nonce reuse becomes an invariant a test asserts on rather than a probability argued about" — a subtly wrong nonce scheme passes casual review. W0 is fully-specified refactor work; W1a's context module is a shared artefact X-server builds on. Acceptance is the verifier's report, not W's own green suite. |
| **X-server** — REST envelope, server half | Opus 5 / **high** (raised on review: the fresh verifier inherits the session's effort), **+ isolated verifier** | Unseal middleware ahead of `authMiddleware` (`src/api/app.ts:121`), seal on the way out, RFC-6479 1024-bit sliding window per context, `426 E2EE_REQUIRED` for a pinned device presenting plaintext, D-9 hardening (unknown `ctxId` rejected before allocation, body bounded before decrypt, no allocation from an attacker-supplied length) | streamer | The D-9 rules are already applied once in `src/e2ee/pair-request.ts` — reapplying a written protocol at larger scale. Crypto-adjacent and pre-auth, so paired with the same verifier structure as W. |
| **X-client** — mobile transport half | **Opus 5 / high, + isolated verifier** (raised from Sonnet/medium in revision 1) | Context open against stored static keys, ticketed `/ws`, sealing at the `WSClient` boundary with a strict counter, REST envelope in `authedFetch` keyed off the stable server id with the sliding-window seq, §4.3 lifecycle (foreground rekey, reconnect fresh ticket, one transparent re-handshake, never plaintext fallback), delete the dead `{ type: 'auth' }` frame | mobile | Revision 1 scoped X-client to REST headers only and had no mobile owner for the WS half at all. The client record layer is a second independent crypto implementation with the `number`-vs-`bigint` counter trap plan.md names explicitly; interop against the built streamer is the acceptance. |
| **F** — mobile pairing follow-ups | Sonnet 5 / medium | Prove #759's four acceptance criteria on the real pair path with seen-red tests and close it; fix #831 so the one reachable add-server host presents the gate without a modal-in-modal; #760 (copy review) stays the user's | mobile | Fully specified once M's audit says the contract holds. |
| **D** — device evidence | Sonnet 5 / low for D1, **medium for D2** (a capture claim is where the prior program withdrew three results) | D1 (after P, M, F): the hardware gates #674 listed and never checked — disabled server prints no `spk` and pairs legacy; malformed `spk`, wrong responder key, tampered and missing msg2 fail visibly; deep-link/paste gate on hardware; identity code LTR in `he`/`ar`; `publicUrl: null` over LAN (#667) — cabled iPhone, Android over the tunnel, streamer v1.70.6 with `--feature e2ee=true` under an isolated `HOME`. D2 (after X-client): the same rig with sealed transport — ciphertext on the wire for terminal output, replay, conversation events, user messages; foreground rekey; reconnect. | both | Runbook with device gates, no design decisions. The constant flip is gone from this track (already merged); D2's evidence is what gates R's stage-2 PR. |
| **R** — negotiated rollout | Sonnet 5 / medium | R1 (fires on W1b + X-server tags, streamer-only): `--no-e2ee` as a `serve`-only flag (D-8), boot warning naming the pinned-device count, `e2ee.disabled` warn line, `/api/info` reason; **escalate** the D-8 vs §6.5 collision (`THREADBASE_FEATURE_E2EE=0` is the persistent off switch D-8 forbids) to the user before stage 2; the stage-2 `e2ee` default flip as its own one-line PR opened but **merged only on the user's explicit go**; stage 3 is a product decision with an app-version floor, never a date, never automated | streamer | Mechanically simple, but a wrong default is a silent-downgrade outage, and two decisions here are the user's, not the track's. |

## Adversarial verification (W1a/W1b, X-server, X-client)

The one place in this program where "wrong answer looks plausible and passes review" is the default outcome, not the exception — so, unlike the rest of the plan, this is a deliberate adversarial pair, not disjoint work that happens not to share context.

A verifier sub-agent, spawned with no access to the implementer's reasoning or diff history — only the spec (`design.md` §3–§4, `mobile-design.md` §4, `remaining-work.md`, `NONCE-DESIGN.md`) and the built artefact (the worktree at the reviewed commit, or the pinned streamer tag for X-client). Its brief is to break it:

- nonce reuse across reconnect/rekey
- counter rollback
- replay of a captured frame
- truncated or oversized body before decrypt
- `ctxId` confusion between sessions
- (X-client) precision loss in the counter; a sealed frame from the wrong direction accepted; plaintext leaving `authedFetch` or `WSClient` for a pinned server

Acceptance is the verifier's "could not break it" report: **every attempt in the brief listed** as one of `rejected: <evidence>`, `succeeded: <finding>`, `not attempted: <reason>` — an omitted row reads as covered — and each attempt shown to fail rather than asserted to; not the implementer's own green test suite. The verifier is a fresh agent that inherits the group session's model and effort, which is why W, X-server and X-client all run at high. If the verifier breaks it, that is a finding routed back to the implementer track through the owner.

## Wave / dependency graph (revision 2)

```
PR 0 (owner, now): this plan + a remaining-work.md refresh → streamer docs PR from
     ../tb-streamer-e2ee-plan (branch docs/e2ee-parallel-plan)

Wave 1 (parallel, staggered 15 min, no shared files)
  P  audit + close-out of streamer pairing contract ─────────────┐
  M  adversarial audit of the merged mobile repair ──────────────┤
  W  W0 → W1a (NONCE-DESIGN.md + record + context + open) → W1b ─┤
                                                                  │
Wave 2 (fires only on an owner-approved artefact or a re-verified merge/tag)
  F         ← M closed (audit verdict accepted, any fix PR MERGED)
  X-server  ← NONCE-DESIGN.md owner-approved AND the release tag containing W1a
              on the remote (X-server imports the context registry, so this is
              a code dependency now, not only an artefact one)
  D1        ← P, M, F all closed (re-verified); streamer tag pinned at kick-off

Wave 3
  X-client  ← F MERGED AND the release tag containing W1b AND X-server
              (WS half first on W1b's tag; REST half re-verifies X-server's tag
              on arrival)

Wave 3 (also)
  R1        ← the tags containing W1b AND X-server (streamer-only, disjoint files;
              gets the outage-warning code reviewed a wave early)
  D pre-setup ← M closed: rig isolation + device build, no pairing, so F → D1 is minutes

Wave 4
  D2        ← X-client MERGED (same rig, sealed transport on hardware; LAN-only ciphertext claim)
  R2/R3     ← X-client MERGED AND D2 evidence accepted; the stage-2
              default flip additionally needs the user's explicit go, and
              testers can only carry an E2EE build once the export-compliance
              approval is uploaded (user's obligation, outside every track)
```

Same-file check for wave 1, verified 2026-08-28: P touches `src/server.ts` pairing route, `src/e2ee/pair-*.ts`, `cli/pair-banner.ts` and their tests; W0/W1 touch `src/ws-hub.ts`, `src/server-wiring.ts:700-810`, new `src/e2ee/record.ts`, `src/e2ee/context.ts`, `src/api/routes/*` for `/api/e2ee/open`, `src/api/middleware/auth.middleware.ts:23` (`PUBLIC_POST_PATHS`). The only plausible collision is `src/server.ts` if W1a wires `/api/e2ee/open` there rather than in a route file — W is told to use a route file. M is mobile-only. Merge order between P and W is therefore free; whichever is green first merges first and the other rebases **and re-runs its mutations**, not only its suite — a rebase can silently neutralise a mutation test's assumptions. The same rule applies to every later rebase in both repos.

Every trigger above is an **owner-approved artefact or an independently-reconfirmed merge/tag**, never "the message said so". A child track re-verifies its own precondition on arrival (`gh pr view <n> --json state` → `MERGED`; `git ls-remote --tags origin <tag>` → present; the approved file at the named commit) rather than trusting the kickoff message.

## Isolation within a group

- **W0 → W1a → W1b**: same track, sequential, coordinate (shared artefact = the refactored WSHub, then the context module).
- **W / X-server / X-client ↔ their verifiers**: isolate — this *is* the program's adversarial-verification structure.
- **P, M, F, D, R sessions**: no shared context between groups by default.
- **D**: isolate its credentials and environment — separate `HOME`/`THREADBASE_CONFIG_DIR`, its own tunnel hostname, never the real `~/.threadbase`; scrub every tap/log capture of the API key and of any pair token before evidence leaves the scratchpad (taps log their argv; the streamer once logged its full key at boot — fixed in #729 but treat every capture as dirty by default).

## House rules carried over from the orchestrator's lessons

1. **Stable owner address, with the procedure spelled out in every kick-off message.** The owner is the session named `e2ee-owner`; if that name changes, the child confirms the new one with the user directly in its own pane — a relay from any other session is never enough.
2. **Prove the harness can fail, on the real path, before trusting a green run.** Every safeguard gets: a test on the real production object (no stubbed seam for the transition under test), a positive control proving the harness sees what it claims, a negative control proving causality, and one falsifiability mutation reported with the failing test name and the verbatim assertion.
3. **Persist a `PLAN-<group>.md`** in `tb-e2ee-program/tracks/<group>/` the moment its plan is approved, so a usage-limit-interrupted session resumes from the file.
4. **Pin external versions at kick-off, exact not caret.** Recorded in every brief: streamer `@threadbase-sh/streamer@1.70.6` for mobile tracks; expo 57.0.18, react-native 0.86.3, `@react-native/jest-preset` 0.86.3, `@stablelib/{chacha20poly1305,x25519,sha256,hmac}` 2.0.1, jest 29.7.0, Xcode 26.6 (17F113) locally, Maestro 2.8.0, Node v24.15.0 (`.nvmrc`), Claude Code 2.1.250; streamer-side vitest 4.1.11, typescript 7.0.2, hono 4.13.3, ws 8.21.3, better-sqlite3 13.0.3, `@threadbase-sh/scanner` 0.14.6, `@threadbase-sh/agent-types` 1.0.0. A rig that runs longer than an hour records the dist hash, not just the version string.
5. **Stagger kickoffs by ~15 minutes** within a wave.
6. **One-sentence-per-line commit/PR bodies, stated explicitly in every brief.**
7. **STATUS.md row shape**, one table, updated by the owner on every report, plus a decisions log underneath it.

## Kickoff order

0. Owner opens PR 0 (this plan + `remaining-work.md` refresh) from `../tb-streamer-e2ee-plan`; commit approval on the staged diff and verbatim message as for any PR.
1. Sessions **P**, **M**, **W** created by the user, kicked off by the owner 15 minutes apart with their `kickoff.md`.
2. **W**'s `NONCE-DESIGN.md` owner-approved and W1a's tag on the remote → owner kicks off **X-server**.
3. **M** closed → owner kicks off **F**.
4. **P**, **M**, **F** closed → owner kicks off **D** (D1).
5. **F** merged and the tag containing W1b and X-server on the remote → owner kicks off **X-client**.
6. W1b and X-server tags on the remote → owner kicks off **R1**; **M** closed → owner sends D its pre-setup.
7. **X-client** merged → owner sends D its D2 phase; D2 accepted → owner sends R its R2/R3 phase; the stage-2 PR waits for the user's go.
8. The owner owns STATUS.md and is the only SendMessage join point between groups.

## Decisions log

- 2026-08-28 19:03 IDT: asked `orchestrator [2b0bc8]` (owner of `ai-investigation-claude/tracks/`) for its actual tiering/sequencing/isolation criteria rather than inferring them from `tracks/README.md` alone; its answer is reproduced in substance across "The two axes," "Isolation within a group," and "House rules" above.
- 2026-08-28 19:07 IDT: sent the drafted plan back to `orchestrator [2b0bc8]` for review. Its findings, all applied: split X into X-server/X-client on the same-file test; added adversarial verification for W1 and X-server; made P plan-first with owner-approved validation rules; made R depend on D as well as W/X, and made the go-live flip a user-approved gate; tightened every trigger to "owner-approved artefact or independently-reconfirmed merge"; added streamer-version pinning for the mobile tracks and dist-hash recording for long-running rigs; added kickoff staggering, decisions-log-under-STATUS, and explicit one-sentence-per-line requirement in briefs.
- 2026-08-28 20:45 IDT (`e2ee-owner`): `orchestrator [2b0bc8]` reviewed revision 2 and the eight briefs; nineteen findings, all applied — X-server to Opus 5 / high and D2 to medium (verifier/capture tiers); the 426 helper and the restart-vs-revoked codes into W1a; R split into R1 (on the W1b + X-server tags) and R2/R3 (on D2); D pre-setup on M's close; rebase re-runs mutations; W1b race/revocation/broadcast-independence tests; X-server error shapes, mid-flight revocation and ETag/304; X-client no-persisted-counter and two-instances tests plus the replay-fallback spy; M and F get one interop run against the pinned streamer; D2 LAN-only and decode-before-grep; every adversary reports every attempt as rejected/succeeded/not attempted; kick-offs carry the unfilled-placeholder stop, the owner-ref rename rule, and owner-reads-the-diff-first.
- 2026-08-28 19:50 IDT (`e2ee-owner`, revision 2): re-verified against both `origin/main`. Phase 2 is merged on both sides (#630, #649, #768, #766, #782); the constant flipped in #674/v1.69.0 without its checklist evidence; export compliance was reverted to `false` by #862. P and M become audit/close-out tracks; F shrinks to #759 evidence and #831; D loses the flip and gains a D2 sealed-transport phase; X-client absorbs the mobile WS half and rises to Opus 5 / high with its own verifier; X-server now keys off W1a's release tag (code dependency on the context registry), not only the approved `NONCE-DESIGN.md`; the user-gated flip moves to R as the stage-2 flag default.
