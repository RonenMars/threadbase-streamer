# Finish the E2EE program — session brief, written 2026-09-02 19:15 IDT

You are the owner session for the Threadbase E2EE program, running from `~/dev/ai-tools/tb-e2ee-program/`. Read `CLAUDE.md` in this folder first; it is binding, especially §3 (cryptographic guardrails), §4 (verification methodology) and §6 (stop-work triggers).

**Where things stand:** every implementation track is closed and shipped. Pairing (P, M), the WebSocket record layer (W), the REST envelope (X-server, X-client), device evidence (D1, D2) and R1 are all merged. Streamer is at **`v1.74.0`**; mobile main carries the ArrayBuffer fix and the client E2EE docs. `tracks/STATUS.md` is current and is the single source of truth — re-verify from it rather than from this brief, which will be stale the moment something merges.

**What is left is four pieces of work and two decisions that are the user's.** Do them in this order; two of them gate the rollout and the other two do not.

---

## 1. G-1 and G-2 — the last two device rows (blocking)

These are **named gates recorded on the R row of STATUS**. R2 cannot start without G-1; the stage-2 default flip cannot happen without G-2.

- **G-1 — continuation frames.** No D2 capture contains a WebSocket continuation frame, so fragmentation on the client's receive path is untested on hardware. Defect 1 (RN delivering frames as `ArrayBuffer`) proved that path is exactly where platform-specific delivery bugs live. Run a session streaming a few megabytes of mixed text and binary, capture it, sweep it.
- **G-2 — Android.** Every D2 row is iOS on one device model. Row 1 plus the chosen-plaintext canary, repeated on Android.

**Run both in one rig session, sharing one positive control.** Do not rebuild the rig for anything smaller. The user tore down the D2 rigs deliberately; rebuilding is ~10 minutes (`tb-streamer` npm install into a scratch `HOME`, `--feature e2ee=true`, plus a legacy `--feature e2ee=false` control rig).

**Method is not negotiable, and D2 got it wrong twice before getting it right — read `PLAN-D.md` §14 in full before capturing anything.** In particular:

- **The raw sweep is the primary grep**, not the decoded fields. D2's first draft greped only what tshark dissects and missed ~30 % of sealed payload bytes, including the one server-to-client frame per capture larger than the MSS — the class most likely to carry terminal output. Run both pipelines; masked client-to-server frames need the field decode, everything else needs the sweep.
- **The positive control must exercise the hard path**: a body and a frame each larger than one segment, and **report the control's own coverage** (total `tcp.len` versus bytes reaching the decoded files) beside the sealed runs. D2's control dissected 100 % of its payload precisely because everything fitted in one segment, which is why it certified a pipeline that could not see a third of the real traffic.
- **Derive the marker list from the run's own artefacts** — project name, session name, prompt text, the agent output as the server recorded it — never compose it from memory. Two independent reviewers hand-wrote that list for D2 and both were incomplete, in opposite directions.
- Paths, query strings, `X-TB-Env`/`X-TB-Ctx` headers, Noise handshake bodies and the plaintext `429` refusal body are **in the clear by design**. Expect them; list them; do not report them as findings.

Write the results into `tracks/D/D2-REPORT.md` as an addendum (D2 itself is accepted and signed; do not reopen it), and clear G-1/G-2 on the R row of STATUS only when the evidence exists.

## 2. Mobile defect 2 — the retry loop (not blocking, but it is the worst bug found)

Brief: `tracks/X-client/PROMPT-stop-polling-hard-refusal.md`. Evidence: `tracks/D/evidence/d2-row8-revocation-and-the-429-laundering.md`.

The mechanism is proven and reproducible on demand (revoke a paired device while the app is open): a permanent `403 E2EE_DEVICE_REVOKED` is retried, those retries charge the server's failure budget, the server answers `429`, and `services/e2ee/context.ts:212-214` maps `429` to `E2EE_TRANSIENT` whose `retryable` is `true` — so the client converts a permanent condition into an infinite loop and the on-screen text degrades from the accurate "This device is not paired for encryption" to the false "The server is busy; retrying shortly".

**The brief is explicitly NOT accepted as a specification, because the retrying layer is still unidentified.** Ruled out: the connect-time catch (`ws-client.ts:231`) and `sealedFetch`, both of which honour `retryable`. Neither the close-time path nor the 45 s silence timer matches the observed ~1.5 s cadence. The leading candidate, raised in review and still only a hypothesis, is the **client-log shipper**: its `POST /api/__client-log` calls are themselves sealed, so every failed open manufactures log lines that need a context, which needs an open, which fails. Confirming it needs the device's own client log, which was never captured — capture it during the G-1/G-2 rig session, since the rig will already be up.

