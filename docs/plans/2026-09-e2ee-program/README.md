# End-to-end encryption program, 2026-08-28 → 2026-09-02

The working documents of the cross-repo program that shipped end-to-end encryption between `threadbase-mobile` and `threadbase-streamer`: the pairing contract, the sealed WebSocket record layer, the sealed REST envelope, the device evidence that they hold on real hardware, and the first stage of the negotiated rollout.

Copied from the neutral workspace `ai-tools/tb-e2ee-program/` at the program's close; they are a record, not living documentation — the issues, PRs and specs they cite are the source of truth. The living design lives in [`specs/end-to-end-encryption/`](../../../specs/end-to-end-encryption/).

## What is here

- `WORKSPACE-CLAUDE.md` — the workspace directives the program ran under: scope and strict no-go list, the cryptographic guardrails (nonce construction, counter monotonicity, unseal-before-auth, fail-closed rules), the verification methodology, and the stop-work triggers.
- `tracks/STATUS.md` — the owner's running status table and decisions log, updated on every child report. The single richest document here; read it before anything else.
- `tracks/<group>/prompt.md`, `kickoff.md`, `PLAN-*.md` — each orchestrator's brief, the message it received, and the persisted plans. Groups: **P** (pairing close-out), **M** (mobile trust-boundary audit), **W** (WebSocket record layer, W0→W1a→W1b), **X-server** / **X-client** (REST envelope, both sides), **F** (evidence and gate-host follow-ups), **D** (device evidence), **R** (negotiated rollout).
- `tracks/REVIEW-2026-08-29-mega-brain*.md` — the independent design reviews that produced `NONCE-DESIGN.md` and three blockers before implementation started.
- `tracks/D/D2-REPORT.md` — **the verdict of record for sealed transport on hardware**, with its post-review revision and acceptance stamp.
- `tracks/D/evidence/*.md` — one write-up per finding, plus `d2-timings.ts`, the instrument that measured the server's deadlines against a live rig with real Noise handshakes.
- `tracks/PROMPT-FINISH-E2EE-2026-09-02.md` — what remains, written as a session brief.

Raw captures, decoded payloads, device screenshots and logs were deliberately not copied; the `.pcap` and `.bin` evidence stays in the workspace.

## Outcomes, for orientation

**Streamer:** #739 (pairing close-out), #740–#742 (WS hub routing and the record layer, `v1.71.0`), #748 (socket sealing, `v1.72.0`), #750 (`v1.72.1`), #751 (REST envelope, `v1.73.0`), #752 (D2 follow-ups: refusal logging, `--no-e2ee`, the Access boot probe, `v1.74.0`). Follow-ups filed: #743, #744, #747, #920, #921.

**Mobile:** #900, #901, #902 (pairing trust-boundary fixes), #908, #915, #917, #919 (F-track), #927 (WS transport), #934 (REST envelope), #940 (`ArrayBuffer` frame fix), #938 (client E2EE documentation). Follow-ups filed: #903–#906, #909.

**Verdict of record** (`tracks/D/D2-REPORT.md`, accepted 2026-09-02 after independent review): the sealed transport does what the design says it does. Nine device rows and two timing measurements on hardware; a full raw sweep of 379 483 B of TCP payload across three captures found zero plaintext markers, zero on-screen strings and zero occurrences of a chosen-plaintext canary that the server provably received. Seven defects were found — three mobile client bugs, one mobile UX issue, two streamer gaps and one environment trap — and **none in the protocol**.

## The two lessons worth reading even if you skip the rest

**A control that exercises only the easy path certifies only the easy path.** D2's first capture method greped tshark's decoded fields, which silently omitted about a third of the sealed payload — including the one server-to-client frame per capture too large for a single segment, the class most likely to carry terminal output. The positive control could not catch it, because every body and frame on the plaintext control rig fitted in one segment and so dissected completely. `tracks/D/PLAN-D.md` §14 now makes a raw full-payload sweep the primary grep and requires the control to carry a multi-segment body *and* frame, reporting its own coverage.

**Encryption and an edge gate do not coexist by default.** A sealed request carries no `Authorization` header by design, so an interactive Cloudflare Access application in front of a tunnelled streamer refuses it before the tunnel: pairing fails closed and the device blames a server that never saw the request. Measured on hardware, both directions — gate on, blocked; gate bypassed, full sealed transport through the same tunnel. The streamer now detects this at boot (`accessProbe`, on by default) and says so.

## Still open at the program's close

Two named gates stand between here and the stage-2 rollout, recorded on the R row of `tracks/STATUS.md`:

- **G-1 — continuation frames.** No capture contains a WebSocket continuation frame, so fragmentation on the client's receive path is untested on hardware. Blocks R2.
- **G-2 — Android.** Every device row is iOS on one device model. Blocks the stage-2 default flip.

Also open: the mobile retry-loop defect, whose mechanism is proven and reproducible but whose calling layer is still unidentified; the 45-second silence timer that now costs a Noise handshake per fire; and the D-8 versus §6.5 collision, which is a product decision rather than an implementation one.
