# Integration summary — integration/2026-08-20-open-prs (2026-08-20) — REHEARSAL

**Verdict:** ready to land
**Branch:** `integration/2026-08-20-open-prs` @ `a6915110` — 5 PRs, 16 commits ahead of `main` @ `2aa4672e`
**CI:** not run — this is a local rehearsal and nothing was pushed. Locally: lint green, `2275 passed / 5 skipped / 0 failed`. Each of the five PRs is independently 10/10 green on its own head.
**Full log:** [2026-08-20-open-prs-rehearsal-log.md](2026-08-20-open-prs-rehearsal-log.md)

Rebuilt the streamer integration branch from today's `main` after two landings moved it out from under the 2026-08-18 branch (#654 as `7d5dd11d`, then the v1.64.0 release). Five PRs merged in chronological order; **one conflict, mechanical, resolved identically to how the previous integration branch resolved the same collision**. No checkpoint went red. The single thing to know before touching it: **the new branch and the one it replaces differ only in `CHANGELOG.md`, `package.json` and `package-lock.json` — no `src/` or `__tests__/` content is lost**, so this is a clean swap, not a re-derivation.

---

## 1. Final refs

| What | Ref | SHA |
|---|---|---|
| Integration branch | `integration/2026-08-20-open-prs` | `a6915110` (local only) |
| Cut from | `origin/main` | `2aa4672e` |
| Base PR branch | #580 `dependabot/…-10.3.0` | `59e269fb` |
| Branch being replaced | `origin/integration/2026-08-18-open-prs` | `2c2e1b1c` — untouched |
| Backup | `backup/integration-2026-08-18-open-prs-2026-08-20-pre-rebase` | pre-existing, local |

---

## 2. What is in the branch

| PR | Title | Effect in one line |
|---|---|---|
| #580 | bump conventional-changelog-conventionalcommits 10.2.1 → 10.3.0 | semantic-release devDependency; touches only `package-lock.json` |
| #646 | feat(sessions): hold at next waiting_input when leave asks for idle kill | a leave-requested idle kill defers to the next `waiting_input` instead of cutting a turn |
| #650 | feat(ws): push host_pressure when the box is starved | new `host_pressure` WS frame with load/memory bars, incl. a Windows cpu-times path |
| #651 | feat(ws): drop session subscribers on unsubscribe_session | `unsubscribe_session` actually removes the subscriber |
| #653 | test(vitest): silence local suite logs and keep warn on CI | suite output 5 133 lines → **21**; also raises the non-Windows test timeout to 45 s |

### Not included

| PR / branch | Why | Standing exclusion? |
|---|---|---|
| #475 `chore(deps): bump postcss` | `CONFLICTING` / `DIRTY` — no merge ref, so its 12 green checks come from a stale ref and the suite never ran on the merged result. Unverified, not green. | no — revisit once rebased |
| `e074d5ad`, `2c2e1b1c` (old INT, no PR) | the pair/identity-code work; **already on `main`** via #654. `git diff origin/main <old-INT> --` over all four touched files is empty. | n/a |
| `d777d064` (old INT, no PR) | a biome fixup on last run's resolution of ledger #1. Not needed: this run's resolution is biome-clean as written. | n/a |

**Drafts:** the user asked to skip any drafts. The repo has **zero** open drafts, so this changed nothing — recorded so the next run does not re-ask.

---

## 3. The order that actually worked

**Final order:** `#580 → #646 → #650 → #651 → #653` — plain chronological by `createdAt`, executed exactly as planned, no mid-run reordering.

| Constraint | Kind | Reason |
|---|---|---|
| — | — | **None.** No stacking (all five have `baseRefName=main`; an all-pairs `git merge-base --is-ancestor` over the fetched heads returned nothing) and no forced-order constraint — all five are independently green on `main`. |

**One trap to not re-fall into:** the *local* branch `test/silent-suite-logs` sits at `034e1e7d` and contains the whole previous integration chain, which makes #653 look stacked on #646/#650/#651. It is not — that is last run's rebased copy left in a worktree. The PR's real head `be98a361` has 4 commits straight off `main`. **Judge stacking from `refs/integration/pr/*`, never from local branch names.**

---

## 4. Conflicts that mattered

| Conflict | Kept | Discarded | Rule applied | How you would know it was wrong |
|---|---|---|---|---|
| — | — | — | — | — |

**None.** The run produced exactly one conflict and it is class **M** (mechanical): `__tests__/ws-capabilities.test.ts`, one line, where #646's `armHoldWhenIdle` and #651's `removeSessionSubscriber` were added to the same returned-object literal. Resolved as the union of both — nothing discarded, so there is no judgment call to record. Independently corroborated: `integration/2026-08-18-open-prs` resolved the identical collision identically, byte-for-byte.

---

## 5. Silent problems found (and the ones still possible)

| Found | Where | How it was caught |
|---|---|---|
| — none | — | — |