Split the fix accordingly: **item 1 (a sticky permanent verdict per server that a later `429` cannot reset) is caller-independent and closes every candidate at once** — it can be built as soon as the reproduction is in a test. Item 2 (make the retrying layer consult `retryable`) requires naming the layer first.

## 3. Mobile defects 3 and 4 (not blocking)

- **Defect 3 — the 45 s silence timer.** `hooks/useTerminalStream.ts:25` force-reconnects when no WS traffic arrives, cannot distinguish a dead socket from an idle session, and now costs a full Noise handshake per fire: **3.1 context opens per minute at idle against a server limit of 5**. The fix is probably that any inbound frame resets the timer — the server already sends `host_pressure` and `session_list` — or a server ping. Do not "fix" it by raising the server's limit.
- **Defect 4 — the pending-prompt guard** blocks sending in the Terminal view as well as chat, so a prompt the agent will never resolve leaves a session uninteractive from the phone. Independent of E2EE.

Both are documented in `docs/e2ee-client.md` on mobile main. Neither has an issue filed; file them before fixing, per the repo's conventions.

## 4. R2 and R3 — the two decisions that are the user's, not yours

**R2 — the D-8 vs §6.5 collision.** `THREADBASE_FEATURE_E2EE=0` already exists by registry construction and is exactly the persistent, invisible off switch D-8 forbids. It is harmless while the default is off and becomes real at stage 2. `dilemmas.md` D-8 lists three ways out: exempt `e2ee` from the env rung; accept the variable and drop D-8's rule as unenforceable; or keep both and fire the boot warning on either source. The reviewer's recommendation on file is option 3. **Present all three with the trade-offs and let the user choose. Do not choose.** R1 deliberately implemented the documented precedence rather than pre-empting this, and there is a test pinning that behaviour (`does NOT beat the environment variable`) — changing it is R2's job, not a bug fix.

**R3 — the stage-2 flip.** `default: false` → `default: true` for `e2ee` in `src/feature-flags.ts`, its own one-line PR, nothing else in the diff except the tests that pin the old default. **Open it; never merge it.** It merges only on the user's explicit go, after G-2 and after the export-compliance approval lets an E2EE-capable build reach testers.

---

## Standing constraints

- **Strict NO-GO** (program `CLAUDE.md` §2): no at-rest database encryption, no per-project scoping, no protocol-constant consolidation (#619) until both implementations are proven, no `E2EE_SUPPORTED` flip except as its own one-line PR merged last with the user's explicit go.
- **One PR at a time per repo**, rebase onto latest `main`, squash-merge on green, and re-run every mutation after a rebase.
- **Commit approval on the staged diff and the verbatim message, every time.** Conventional titles, one sentence per line in bodies, no AI attribution, never push to `main`.
- **Worktrees only.** Streamer work in `tb-streamer/.worktrees/<type>/<slug>`, mobile in `../tb-mobile-worktrees/<slug>`. The root checkouts are read-only; `tb-streamer`'s root was cleaned to `origin/main` on 2026-09-02 and should stay that way.
- **Verification bar** (§4): real objects on the production path, a positive control proving the harness sees what it claims, a negative control proving causality, and a falsifiability mutation per safeguard reported with the failing test name and verbatim assertion. Crypto changes additionally get an isolated adversarial verifier.
- **Update `tracks/STATUS.md` on every step**, row cells and the decisions log, not just at the end.
- **Stop-work** (§6): a private key, device token or API key in any log, evidence or PR; two writers on one session's counter state; a plaintext frame on a channel declared sealed; anything that would force-update released apps; or a `dilemmas.md` entry turning out to be load-bearing.

## Outside the program, tracked but not yours to close

- **Export compliance** — every build since 204 ships `@stablelib` crypto under `ITSAppUsesNonExemptEncryption: false`. The declaration is false today regardless of the flag, and the ANSSI/Apple approval is on the critical path for any release.
- **#760** — human review of the Hebrew, Russian and Arabic encryption copy.
- **#745** — the dependency-upgrade checklist, which also documents the `conventional-changelog-conventionalcommits` 10.4.0 breakage responsible for the one recurring streamer suite failure. That failure is known and tracked; do not re-diagnose it as machine drift.

## First actions on arrival

1. Read `tracks/STATUS.md` top entry and the R row; re-verify every precondition from the remote rather than trusting this brief.
2. Confirm streamer `origin/main` and its latest tag, and mobile `origin/main`.
3. Confirm no open PR in either repo before starting one.
4. Say what you are about to do and why, then ask for the go on the first gated step.
