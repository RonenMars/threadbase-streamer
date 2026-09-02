# Group R — negotiated rollout (orchestrator brief)

Model: **Sonnet 5**. Effort: **medium**. Reason: mechanically simple, but a wrong default here is a silent-downgrade outage, and two decisions in this track are the **user's**, not the track's — it must escalate rather than decide. Bumped off Sonnet/low for that.

You are the **orchestrator** for the streamer's Phase 5. You own the plan, diff reviews, commit-approval hand-offs and the merges — except the stage-2 PR, which you open and never merge. One named sub-agent. You report every step to **`e2ee-owner`**.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/CLAUDE.md` — §2 strict NO-GO on the flip, §3 `--no-e2ee` is a `serve` flag only.
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/parallel-execution-plan.md` — revision 2.
3. `tb-streamer/CLAUDE.md` — "CLI flags vs. `server.yaml`", "Feature flags" (precedence `ServerConfig` → env → `--feature` → `server.yaml` → default), "Prod/dev coordination".
4. From `origin/main` only: `specs/end-to-end-encryption/remaining-work.md` (Phase 5, and the decision register row "D-8 vs §6.5 at stage 2"), `design.md` §6.3–§6.5, §7 (the stage table and why stage 3 is a decision, not a date), §9; `dilemmas.md` D-8 in full, including its two "Open" paragraphs.
5. Code on `origin/main`: `cli/index.ts` (`serve` command :53, sibling options :56-99, `--feature` :88), `src/feature-flags.ts:94` (`e2ee`, `default: false`, `env: THREADBASE_FEATURE_E2EE`), `src/api/routes/misc.routes.ts` (`describeE2eeCapability`, the `reason` string), `src/logger.ts` (console dest), the devices repository (`e2ee_required` count), `cli/boot-log.ts` (#729's seam).

## Precondition to re-verify on arrival

- **R1** fires early: the streamer tags containing W1b and X-server on the remote (streamer-only, disjoint files; it does not depend on mobile or on D2). Pin the streamer `origin/main` commit.
- **R2/R3** fire later: X-client `MERGED` (`gh pr view`) and D2's report accepted by the owner (`tracks/D/D2-REPORT.md` exists and STATUS.md carries the acceptance line). Do not open R3 before both hold.

## Scope

**R1 — `--no-e2ee` (one PR).**
- A `serve` option only: no `server.yaml` key, no `THREADBASE_*` variable for it (D-8). Resolves last for the run, per the documented precedence.
- Boot warning through the console dest, unmissable: transport encryption is off, traffic is readable on the path including the Cloudflare edge, and **how many pinned devices will now be refused** (count `e2ee_required = 1` rows).
- `e2ee.disabled` at **warn** with a reason in the JSON log; `/api/info` reports `e2ee: { supported: true, enabled: false, reason: "disabled by --no-e2ee" }`.
- Does not disable at-rest anything; does not un-pin any device; pinned devices get `426` (X-server's enforcement) — a test proves the flag does not clear `e2ee_required`.

**R2 — escalate before stage 2.** (Reviewer's recommendation, `tracks/REVIEW-2026-08-29-mega-brain.md` N1: option 1 breaks stage 1 because `THREADBASE_FEATURE_E2EE=1` is the documented enable path; prefer option 3 — at stage 2 any flag-off source fires the same boot warning, pinned-device count and `/api/info` reason naming the source, and `--no-e2ee` becomes sugar for `--feature e2ee=false`. Present it with the other two; the user decides.) Present the D-8 vs §6.5 collision to `e2ee-owner` for the user: `THREADBASE_FEATURE_E2EE=0` already exists by registry construction and is exactly the persistent, invisible off switch D-8 forbids; it is harmless while the default is off and becomes real at stage 2. The three ways out from `dilemmas.md` D-8 (exempt `e2ee` from the env rung; accept the variable and drop D-8's rule as unenforceable; keep both and fire the boot warning on either). Do not choose. Implement whichever the user picks as R2's PR, if it needs code.

**R3 — the stage-2 flip.** `default: false` → `default: true` for `e2ee` in `src/feature-flags.ts`, its own one-line PR, nothing else in the diff except the tests that pin the old default (list them in the PR body, as #674 did). **Open it; never merge it.** It merges only on the user's explicit go relayed through `e2ee-owner`, after D2's evidence and after the export-compliance approval lets an E2EE-capable app reach testers. Stage 2's exit criterion and stage 3 (`e2ee.required: true`, a product decision with a minimum app version) are recorded as open items on #590, not implemented.

**Carry-in from W1a's adversary rounds (E-3):** `POST /api/e2ee/open` is public and its per-source failure bucket is keyed on `remoteAddress`, which behind a Cloudflare tunnel is 127.0.0.1 for every device — so the bucket is a fleet-wide gate. A sustained ~0.5 rps flood of malformed or replayed msg1s from anywhere on the internet holds `/open` closed for every paired device for as long as the flood lasts, at zero server DH (refused requests are never charged, so the bucket never drains). The streamer cannot distinguish sources there; the control is operator-side (Cloudflare rate limiting on `/api/e2ee/open`, Access with a Service Token for devices). The rollout guide states this plainly and the stage-2 escalation names it.

**Carry-in from the re-review (N-L1):** sealed requests carry no `Authorization`, and interactive Cloudflare Access rejects credential-less requests at the edge. D2 records what the production topology does; if E2EE devices need Access off or a Service Token, R documents it in the rollout guide and the stage-2 escalation names it — never by re-adding `Authorization` to sealed requests.

Out of scope: anything mobile; the `426` enforcement (X-server); stage 3.

## Sub-agent

### `streamer-rollout-engineer` — speciality: the `serve` CLI, feature-flag resolution, boot logging

Worktree `tb-streamer/.worktrees/feat/e2ee-no-e2ee-flag`, branch `feat/e2ee-no-e2ee-flag`, then `feat/e2ee-stage-2-default` for R3; `node_modules` symlink, Node v24.15.0, `npm run lint && npm test` exit codes captured.

## Verification bar

- Real path: the real `serve` option parsing and the real feature-flag resolver, a real devices table with N pinned rows for the count.
- Positive control (without the flag, `/api/info` reports `enabled: true` under `--feature e2ee=true`); negative control (with the flag, a pinned device's request gets `426` and the row still reads `e2ee_required = 1`).
- One mutation per rule, `<file>::<test>` + verbatim assertion: warning suppressed → console-capture test fails; count wrong → the N-rows test fails; flag reachable through `server.yaml` → the D-8 test fails; flag clears a pin → the un-pin test fails.

## Merge order and gates

- R1 (and R2 if code) rebase, re-run every mutation after the rebase, CI green, squash-merge, confirm `MERGED`, report the tag.
- R3 stays open with a clear "merges only on the user's go" line in its body. **You never merge it.** The owner relays the user's go; you re-verify by asking the user in your own pane before any merge.

## Rules

- Plan → owner approval → implement → staged diff + exact message → the user's approval in your pane → commit.
- Conventional-commit titles, one sentence per line, no AI attribution, never push to `main`, one PR at a time in this repo.
- Persist `tracks/R/PLAN-R.md` on plan approval.
- Report every step to `e2ee-owner`; if the name changes, confirm with the user in your own pane.
- **Stop-work**: any path that would silently downgrade a pinned device; a default that flips without the user's go; stage 3 appearing in any diff.

**Mutation-driver rules (program-wide, from W1a):** revert every mutation in a `finally` and assert `git diff --quiet` after each; a mutated module that fails to parse or import is reported `BROKEN — did not run`, never counted as a pass — absence of a failure line is not evidence, only an observed red is; after any interruption, check for a stranded mutation before anything else.

**Carry-in from D1 (2026-08-29, streamer #744):** never-connected E2EE device rows left by a lost msg2 inflate the "N pinned devices will be refused" count that R1 prints; state the caveat in the boot warning text or exclude rows with no authenticated contact if #744 has landed.

**Pollution sweep (program-wide, 2026-08-30):** prefer the framework accessor (Hono `c.req.header()` — immune, `Headers.get()` returns null when absent); otherwise guard with `own()` every read of a property on an attacker-shaped object — `req.headers[...]`, query objects, parsed JSON, options objects at constructor boundaries — not only `x ?? default`; Node builds `req.headers` with `Object.prototype`, so an absent header reads through a polluted prototype. One mutation per guard, red under a polluted prototype, with cleanup asserted in `finally`.
