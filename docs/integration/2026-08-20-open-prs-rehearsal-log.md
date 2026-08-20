# Integration merge log — integration/2026-08-20-open-prs (2026-08-20)

**Status:** complete
**Goal:** Rebuild the streamer integration branch from today's `main` (`2aa4672e`, v1.64.0) and re-merge the current open PR set, so the group can be tested together against a `main` that has moved twice since the 2026-08-18 branch was cut. Done = all five PRs merged in order, lint/test no worse than the `main` baseline, coverage gate clean.
**Operator:** Claude Code session (flow A — rehearsal, `origin` read-only)  **Repo:** threadbase-streamer  **Log started:** 2026-08-20 09:54 IDT

This is a **rehearsal**. No `git push`, no `gh pr merge/edit/close`, no remote branch deletion. Read commands against `origin` only.

---

## 1. Provenance and refs

| What | Ref | SHA | Note |
|---|---|---|---|
| Cut point | `origin/main` | `2aa4672e` | re-fetched 10:00 IDT immediately before the worktree was created; `chore(release): 1.64.0 [skip ci]` |
| Base PR branch | `dependabot/npm_and_yarn/conventional-changelog-conventionalcommits-10.3.0` (#580) | `59e269fb` | earliest PR by `createdAt` (2026-08-14); `mergeStateStatus=CLEAN`, already current with `main`, so the rebase onto `main` is a no-op |
| Integration branch | `integration/2026-08-20-open-prs` | `—` (filled at end) | local only in this flow |
| Previous INT | `integration/2026-08-18-open-prs` | `2c2e1b1c` | on `origin`; **not deleted, not touched** — it is the oracle for §7 and the diff target for §12 |
| Backup of previous INT | `backup/integration-2026-08-18-open-prs-2026-08-20-pre-rebase` | pre-existing local | created by an earlier session, left in place |
| Archive tag | — | — | none needed: nothing is being replaced or force-pushed in flow A |
| Worktree | `../tb-streamer-worktrees/int-rehearsal-2026-08-20` | detached at `2aa4672e` | own `npm ci` — not a copied `node_modules` |

### Environment provenance

| Item | Value |
|---|---|
| OS / arch | Darwin 25.5.0 arm64 |
| node / npm | `v24.15.0` / `npm 12.0.2` — matches `.nvmrc` (`v24.15.0`): **yes** |
| `git` / `gh` | `git 2.55.0` / `gh 2.97.0` |
| `node_modules` | `npm ci` at `2aa4672e`, exit 0 |
| Native modules rebuilt | **No — and none needed.** `npm 12` blocked 5 install scripts (`better-sqlite3@13.0.3 node-gyp rebuild`, `esbuild` ×2, `fsevents`, `protobufjs`) while still exiting 0. `package.json` `allowScripts` lists only `node-pty`. Verified by execution rather than by the exit code: `require('better-sqlite3')` opened an in-memory DB and ran DDL (`process.versions.modules=137`), `require('node-pty').spawn` is a function, `require('esbuild').version` = `0.27.7`. All three resolve prebuilds; `node-gyp` was never required. The pre-existing `int-2026-08-18` worktree has no `better-sqlite3/build/Release/*.node` either, which is the control. |
| Host load at baseline | `uptime` 10:03 → load averages **29.78 / 16.70 / 13.50**. The box is saturated. Per `CLAUDE.md` §Query timing this invalidates every *timing*, not pass/fail: a starved synchronous process makes each operation look pathological. No timing in this log is evidence of anything. |

---

## 2. Baseline — the state of `main` before anything landed

_(filled from the run in progress — see §5)_

| Check | Command | Result |
|---|---|---|
| lint | `npm run lint` (= `tsc --noEmit && biome check .`) | pending |
| typecheck | folded into `npm run lint` | pending |
| tests | `npm test` | pending |

Known-flaky before the run: pending.

---

## 3. Scope — what is in, what is out

Mode: **all open PRs**, minus the exclusions below. Resolved from `gh pr list --state open --limit 60` (6 rows) and confirmed with the user before anything was cut.

`mergeable` / `mergeStateStatus` / `isDraft` / `statusCheckRollup` were queried **per PR** (`gh pr view <n> --json …`), never from the bulk list — a bulk query returns `UNKNOWN` for every row.

| PR | Title | Head branch | Head SHA | Base | Draft? | Mergeable | CI on PR |
|---|---|---|---|---|---|---|---|
| #580 | chore(deps-dev): bump conventional-changelog-conventionalcommits 10.2.1 → 10.3.0 | `dependabot/npm_and_yarn/conventional-changelog-conventionalcommits-10.3.0` | `59e269fb` | `main` | no | `MERGEABLE` / `CLEAN` | 10/10 SUCCESS |
| #646 | feat(sessions): hold at next waiting_input when leave asks for idle kill | `feat/hold-when-idle` | `b17c556c` | `main` | no | `MERGEABLE` / `BEHIND` | 10/10 SUCCESS |
| #650 | feat(ws): push host_pressure when the box is starved | `feat/host-pressure` | `94726308` | `main` | no | `MERGEABLE` / `BEHIND` | 10/10 SUCCESS |
| #651 | feat(ws): drop session subscribers on unsubscribe_session | `feat/unsubscribe-session` | `acb679f9` | `main` | no | `MERGEABLE` / `BEHIND` | 10/10 SUCCESS |
| #653 | test(vitest): silence local suite logs and keep warn on CI | `test/silent-suite-logs` | `be98a361` | `main` | no | `MERGEABLE` / `BEHIND` | 10/10 SUCCESS |

Check names on every row: `Gate, Setup, Warm cache (Node 24), Lint, Build, Smoke (macos-latest), Smoke (windows-latest), Test (Node 22), Test (Node 24), security/snyk`. Counted by **name**, not by conclusion — the real suite ran on all five.

**Drafts:** the user asked (mid-run) to skip any draft PRs. `gh pr list --json isDraft` returns **zero drafts** in this repo's open set, so the instruction changes nothing here. Recorded as a standing rule for the next run.

### Deliberate exclusions

| PR | Why excluded | Standing or one-off? |
|---|---|---|
| #475 | `chore(deps): bump postcss 8.5.16 → 8.5.26`. `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY` — no merge ref, so its 12 green checks are from a stale ref and the suite never ran on the merged result: **unverified, not green**. User excluded it. | one-off — revisit when it is rebased |

### Extra branches included (non-PR)

— none. Every worktree branch was checked against the PR set; nothing outside it is being merged.

### Work on the old INT that is *not* being carried forward

The 2026-08-18 branch carried three commits with no PR home. All three were checked before dropping them, because "dropped" and "already on `main`" must not look alike:

| Commit | What | Verdict |
|---|---|---|
| `e074d5ad` `feat(pair): print the identity fingerprint under an encrypted QR` | was PR #654 | **On `main`** as squash `7d5dd11d`. `git cherry` marks it `+` (squash defeats patch-id ancestry) — content checked instead. |
| `2c2e1b1c` `fix(pair): call the printed key an identity code, not a fingerprint` | INT-only, real content | **Absorbed.** `git diff origin/main HEAD -- __tests__/identity-command.test.ts __tests__/pair-banner.test.ts cli/identity.ts cli/pair-banner.ts` is **empty**; `main`'s `cli/pair-banner.ts:62` already reads `"Identity code"`. |
| `d777d064` `style: fix biome formatting on the buildDeps conflict resolution` | INT-only artifact of a #650/#651 conflict resolution in `__tests__/ws-capabilities.test.ts` | Not carried. It is a formatting fixup on a resolution that will be re-derived in §7; if the same collision recurs, biome re-fixes it. |

---

## 4. Order plan

**Planned order:** `#580 → #646 → #650 → #651 → #653`

Chronological by `createdAt` (2026-08-14, 08-17, 08-18, 08-18, 08-19), identical to the order the 2026-08-18 branch used for the four human PRs. No constraint overrides it.

### Stacked PRs

— none. Every PR has `baseRefName=main`, and an all-pairs ancestry check over the fetched heads returned nothing:

```
for a in 646 650 651 653; do for b in …; do git merge-base --is-ancestor refs/integration/pr/$a refs/integration/pr/$b; done; done   # no output
```

**Trap avoided:** the *local* branch `test/silent-suite-logs` sits at `034e1e7d` and contains the entire previous integration chain, which reads as #653 being stacked on #646/#650/#651. It is not — that is last run's rebased copy left behind in a worktree. The PR's real head `be98a361` has exactly 4 commits, all directly on `main`. Stacking was judged from `refs/integration/pr/*`, never from local branch names.

### Forced-order constraints (not chronological)

— none identified. All five PRs are independently green on `main`.

### Files touched by more than one PR — where conflicts are expected

| File | PRs | Note |
|---|---|---|
| `src/server.ts` | #646, #650, #651 | three-way overlap; the 2026-08-18 branch is the oracle |
| `src/server-wiring.ts` | #646, #650, #651 | same |
| `__tests__/ws-capabilities.test.ts` | #646, #651 | the collision `d777d064` was formatting-fixing last run |
| `docs/compatibility/tb-mobile.md` | #646, #650 | doc-line collision, expected mechanical |

#653 (`vitest.config.ts`, `__tests__/setup/silence-logs.ts`, `__tests__/test-log-silence.test.ts`, `__tests__/security-hardening.test.ts`) and #580 (`package.json`, `package-lock.json`) overlap nothing.

### Order changes made mid-run

— none yet.

---

## 5. Action log (chronological)

### 09:54 — scope resolved and confirmed

- **Command:** `gh pr list --state open --limit 60 --json number,title,headRefName,headRefOid,baseRefName,isDraft,createdAt,author`
- **Result:** 6 open PRs — #475, #580 (dependabot), #646, #650, #651, #653 (human). Zero drafts.
- **Note:** #647 and #654 from the 2026-08-19 rescan are gone — #654 landed as `7d5dd11d`. User confirmed: include #580, exclude #475, stop on red CI.

### 10:00 — worktree cut and dependencies installed

- **Command:** `git worktree add ../tb-streamer-worktrees/int-rehearsal-2026-08-20 --detach 2aa4672e` then `npm ci`
- **Result:** exit 0, but npm 12 blocked 5 install scripts including `better-sqlite3`'s `node-gyp rebuild`.
- **Note:** proved the runtime works by executing it (see §1 environment) rather than trusting the exit code. Obstacle **O1**.

### 10:05 — baseline started on `main` @ `2aa4672e`

- **Command:** `npm run lint; npm test` (captured in full to a file — not piped to `tail`)
- **Result:** pending


### 10:12 — baseline complete on `main` @ `2aa4672e`

- **Command:** `npm run lint` then `npm test`, full output to `baseline.log` (5 133 lines). Not piped to `tail` — `--reporter=basic` is gone in vitest 4 and a tail hides the failure list.
- **Result:** `LINT_EXIT=0` · `Test Files 226 passed | 1 skipped (227)` · `Tests 2211 passed | 11 skipped (2222)` · `TEST_EXIT=0` · `Duration 455.50s`
- **Note:** the 455 s is not a measurement — load was 22–30 throughout. The suite's own log volume (thousands of pino lines to stdout) is what #653 exists to fix.

### 10:14 — branch cut from #580 and rebased onto `main`

- **Command:** `git checkout -b integration/2026-08-20-open-prs refs/integration/pr/580` then `git rebase origin/main`
- **Result:** `Current branch … is up to date` — #580 was already current with `main` (`mergeStateStatus=CLEAN`), so the rebase was a genuine no-op rather than a silent one.
- **Branch SHA after:** `59e269fb`

### 10:15 — #646 rebased onto the tip and merged

- **Command:** `git checkout -B rebase/pr-646 refs/integration/pr/646` · `git rebase integration/2026-08-20-open-prs` · `git merge --no-ff rebase/pr-646`
- **Result:** rebase clean (1/1), merge clean — **no conflict**. `7 files changed, 548 insertions(+), 3 deletions(-)`.
- **Branch SHA after:** `3169f901`
- **Note:** commit hooks did not reject the merge commit.

### 10:16 — #646 diff-scope verified by patch-id, not by file list

- **Command:**
  ```
  MB=$(git merge-base origin/main refs/integration/pr/646)          # 2cf660ae
  git diff $MB refs/integration/pr/646 | git patch-id --stable
  git diff 59e269fb rebase/pr-646     | git patch-id --stable
  ```
- **Result:** both `b6fafd03bb5a5b16a098c41cce2b787b056a84b4`. Patch bodies byte-identical (721 lines each). File lists also identical to `gh pr diff 646 --name-only`.
- **Note:** the file-list check alone was **not** sufficient here and would have raised a false alarm. `git diff refs/integration/pr/646 HEAD -- <#646's files>` shows 112 changed lines in `src/server.ts` and `__tests__/server.test.ts` — that is `main` having moved (#654 landed as `7d5dd11d`), not content lost from the PR. Patch-id equality is the check that actually answers "did the rebase widen or narrow this PR". **Adopted for every PR in this run.**

### 10:17 — checkpoint 1 started (#580 + #646)

- **Result:** `LINT_EXIT=0` · `Test Files 226 passed | 1 skipped` · `Tests 2231 passed | 5 skipped (2236)` · `TEST_EXIT=0`. Δ vs baseline: **+20 passed, −6 skipped, 0 failed** — #646 adds tests and un-skips six.

### 10:26 — #650 rebased onto the tip and merged

- **Command:** `git checkout -B rebase/pr-650 refs/integration/pr/650` · `git rebase integration/2026-08-20-open-prs` · `git merge --no-ff rebase/pr-650`
- **Result:** all 5 commits replayed, **no conflict** (`git diff --name-only --diff-filter=U` empty), merge clean. `9 files changed, 915 insertions(+), 1 deletion(-)`.
- **Branch SHA after:** `b2212959`
- **Note:** `src/server.ts`, `src/server-wiring.ts` and `docs/compatibility/tb-mobile.md` are all shared with #646 and all auto-merged — the edits are in disjoint regions. Patch-id **identical** (`72341ed3…` both sides); file list identical to `gh pr diff 650 --name-only`.

### 10:35 — checkpoint 2 (#580 + #646 + #650)

- **Result:** `LINT_EXIT=0` · `Test Files 227 passed | 1 skipped (228)` · `Tests 2266 passed | 5 skipped (2271)` · `TEST_EXIT=0`. Δ vs baseline: **+55 passed, −6 skipped, 0 failed**.

### 10:36 — #651 rebased onto the tip — **conflict**

- **Command:** `git rebase integration/2026-08-20-open-prs` on `rebase/pr-651`
- **Result:** `CONFLICT (content): __tests__/ws-capabilities.test.ts`. `src/server-wiring.ts` and `src/server.ts` auto-merged. → ledger **#1**.
- **Note:** this is the same collision the 2026-08-18 run hit, in the same file.

### 10:38 — ledger #1 resolved as the union, matching the oracle

- **Command:** resolved in place, then `git add` · `git rebase --continue` · `npx biome check __tests__/ws-capabilities.test.ts`
- **Result:** `Checked 1 file in 47ms. No fixes applied.` — biome clean on the resolution, so **no follow-up style commit was needed** this run (the 2026-08-18 branch needed `d777d064` for exactly this).
- **Note:** the edit was applied with an assert that exactly one site matched (`assert s.count(old)==1`) rather than an unanchored substitution.
- **Verified against the oracle:** `diff <(git show integration/2026-08-18-open-prs:__tests__/ws-capabilities.test.ts | sed -n '62,71p') <(sed -n '62,71p' __tests__/ws-capabilities.test.ts)` → **identical**. The previous integration branch resolved this collision the same way.

### 10:39 — #651 merged

- **Command:** `git merge --no-ff rebase/pr-651`
- **Result:** clean. `4 files changed, 52 insertions(+), 1 deletion(-)`.
- **Branch SHA after:** `081a7659`
- **Diff scope:** file list identical to `gh pr diff 651 --name-only`. Patch-id **differs** (`423c6170…` → `7c747821…`) — expected for a conflicted rebase. The difference was diffed line-by-line and is confined to the single conflicted line; **both sides' additions survive** (`armHoldWhenIdle` from #646, `removeSessionSubscriber` from #651). Nothing else in the patch body changed.

### 10:40 — checkpoint 3 started (#580 + #646 + #650 + #651)

- **Result:** `LINT_EXIT=0` · `Test Files 227 passed | 1 skipped (228)` · `Tests 2269 passed | 5 skipped (2274)` · `TEST_EXIT=0`.

### 10:49 — #653 rebased onto the tip and merged

- **Command:** `git rebase integration/2026-08-20-open-prs` on `rebase/pr-653` · `git merge --no-ff rebase/pr-653`
- **Result:** all 4 commits replayed, **no conflict**, merge clean. `4 files changed, 134 insertions(+), 8 deletions(-)`.
- **Branch SHA after:** `a6915110`
- **Diff scope:** patch-id **identical** (`273ad941…` both sides); file list identical.

### 10:58 — final checkpoint (all five PRs)

- **Result:** `LINT_EXIT=0` · `Test Files 228 passed | 1 skipped (229)` · `Tests 2275 passed | 5 skipped (2280)` · `TEST_EXIT=0`.
- **Note:** the captured run is **21 lines** against the baseline's **5 133**. That is #653 working, measured rather than asserted.

### 11:00 — sweeps, coverage gate and containment proof

Detailed in §8 and §12. Containment (§13) verified: `git ls-remote --heads origin | grep -c integration/2026-08-20-open-prs` → **0**.

---

## 6. Per-PR record

### #580 — chore(deps-dev): bump conventional-changelog-conventionalcommits 10.2.1 → 10.3.0

| Field | Value |
|---|---|
| Head before / after rebase | `59e269fb` → `59e269fb` (no-op — already current with `main`) |
| Rebased onto | `origin/main` `2aa4672e` |
| Conflicts | none |
| Diff scope after rebase | 1 file (`package-lock.json`), identical to `gh pr diff 580 --name-only` |
| Integration SHA after merge | `59e269fb` (branch cut point — no merge commit) |
| Verification | folded into checkpoint 1 |
| Obstacles | — |

**Not re-installed after this merge.** `npm ci` was run at `2aa4672e`, before #580 landed. `conventional-changelog-conventionalcommits` is a semantic-release-only devDependency and is imported by nothing the suite touches, so the four checkpoints ran against the pre-bump tree. Named here rather than hidden: the real run should `npm ci` again after this merge if it wants the bump exercised.

### #646 — feat(sessions): hold at next waiting_input when leave asks for idle kill

| Field | Value |
|---|---|
| Head before / after rebase | `b17c556c` → `26947c92` |
| Rebased onto | `59e269fb` (#580) |
| Conflicts | none |
| Diff scope after rebase | patch-id `b6fafd03…` **identical**; 7 files, file list identical |
| Integration SHA after merge | `3169f901` |
| Verification | lint green · `2231 passed / 5 skipped / 0 failed` |
| Obstacles | — |

### #650 — feat(ws): push host_pressure when the box is starved

| Field | Value |
|---|---|
| Head before / after rebase | `94726308` → (5 commits replayed) |
| Rebased onto | `3169f901` (#646) |
| Conflicts | none — `src/server.ts`, `src/server-wiring.ts`, `docs/compatibility/tb-mobile.md` all auto-merged despite being shared with #646 |
| Diff scope after rebase | patch-id `72341ed3…` **identical**; 9 files, file list identical |
| Integration SHA after merge | `b2212959` |
| Verification | lint green · `2266 passed / 5 skipped / 0 failed` |
| Obstacles | — |

### #651 — feat(ws): drop session subscribers on unsubscribe_session

| Field | Value |
|---|---|
| Head before / after rebase | `acb679f9` → `9ff169af` |
| Rebased onto | `b2212959` (#650) |
| Conflicts | `__tests__/ws-capabilities.test.ts` ×1 → ledger **#1** |
| Diff scope after rebase | file list identical. Patch-id **differs** by design (`423c6170…` → `7c747821…`); the delta was diffed and is confined to the one conflicted line, with both sides' symbols present |
| Integration SHA after merge | `081a7659` |
| Verification | lint green · `2269 passed / 5 skipped / 0 failed` |
| Obstacles | — |

### #653 — test(vitest): silence local suite logs and keep warn on CI

| Field | Value |
|---|---|
| Head before / after rebase | `be98a361` → (4 commits replayed) |
| Rebased onto | `081a7659` (#651) |
| Conflicts | none |
| Diff scope after rebase | patch-id `273ad941…` **identical**; 4 files, file list identical |
| Integration SHA after merge | `a6915110` |
| Verification | lint green · `2275 passed / 5 skipped / 0 failed` |
| Obstacles | — |

---

## 7. Conflict ledger

| # | PR | File | Hunks | What collided | Resolution | Class | Oracle | Verified by |
|---|---|---|---|---|---|---|---|---|
| 1 | #651 | `__tests__/ws-capabilities.test.ts` | 1 | The returned-object literal of the test harness factory. #646 (already on the tip) added `armHoldWhenIdle`; #651 adds `removeSessionSubscriber`. Both edit the same single line. | Union of both, written in biome's wrapped multi-line form | **M** | `integration/2026-08-18-open-prs` resolved the identical collision identically — verified by `diff` of lines 62–71, byte-for-byte | `npx biome check` (no fixes applied) · full suite `2269 passed / 0 failed` · line-level patch-body diff showing both symbols present |

### Judgment calls in full

— none. The single conflict is class **M**: neither side was discarded, so no information was lost and there is no alternative to record.

---

## 8. Semantic conflicts — problems git did *not* flag

| Sweep | Result |
|---|---|
| For each function moved/extracted by any PR in the set, grep its call sites | **Checked, empty — and structurally impossible here.** Every deletion the whole set makes was enumerated (`git diff <merge-base> <pr-head> \| grep '^-'`): 3 lines in #646, 1 in #650, 1 in #651, 8 in #653. All are single-line in-place edits — return-object literals, one union member's trailing `;`, a rewritten test body, a widened `setupFiles` array. **No PR extracts or moves a function**, so the extract-while-editing failure mode has nothing to act on. |
| Every added line of each PR present on the branch | **1 128 substantive added lines checked across #646/#650/#651; 2 not found**, both being the two sides of ledger #1, superseded by the union that contains both symbols. Documented false negative — see §12. |
| Blanket per-file resolutions (`--ours`/`--theirs`) | **None used.** The one conflict was resolved hunk-wise. |
| Behaviour flags / env vars / wiring introduced by the set — each still read | **Checked, all wired.** `armHoldWhenIdle` (2 src + 1 test), `removeSessionSubscriber` (2 src + 2 tests), `host_pressure` (4 src + 1 test), `hostPressure` (5 src + 1 test), `unsubscribe_session` (1 src + 1 test). |

| # | Where | What was silently lost/changed | Found how | Fix |
|---|---|---|---|---|
| — | — | **none found** | the four sweeps above | — |

### Two near-misses worth recording

1. **`src/types.ts` — #650 deletes the `cache_alert_resolved` union member line.** Read from the deletion list alone that is a removed WS message type, which would be a mobile-visible break. It is not: the line is re-added without its trailing `;` so a new union member can follow. Confirmed present on the branch at `src/types.ts:369`.
2. **`vitest.config.ts` — #653 deletes the one-line `setupFiles` array.** Both pre-existing entries survive in the replacement, and `silence-logs.ts` is ordered **first**, which is required for it to take effect before the other setup files. Confirmed by reading the merged file.

### A sweep that was wrong before it was right

The first coverage sweep was written as a shell loop and reported **every file of every PR as missing**. The cause was unquoted-variable/`IFS` handling in the accumulator, not a real gap. It is logged because the failure mode is the dangerous one: a broken sweep that prints a plausible list reads as a finding, not as an error. Rewritten in Python against `git cat-file -e` / `git rev-parse <ref>:<path>`, it returned `absent: none` for all five PRs. Likewise `grep -rl silenceLogs` returned `0` — that symbol never existed; the real wiring is `setupFiles: ["__tests__/setup/silence-logs.ts"]`, confirmed by reading `vitest.config.ts:26-27` and running a positive control (`grep -c . __tests__/setup/silence-logs.ts` → 52).

---

## 9. Obstacles and detours

### O1 — `npm ci` exits 0 with native install scripts blocked (npm 12)

- **Symptom:** `npm ci` succeeds; `node_modules/better-sqlite3/build/Release/*.node` does not exist.
- **Cause:** npm 12 blocks install scripts not covered by `allowScripts`, which lists only `node-pty`. 5 packages blocked, including `better-sqlite3`'s `node-gyp rebuild`.
- **Fix:** none needed **here** — all three load from prebuilds. Proven by executing them, not by the exit code.
- **Cost:** ~4 min.
- **Recurs?** Yes, every fresh worktree. The check belongs in the procedure permanently; the *conclusion* ("fine") does not — it is prebuild-availability-dependent and will flip on a Node major bump.

### O2 — a broken sweep that looks like a finding

- **Symptom:** coverage sweep reported all 25 files across 5 PRs as missing.
- **Cause:** shell word-splitting in the accumulator variable.
- **Fix:** rewrote in Python; added a positive control to every negative result.
- **Cost:** ~5 min.
- **Recurs?** Yes. Rule: never accept an empty-or-alarming result from a sweep until the same invocation has been shown able to produce the opposite.

### O3 — host saturation throughout

- **Symptom:** load average 29.78 → 15.69 across the run; each suite pass took 440–478 s.
- **Cause:** the box, not the branch. The streamer was not among the load's causes.
- **Fix:** none. Timings discarded as evidence; pass/fail retained.
- **Cost:** none to correctness, ~30 min of wall clock.
- **Recurs?** Situational.

---

## 10. Verification checkpoints

| Checkpoint | Integration SHA | Commits ahead of `main` | lint | typecheck | tests | Δ vs baseline |
|---|---|---|---|---|---|---|
| baseline (`main`) | `2aa4672e` | 0 | green | green | `0 failed / 2211 passed / 11 skipped` | — |
| 1 — +#580 +#646 | `3169f901` | 3 | green | green | `0 failed / 2231 passed / 5 skipped` | +20 passed, −6 skipped, **0 failed** |
| 2 — +#650 | `b2212959` | 9 | green | green | `0 failed / 2266 passed / 5 skipped` | +55 passed, −6 skipped, **0 failed** |
| 3 — +#651 | `081a7659` | 11 | green | green | `0 failed / 2269 passed / 5 skipped` | +58 passed, −6 skipped, **0 failed** |
| final — +#653 | `a6915110` | 16 | green | green | `0 failed / 2275 passed / 5 skipped` | +64 passed, −6 skipped, **0 failed** |

No checkpoint went red at any point. Every run was captured to a file in full rather than piped to `tail` — `--reporter=basic` no longer exists in vitest 4 and a tail hides the failure list.

---

## 11. Decisions, open questions, deferrals

| # | Decision | Alternatives considered | Reversible? | Owner |
|---|---|---|---|---|
| D1 | Exclude #475 (postcss) | include and resolve its conflict against `main` | yes — rebase it and re-run | user |
| D2 | Include #580 despite being a dependabot PR | exclude all dependabot as prior runs did | yes | user |
| D3 | Drop `e074d5ad` / `2c2e1b1c` / `d777d064` from the old INT rather than replay them | cherry-pick them onto the new branch | yes | this session — evidenced in §3 |
| D4 | Name the branch `integration/2026-08-20-open-prs` rather than reuse `…-08-18-…` | reuse the old name, force-pushing over it | yes, before the real run | **user — see below** |
| D5 | Judge diff scope by patch-id, not by file list | file list only, as the skill's step 6 says | n/a | this session |

| Open item | Why deferred | Next action | Owner | Tracked as |
|---|---|---|---|---|
| Branch naming for the real run | A new name leaves `…-08-18-…` on `origin` as a stale branch; reusing the old name means force-pushing it | user picks before flow C | user | this log |
| `npm ci` not re-run after #580 | The bump is semantic-release-only and touches nothing the suite imports | re-install after merging #580 in the real run if the bump is to be exercised | real run | §6 |
| #475 rebase | excluded as `DIRTY` | rebase onto `main`, let CI run, then reconsider | user | PR #475 |

---

## 12. Coverage gate

Per PR: every file in `git diff <merge-base(main,pr)> <pr-head> --name-only`, checked for presence on the branch, then blob-compared, then every added line checked for presence.

| PR | Files | Absent from branch | Blob differs (hand-checked) | Verdict |
|---|---|---|---|---|
| #580 | 1 | none | none | **complete** |
| #646 | 7 | none | 5 | **complete** — see false negatives |
| #650 | 9 | none | 3 | **complete** — see false negatives |
| #651 | 4 | none | 3 | **complete** — see false negatives |
| #653 | 4 | none | none | **complete** |

### False negatives, by name — the next run will hit these same ones

A differing blob is the expected state for any file more than one PR touched, or that `main` moved under. All eight were hand-verified:

- `src/server.ts`, `src/server-wiring.ts` — edited by #646, #650 **and** #651, and moved by `main`'s #654. Differing is correct; identical would be the bug.
- `docs/compatibility/tb-mobile.md` — edited by #646 and #650.
- `__tests__/ws-capabilities.test.ts` — edited by #646 and #651, plus ledger #1.
- `__tests__/server.test.ts` — edited by #646, then moved by `main`'s #654.

Line-level result: **1 128 substantive added lines checked; exactly 2 absent**, both the pre-union sides of ledger #1, each superseded by a line containing both symbols.

### Against the branch being replaced

`git diff --stat integration/2026-08-18-open-prs integration/2026-08-20-open-prs` → **3 files: `CHANGELOG.md`, `package.json`, `package-lock.json`.** Nothing under `src/` or `__tests__/` differs at all. The three differing files are the v1.64.0 release commit (`1.63.0` → `1.64.0`) and #580's lockfile bump — both intended. **No work on the replaced branch is missing from the new one**, including the three no-PR commits, which §3 showed are absorbed by `main`.

---

## 13. Risk and rollback

- **Backup ref / archive tag:** not required — flow A wrote nothing to `origin`. The branch being replaced, `integration/2026-08-18-open-prs` @ `2c2e1b1c`, is untouched on `origin` and additionally held locally at `backup/integration-2026-08-18-open-prs-2026-08-20-pre-rebase`.
- **Containment, asserted not assumed:**
  - `git ls-remote --heads origin | grep -c integration/2026-08-20-open-prs` → **0**
  - `git ls-remote --heads origin | grep -c integration/2026-08-18-open-prs` → **1**, still `2c2e1b1c`
  - all five PR heads on `origin` byte-identical to the fetched copies (`#580 59e269fb · #646 b17c556c · #650 94726308 · #651 acb679f9 · #653 be98a361`)
- **Abort mid-run:** `git rebase --abort` if mid-rebase, then `git checkout integration/2026-08-20-open-prs && git reset --hard <last checkpoint SHA>` from §10.
- **Discard entirely:** `git worktree remove ../tb-streamer-worktrees/int-rehearsal-2026-08-20 --force` and delete the local branches `integration/2026-08-20-open-prs`, `rebase/pr-*`, `refs/integration/pr/*`. Nothing off-box changes.
- **Blast radius if a resolution here were wrong:** ledger #1 is test-harness-only (`__tests__/ws-capabilities.test.ts`), so a wrong resolution costs a failing or falsely-passing WS capability test, not production behaviour. The set's production surface is `src/server.ts` / `src/server-wiring.ts` WS wiring, a new `host_pressure` broadcast, and the idle-kill hold path — a wrong merge there would show as a session that never holds, a subscriber that never drops, or a `host_pressure` frame that never fires.

---

## 14. Gaps in this log

- **Only this platform was exercised.** macOS 25.5.0 / arm64 / Node 24.15.0. The PRs' own CI covers Node 22, Node 24, and both macOS and Windows smoke; this rehearsal covers none of that. #650 in particular contains a Windows-specific code path (`feat(ws): derive Windows host load from cpu times`) that **was not executed here at all** — only its tests were, on macOS.
- **`npm ci` was not re-run after #580 merged**, so no checkpoint exercised the bumped dependency. Argued harmless in §6; not verified.
- **The build was never run.** `npm run build` (tsup, dual ESM/CJS, migration-folder copying) is not part of `npm run lint` or `npm test`. CI's `Build` job covers it per-PR but not for the merged result.
- **Timings are void.** Load 29.78 → 15.69 throughout; no duration in this log is evidence.
- **The 2026-08-18 oracle was consulted for one conflict only**, because only one conflict occurred. Its agreement is a genuine independent check on ledger #1 and says nothing about the rest.
- **`git cherry` was not trusted and should not be.** It marked all 14 old-INT commits as absent from `main` including #654, which had landed as a squash. Every claim about what is or is not on `main` in this log comes from content comparison instead.
- Section 15's elapsed times are wall-clock from the log's own entries, which on a loaded box measure the box.

---

## 15. Timeline

| Phase | Start | End | Elapsed |
|---|---|---|---|
| Scope, PR triage, decisions | 09:54 | 10:00 | ~6 min |
| Worktree + `npm ci` + native verification | 10:00 | 10:05 | ~5 min |
| Baseline on `main` | 10:05 | 10:12 | ~7 min |
| Cut + 5 merges + 4 checkpoints | 10:14 | 11:00 | ~46 min |
| Sweeps, coverage gate, containment | 11:00 | 11:06 | ~6 min |
| **Total** | 09:54 | 11:06 | **~72 min** |

Three biggest sinks: **the four full suite runs** (~30 min of pure waiting, all four green, unavoidable under "do not batch"), **host saturation** inflating each of them, and **O2's broken sweep** (~5 min, self-inflicted).

**Status: complete.**
