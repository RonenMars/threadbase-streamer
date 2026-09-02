# Threadbase E2EE Program: Workspace Directives

You are operating from a neutral workspace managing two repositories: @tb-streamer (`RonenMars/threadbase-streamer`) and @tb-mobile (`RonenMars/threadbase-mobile`). This folder holds the program's plans, status and evidence; it never holds code changes.

## 1. Directory Routing & Mechanics
*   **Repo-specific rules:** for build, test, lint and ship, read and follow @tb-streamer/CLAUDE.md and @tb-mobile/CLAUDE.md. Never run mobile tooling in the streamer repo or vice versa; verify the working directory before every shell command.
*   **Worktrees only:** streamer work in `tb-streamer/.worktrees/<type>/<slug>` (with the `node_modules` symlink), mobile work in `../tb-mobile-worktrees/<slug>` (sibling, own `npm ci`). The root checkouts are read-only except for the sanctioned ship step.
*   **Cite from `origin/main`, never a checkout:** `git show origin/main:<path>`; both root checkouts sit on stale branches.
*   **Absolute binaries:** `/opt/homebrew/bin/git`, `/usr/bin/log`; Node via nvm (`$HOME/.nvm/versions/node/v24.15.0/bin`).

## 2. Scope & Boundary
**Goal:** finish end-to-end encryption between the app and the streamer — pairing contract (streamer #630 / mobile #768, #766, #759), WebSocket record layer, REST envelope, negotiated rollout — per @tb-streamer/specs/end-to-end-encryption/remaining-work.md (the map) and the GitHub issues (#590 streamer, #698 mobile: the worklist).
**Design of record:** `design.md`, `mobile-design.md`, `plan.md`, `dilemmas.md` in that spec folder. Requirements live in `understanding.md`; dilemmas carry a working assumption — proceed on it, do not reopen it without evidence.
**Strict NO-GO:** no at-rest database encryption (TB-S-07), no per-project scoping (TB-S-05), no protocol-constant consolidation (#619) until both implementations are proven, no `E2EE_SUPPORTED` flip except as its own one-line PR merged last with the user's explicit go.

## 3. Cryptographic Guardrails (non-negotiable)
*   **Nonces are never random:** `direction(4) || counter(8)`; nonce reuse is an invariant a test asserts on, and that test must have been seen red.
*   **WebSocket counters are strictly monotonic, no window:** repeat, gap or reorder is a protocol violation. The counter surviving a rekey is the rule tested hardest. REST uses a sliding window because React Query is concurrent.
*   **Unseal runs before `authMiddleware`** — so parsing sits in front of authentication: reject unknown `ctxId` before any allocation, bound body size before decrypt, never allocate in proportion to an attacker-supplied length (D-9). Paths and query stay plaintext (D-7).
*   **Fail closed at the trust boundary:** absent `spk` ≠ invalid `spk`; after msg1, a missing msg2 is a failed pairing, never plaintext success; refuse E2EE on web rather than write `D_priv` to `localStorage`; `D_priv` is load-or-create and reused on retry/re-pair.
*   **`--no-e2ee` is a `serve` flag only** (D-8); stage 3 (refuse plaintext) is a product decision with an app-version floor, never a date, never automated.
*   **Never break released clients:** old-client response fields preserved; dual paths and explicit capability negotiation are mandatory.

## 4. Verification Methodology
For every core change: real objects on the production path (no stubbed `sendKeys`-style seams for the transition under test); a positive control proving the harness sees what it claims; a negative control proving causality; and a falsifiability mutation per safeguard, reported with the failing test name and verbatim assertion. Crypto changes (record layer, envelope) additionally get an **isolated adversarial verifier** — a sub-agent with the spec and the built artefact but none of the implementer's context — whose evidence-backed "could not break it" (nonce reuse across reconnect/rekey, counter rollback, replay, truncated/oversized body, ctxId confusion) is the acceptance.

## 5. Program Rules
*   One PR at a time per repo; rebase onto latest `main`, squash-merge on green; semantic-release makes the streamer tag the artefact — children key off **release tags**, never merges.
*   Every child re-verifies its precondition on arrival (PR `MERGED`, tag on the remote, approved artefact) rather than trusting the message.
*   Pin everything external at kick-off: the streamer version/tag mobile tracks test against (exact spec, not caret), Expo/RN/Xcode for device work, exact versions of any `@threadbase-sh/*` package a track imports.
*   Commit approval on the staged diff and verbatim message; conventional titles; one sentence per line in bodies; no AI attribution; never push to `main`.
*   Scrub captures before evidence leaves a scratchpad (taps log argv; the streamer once logged its full key). Separate `HOME`/config dirs for any rig; never touch the real `~/.threadbase`, `~/.claude`, or keychains. Shut down every simulator/emulator you booted; "left as found" needs a start-of-session record.
*   Persist `tracks/<group>/PLAN-*.md` on plan approval so a usage-limit resume continues instead of re-deriving. Keep `tracks/STATUS.md` (Group | Session | State | Last report | Next gate | Blockers) plus a decisions log current on every report.

## 6. Stop-Work Triggers
Pause and ask the user immediately if: a private key, device token or API key appears in any log, evidence or PR; two writers hold one session's counter state; a plaintext frame is observed on a channel declared sealed; a change would require force-updating released apps; or a dilemma in `dilemmas.md` turns out to be load-bearing for the current track.

## 7. Reference
Execution plan: `tracks/parallel-execution-plan.md` (copied from the streamer branch `docs/e2ee-parallel-plan`; the streamer copy is the one to keep in sync). Prior program, same methodology: `../ai-investigation-claude/tracks/` (README, STATUS.md, PROBE-PLAN §6 method notes).