**Sweeps run clean:** function-extraction call sites (structurally vacuous — every deletion in the set is a single-line in-place edit; **no PR moves or extracts a function**) · all 1 128 substantive added lines of #646/#650/#651 present on the branch bar the 2 superseded conflict lines · no blanket `--ours`/`--theirs` resolution anywhere · every symbol the set introduces still read (`armHoldWhenIdle`, `removeSessionSubscriber`, `host_pressure`, `hostPressure`, `unsubscribe_session`).

**Two near-misses that read as findings and are not:** #650's deletion of the `cache_alert_resolved` union member line (re-added minus its trailing `;` so a new member can follow — present at `src/types.ts:369`), and #653's deletion of the one-line `setupFiles` array (both prior entries survive; `silence-logs.ts` correctly ordered first).

**Sweeps not run:** cross-platform behaviour of any kind. #650's Windows cpu-times path was never executed — only its tests, on macOS.

---

## 6. Verification

| | Baseline (`main` @ `2aa4672e`) | Final (`a6915110`) | Δ |
|---|---|---|---|
| lint | green | green | — |
| typecheck | green (`tsc --noEmit`, inside `npm run lint`) | green | — |
| tests | `0 failed / 2211 passed / 11 skipped` | `0 failed / 2275 passed / 5 skipped` | **+64 passed, −6 skipped, 0 failed** |

Four checkpoints, one per merge, none red. Full per-checkpoint table in the log's §10.

**Not verified:** Windows and Linux entirely; Node 22 (CI covers it per-PR, not for the merged result); `npm run build` was never run, so tsup's dual ESM/CJS output and migration-folder copying are unexercised on the merged tree; the #580 dependency bump itself, since `npm ci` was not re-run after it merged. All timings are void — the box ran at load 15–30 throughout.

---

## 7. Obstacles worth remembering

| # | Obstacle | Fix | Recurs? | Automate? |
|---|---|---|---|---|
| O1 | `npm ci` exits **0** under npm 12 with `better-sqlite3`'s `node-gyp rebuild` blocked; `allowScripts` lists only `node-pty` | Prove the runtime by executing it — `require()` each native module — never by the exit code. Here all three load prebuilds, so nothing was needed. | every fresh worktree | yes — a preflight script |
| O2 | A coverage sweep written in shell reported **all 25 files of all 5 PRs missing**; cause was word-splitting, not a real gap | Rewrote in Python. Rule: never accept an empty-or-alarming sweep result until the same invocation has been shown able to return the opposite. | yes | yes |
| O3 | Host at load 29.78; every suite pass 440–478 s | None. Discard timings, keep pass/fail. | situational | no |
| O4 | `git cherry` marked all 14 old-INT commits absent from `main`, including one that had landed as a squash | Compare content, never patch-id ancestry, after a squash-merge. | every run | — already in `CLAUDE.md` |

---

## 8. Follow-ups

| Item | Why it is open | Next action | Owner | Issue |
|---|---|---|---|---|
| Branch name for the real run | A new name leaves `…-08-18-…` stale on `origin`; reusing it means a force-push | user picks before flow C starts | user | — |
| #475 (postcss) | excluded as `DIRTY` | rebase onto `main`, let CI run, reconsider | user | PR #475 |
| `npm ci` after #580 | no checkpoint exercised the bumped dep | re-install after that merge in the real run | real run | — |
| Merged-tree `npm run build` | not covered by lint or test | run once on the real branch, or rely on the INT PR's CI | real run | — |

---

## 9. Rules learned

- **Judge a rebase by patch-id, not by file list.** `git diff <merge-base> <pr-head> | git patch-id --stable` against the same for the rebased branch. Three of five PRs came back byte-identical; the file-list check alone would have raised a false alarm on #646, where `git diff <pr-head> <tip> -- <pr's files>` shows 112 changed lines that are `main` moving, not content lost. For the one conflicted PR, patch-id *is* expected to differ — diff the two patch bodies and confirm the delta is confined to the conflicted hunk.
- **Judge stacking from `refs/integration/pr/*`, never from local branch names.** A leftover rebase branch from the previous run makes an unstacked PR look stacked on three others.
- **Prove a negative result before believing it.** Both a broken sweep and a genuinely-clean sweep print nothing alarming; both an unbuilt native module and a working one leave `npm ci` at exit 0. Every negative in this run carries a positive control.
- **`— none` and a missing section are different claims.** Every sweep that came back clean says so and says how, so the next reader knows what is already covered.
- **A rehearsal must assert its own containment, not assume it.** `git ls-remote` for the new branch (0), for the branch being replaced (still `2c2e1b1c`), and every PR head compared to its `origin` value.
- **When rebuilding a branch, diff it against the one it replaces.** Three files differed, all intended. That single command is the difference between "I think I got everything" and knowing.

---

## 10. Cost

**~72 min wall-clock**, 5 PRs, **1 conflict** (mechanical), 0 judgment calls, 0 red checkpoints.
Three biggest sinks: the four full suite runs (~30 min of waiting, unavoidable under "do not batch"), host saturation inflating each of them, and O2's broken sweep (~5 min, self-inflicted).

**This summary is the input to the real run.** §3's order and §4's resolution are what flow C replays; §1's SHAs are what it must re-verify first, since any that moved invalidate the ledger for that PR.
