# PLAN-R1 — `--no-e2ee`, a `serve` flag and nothing else

Status: **awaiting approval**, written 2026-09-02. Nothing implemented. Local-only per the user's instruction; the branch is built but no PR opens before this evening.

Pin: streamer `origin/main` = `ab15fc2c` (`v1.73.0`). Preconditions re-verified rather than trusted: `v1.72.0`, `v1.72.1` and `v1.73.0` all resolve on the remote, the streamer PR slot is empty (`gh pr list --state open` → `[]`), and R1 is streamer-only, so it depends on neither mobile nor D2.

## What R1 is

One `serve` option that turns transport encryption off for that run, loudly. Scope from `tracks/R/prompt.md`; the design constraints are D-8 in `dilemmas.md` and §6.3–§6.5 of `design.md`.

## The five rules, and how each is made true

**1. A `serve` option only — no `server.yaml` key, no `THREADBASE_*` variable (D-8).**
`--no-e2ee` is a Commander negated option, the same shape `--no-pair-qr` already uses at `cli/index.ts:97`, so it arrives as `options.e2ee === false`. It is passed into `resolveFeatureFlags` on the **`cli` rung**, merged with whatever `--feature e2ee=…` already produces. Nothing is added to the yaml loader or to the env table, and the flag keeps its single registry `env:` entry — this option does not create a second one.

The rung matters and is the one thing a reviewer should check hardest: `env` sits **above** `cli` in `resolveFeatureFlags` (`src/feature-flags.ts:301-306`). So `THREADBASE_FEATURE_E2EE=1 tb-streamer serve --no-e2ee` leaves encryption **on**, and the operator is told which rung won. That is the documented precedence rather than an exception carved for this flag, and it is exactly the D-8 collision R2 escalates — R1 implements the precedence as written and does not pre-empt that decision.

**2. Both spellings mean one thing.** `--no-e2ee` and `--feature e2ee=false` must not disagree. They merge into the same `cli` rung value; if both appear and agree, nothing happens; if a future change lets them disagree, a test fails.

**3. A boot warning that cannot be missed.** Through the console dest at `warn`, plus `e2ee.disabled` in the JSON log with the reason. It states, in the operator's words: transport encryption is off for this run, traffic on the path is readable **including at the Cloudflare edge**, and **how many paired devices will now be refused** — the count of `e2ee_required = 1` rows.

The count carries D1's caveat (streamer #744): rows left by a pairing whose msg2 was lost are counted as pinned but never connected, so the number can overstate. If #744 has landed by implementation time, exclude never-contacted rows and say so; if not, the warning text names the caveat. Verified against the repo at implementation time, not assumed here.

**4. `/api/info` says why.** `e2ee: { supported: true, enabled: false, reason: "disabled by --no-e2ee" }`. The existing `describeE2eeCapability` (`src/api/routes/misc.routes.ts:172`) hardcodes one reason string for every disabled case; it grows a source argument so the reason names the rung that actually won. `supported` stays `true` — the build has the capability, this run declines to use it.

**5. It disables nothing else.** No at-rest change, no device un-pinned. A pinned device still gets `426` from X-server's enforcement, and its row still reads `e2ee_required = 1` afterwards. This is the rule most likely to rot, so it gets its own test rather than a comment.

## Verification bar

Real path throughout: the real Commander `serve` parsing, the real `resolveFeatureFlags`, a real devices table with N pinned rows, the real console dest capturing real bytes. No stubbed seam for the transition under test.

- **Positive control** — without the flag, `/api/info` reports `enabled: true` under `--feature e2ee=true`, and no warning is emitted. Proves the harness can see both states.
- **Negative control** — with the flag, a pinned device's request gets `426`, and re-reading the row still shows `e2ee_required = 1`.

Mutations, each reported as `<file>::<test>` plus the verbatim assertion, reverted in a `finally` with `git diff --quiet` asserted after each:

| # | Mutation | Must turn red |
|---|---|---|
| M1 | suppress the boot warning | the console-capture test |
| M2 | count all device rows instead of `e2ee_required = 1` | the N-rows count test |
| M3 | make the flag readable from `server.yaml` | the D-8 test |
| M4 | let the flag clear `e2ee_required` | the un-pin test |
| M5 | put the option on the `override` rung instead of `cli` | the env-wins test |

A mutated module that fails to import is reported `BROKEN — did not run`, never counted as a pass.

## Explicitly out of scope

R2's escalation (the D-8 vs §6.5 collision — presented to the user, never decided here), R3's default flip, stage 3, the `426` enforcement itself, and anything mobile. If implementing R1 turns up a reason the collision must be settled first, that is a stop-and-ask, not a judgment call.

## Sequence

Plan approval → implement on `feat/e2ee-no-e2ee-flag` in `tb-streamer/.worktrees/feat/e2ee-no-e2ee-flag` → mutations → lint (with the `.worktrees` biome quirk worked around by naming the changed files explicitly) → full suite → staged diff and exact message for the user's approval → **hold**. No push, no PR until the evening, per the user's instruction, and behind `feat/e2ee-open-refusal-log` in the one-PR-at-a-time queue.
