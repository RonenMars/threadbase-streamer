# Integration merge log — integration/2026-08-12-rehearsal (2026-08-12)

**Status:** complete
**Goal:** rehearse merging 7 open PRs (#521, #522, #532, #536, #537, #545, #546) into one branch, local-only, to produce a verified merge order and conflict ledger for a later real run.
**Operator:** Claude Code session **Repo:** tb-streamer **Log started:** 2026-08-12 23:04 IDT

---

## 1. Provenance and refs

| What | Ref | SHA | Note |
|---|---|---|---|
| Cut point | `origin/main` | `c76c257` | re-fetched immediately before cutting |
| Base PR branch | `fix/push-capability-surface` (#521) | `667027d` | earliest PR by `createdAt` — no stacking detected among the 7 |
| Integration branch | `integration/2026-08-12-rehearsal` | `c76c257` (not yet advanced) | |
| Backup of previous INT | — none | | no prior integration branch of this name existed |
| Archive tag | — none | | |
| Worktree | `../tb-streamer-worktrees/int-2026-08-12-rehearsal` | | own `npm ci` run, not copied |

### Environment provenance

| Item | Value |
|---|---|
| OS / arch | macOS, arm64 (darwin-arm64) |
| node / npm | v24.15.0 (matches `.nvmrc`) / npm 12.0.2 |
| `git` / `gh` | `/opt/homebrew/bin/git`; `gh` on PATH |
| `node_modules` | `npm ci` at `c76c257` |
| Native modules rebuilt | node-pty install script was **blocked** by npm 12's allowScripts gate, but the darwin-arm64 prebuild shipped in the package was already present (`node_modules/node-pty/prebuilds/darwin-arm64/pty.node`) — not a rebuild. better-sqlite3 built normally (`build/Release/better_sqlite3.node` present, script not blocked). |
| Host load at baseline | `uptime` → `load averages: 10.57 23.66 27.78` on a 10-core box — saturated. Confirmed via isolated re-run that 14/16 initial test failures were saturation artifacts (see §2). |

---

## 2. Baseline — the state of `main` before anything landed

| Check | Command | Result |
|---|---|---|
| lint | `npm run lint` | green (0 errors) |
| typecheck | included in `npm run lint` (`tsc --noEmit`) | green |
| tests (first full run, host at load 10.57/10 cores) | `npm test` | `16 failed / 1918 passed / 11 skipped` (1945 total) |
| tests (isolated re-run of the 5 failing files) | `npx vitest run <5 files>` | `2 failed / 40 passed` — 14 of the 16 failures did not reproduce in isolation (saturation artifacts) |
| tests (cors-middleware.test.ts alone, full isolation) | `npx vitest run __tests__/cors-middleware.test.ts` | `2 failed / 3 passed` — reproduces alone, confirmed real |

**Real baseline: 2 failed / 1943 passed / 11 skipped (1945 total, when run at low contention).**

Known-flaky before the run:
- `__tests__/cors-middleware.test.ts` — 2 tests timeout (`Error: Test timed out in 15000ms`) even in full isolation on this host, at `origin/main` @ `c76c257`:
  - `browser_cors in server.yaml > survives a redeploy: a browser_cors: yaml value enables CORS with no env var set`
  - `browser_cors in server.yaml > THREADBASE_ALLOW_BROWSER_CORS overrides a browser_cors: yaml value`
- Everything else that failed in the contended full run (`pair-endpoints.test.ts`, `security-hardening.test.ts`, `watch-for-jsonl.test.ts`, `webhook-update.test.ts`) passed clean on retest — treat as host-load noise, not a baseline defect. Any later checkpoint should be re-verified at low load before attributing a failure to a merge.

---

## 3. Scope — what is in, what is out

| PR | Title | Head branch | Head SHA | Base | Draft? | Mergeable | CI on PR |
|---|---|---|---|---|---|---|---|
| 521 | feat(push): report push capability so clients stop offering a feature that cannot work | `feat/push-capability-surface` | `667027d` | main | no | MERGEABLE (UNKNOWN in bulk query, individually MERGEABLE) | 10/10 SUCCESS |
| 522 | feat(cli): warn at boot when a bypass permission mode is active | `docs/security-posture-and-prompt` | `c4e8992` | main | no | MERGEABLE | 10/10 SUCCESS |
| 532 | docs: correct the stale CI-coverage claims in the handoff prompts [skip-ci] | `docs/stale-ci-claims` | `a42774d` | main | no | MERGEABLE | 10/10 SUCCESS |
| 536 | docs(architecture): record the structured session events design [skip-ci] | `docs/structured-session-protocol` | `500e643` | main | no | MERGEABLE | 10/10 SUCCESS |
| 537 | docs(plans): add viewport-relative cursor and server-side sub-status plans | `docs/agent-status-and-cursor-plans` | `c4e34b8` | main | no | MERGEABLE (mergeStateStatus BEHIND) | 10/10 SUCCESS |
| 545 | feat(push): gate Live Activity push behind a feature flag, off by default | `feat/live-activity-push-flag` | `770fc31` | main | no | MERGEABLE (UNKNOWN in bulk query) | 10/10 SUCCESS |
| 546 | feat(browse): return files alongside directories in /api/browse | `feat/browse-return-files` | `0f18476` | main | no | MERGEABLE (UNKNOWN in bulk query) | 10/10 SUCCESS |

- `mergeable`/`mergeStateStatus` from the bulk `gh pr list` all returned `UNKNOWN`; the individual `gh pr view` above is authoritative.
- No branch in this set lacked a remote counterpart — all 7 have CI history to read.

### Deliberate exclusions

| PR | Why excluded | Standing or one-off? |
|---|---|---|
| #548 | Draft, self-described as incomplete ("four verification gaps remain, tracked in #541"). CI red on both macOS and Windows smoke with 2 real assertion failures in its own code (protocol version mismatch in `pty-host-protocol.test.ts`; missing `statusSource` near `pty-manager.ts:1205` in `status-confidence.test.ts`). Confirmed no other PR in the set touches the failing files. User decision after review: drop it. | One-off — re-evaluate once #541's gaps are closed. |
| #475 | Dependabot (`postcss` bump) | Standing — user excluded all dependabot PRs for this run |
| #223 | Dependabot (`typescript` 6→7 major bump) | Standing — user excluded all dependabot PRs for this run |

### Extra branches included (non-PR)

— none

---

## 4. Order plan

**Planned order:** `#521 → #522 → #532 → #536 → #537 → #545 → #546` (chronological by `createdAt`; no stacking, no forced-order constraints found)

### Stacked PRs

— none (checked all 7×7 pairs via `git merge-base --is-ancestor`; none of the 7 heads is an ancestor of another)

### Forced-order constraints (not chronological)

— none (checked each PR body/comments for "depends on / blocked by / needs # / fixed by / after # / before # / stacked on / requires #" — no matches)

### Order changes made mid-run

— none yet

---

## 5. Action log (chronological)

### 23:04 — baseline established

- **Command:** `npm run lint && npm test` on `origin/main` @ `c76c257`
- **Result:** lint green; test `16 failed / 1918 passed / 11 skipped` at load 10.57/10-core, re-verified as `2 failed / 1943 passed / 11 skipped` at low contention (see §2)
- **Branch SHA after:** n/a (baseline only)
- **Note:** host saturation gotcha reproduced live; documented in §2 rather than treated as a merge-caused regression

### 23:19 — rebase + merge PR #521

- **Command:** `git checkout -B rebase/pr-521 refs/integration/pr/521 && git rebase integration/2026-08-12-rehearsal`
- **Result:** clean rebase, no conflicts
- **Branch SHA after:** `d3237eb` (merge commit, `--no-ff`)
- **Note:** diff scope confirmed identical to `gh pr diff 521 --name-only`


---

## 6. Per-PR record

### #521 — feat(push): report push capability so clients stop offering a feature that cannot work

| Field | Value |
|---|---|
| Head before / after rebase | `667027d` → `3745d8a` |
| Rebased onto | `integration/2026-08-12-rehearsal` tip (= `origin/main` `c76c257`, first PR) |
| Conflicts | — none |
| Diff scope after rebase | identical to `gh pr diff 521 --name-only` (6 files) |
| Integration SHA after merge | `d3237eb` |
| Verification | lint green · tests `2 failed / 1946 passed / 5 skipped` (1953 total) — the 2 failures are the known baseline `cors-middleware.test.ts` timeouts, no new failures |
| Obstacles | — none |
| Time | ~15 min (incl. checkpoint test run) |

### #522 — feat(cli): warn at boot when a bypass permission mode is active

| Field | Value |
|---|---|
| Head before / after rebase | `c4e8992` → (rebase/pr-522 head) |
| Rebased onto | integration tip after #521 (`d3237eb`) |
| Conflicts | — none |
| Diff scope after rebase | identical to `gh pr diff 522 --name-only` (3 files) |
| Integration SHA after merge | `304ef8e` |
| Verification | lint green · tests `2 failed / 1949 passed / 5 skipped` (1956 total) — same 2 known baseline failures, +3 new passing tests from this PR |
| Obstacles | — none |
| Time | ~10 min |

### #532 — docs: correct the stale CI-coverage claims in the handoff prompts [skip-ci]

| Field | Value |
|---|---|
| Head before / after rebase | `a42774d` → (rebase/pr-532 head) |
| Rebased onto | integration tip after #522 (`304ef8e`) |
| Conflicts | — none |
| Diff scope after rebase | identical to `gh pr diff 532 --name-only` (3 files, all `.md`) |
| Integration SHA after merge | `f5a561b` |
| Verification | lint green · **test suite skipped for this checkpoint** — confirmed via `git diff --name-only` that every changed file is `.md` (matches repo's own `[skip-ci]` policy for docs-only changes); will still be covered by the final full-suite run before the coverage gate |
| Obstacles | — none |
| Time | ~5 min |

### #536 — docs(architecture): record the structured session events design [skip-ci]

| Field | Value |
|---|---|
| Head before / after rebase | `500e643` → (rebase/pr-536 head) |
| Rebased onto | integration tip after #532 (`f5a561b`) |
| Conflicts | — none |
| Diff scope after rebase | identical to `gh pr diff 536 --name-only` (1 new file, `.md`) |
| Integration SHA after merge | `48940a2` |
| Verification | lint green (not re-run separately — single new markdown file, no code touched) · test suite skipped, docs-only |
| Obstacles | — none |
| Time | ~5 min |

### #537 — docs(plans): add viewport-relative cursor and server-side sub-status plans

| Field | Value |
|---|---|
| Head before / after rebase | `c4e34b8` → (rebase/pr-537 head) |
| Rebased onto | integration tip after #536 (`48940a2`) |
| Conflicts | — none |
| Diff scope after rebase | identical to `gh pr diff 537 --name-only` (4 new files, all `.md`) |
| Integration SHA after merge | `83769b5` |
| Verification | docs-only, test suite skipped |
| Obstacles | rebase's `--update-refs` moved a local branch ref (`docs/agent-status-and-cursor-plans`) that happened to point at the rebased commit — local-only side effect in the throwaway worktree, not published anywhere |
| Time | ~5 min |

### #545 — feat(push): gate Live Activity push behind a feature flag, off by default

| Field | Value |
|---|---|
| Head before / after rebase | `770fc31` → (rebase/pr-545 head) |
| Rebased onto | integration tip after #537 (`83769b5`) |
| Conflicts | — none (textual) |
| Diff scope after rebase | identical to `gh pr diff 545 --name-only` (5 files) |
| Integration SHA after merge | `6511ce0` |
| Verification | lint green · tests `5 failed / 1949 passed / 5 skipped` (1959 total) at first run → isolated re-run of the 3 non-baseline failures showed `watch-for-jsonl.test.ts` was saturation noise (passes alone) but **`push-capability.test.ts` × 2 is a real, reproducing failure** — see §8 |
| Obstacles | O1 — semantic conflict between #521 and #545, see §8 |
| Time | ~25 min (incl. isolation re-runs and root-cause read) |

---

## 8. Semantic conflicts — problems git did *not* flag

| # | Where | What was silently lost/changed | Found how | Fix |
|---|---|---|---|---|
| 1 | `__tests__/push-capability.test.ts` (added by #521) vs. `src/server.ts:1427` (changed by #545) | #521's `describe("with APNs credentials")` block sets `APNS_KEY`/`APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_BUNDLE_ID` and expects `liveActivity: true` from `/api/info` and `/api/push/health`. #545 gated `liveActivityNotifier` init behind the new `liveActivityPush` feature flag (default off), so `deps.liveActivityPushEnabled()` is now `false` with credentials alone — the test's assumed default is stale. No git conflict (different regions of different files), no `tsc` error (both sides type-check), only caught by the test checkpoint after merging both. | Not fixed in this rehearsal (no code changes made outside PR content). Two independent fixes possible: (a) update `push-capability.test.ts`'s "with APNs credentials" block to also enable the `liveActivityPush` feature flag (env var or `--feature`) before asserting `liveActivity: true`, since #545 established that flag as the real precondition; or (b) leave as a known forced-order note for the real run — merge #545 and then #521's test fix together, or patch #521's test on the integration branch only. Flagged for the user to decide; not resolved here. |

**Sweeps run:**
- Grepped `describePushCapability` call sites (`misc.routes.ts`) — only the one call site, correctly wired to `deps.liveActivityPushEnabled()`. Clean.
- Confirmed CLAUDE.md's two independent additions (from #521 and #545) both survived the merge intact — clean, no blanket per-file resolution was needed (git auto-merged both hunks).
- No blanket (`--ours`/`--theirs`) per-file resolutions used anywhere in this run so far — none to list.

---

## 9. Obstacles and detours

### O1 — #521's `push-capability.test.ts` asserts a default #545 changed

- **Symptom:** After merging #545, 2 tests in `push-capability.test.ts` (added by #521) fail: `liveActivity` reported `false` where the test expects `true`.
- **Cause:** #545 moved the Live Activity default from "on given APNs credentials" to "off unless the `liveActivityPush` feature flag is also set." #521's test only sets credentials, not the flag — it encodes the pre-#545 default.
- **Fix:** not applied in this rehearsal. See §8 #1 for the two candidate fixes.
- **Cost:** ~15 min to isolate from saturation noise and read both PRs' code to confirm root cause.
- **Recurs?** one-off for this specific PR pair, but the *pattern* (a later PR narrows a default an earlier PR's test assumed) is worth a standing sweep: whenever two PRs in a set both touch the same feature-flag-gated subsystem, diff their tests against each other's default-changing code before trusting a green checkpoint.

### O2 — `--update-refs` rebase side effect

- **Symptom:** rebasing PR #537 printed `Updated the following refs with --update-refs: refs/heads/docs/agent-status-and-cursor-plans`.
- **Cause:** a local branch in this worktree happened to point at the commit being rebased; modern git's `--update-refs` (default on) moves it along.
- **Fix:** none needed — local-only, throwaway worktree, never pushed.
- **Cost:** ~1 min to notice and confirm it was harmless.
- **Recurs?** yes, whenever a local branch ref coincides with a rebased commit in the worktree. Harmless in a throwaway worktree; worth remembering if the worktree is ever reused for something else.

### #546 — feat(browse): return files alongside directories in /api/browse

| Field | Value |
|---|---|
| Head before / after rebase | `0f18476` → (rebase/pr-546 head) |
| Rebased onto | integration tip after #545 (`6511ce0`) |
| Conflicts | — none (textual; `src/server.ts` touched by both #545 and #546, merged clean) |
| Diff scope after rebase | identical to `gh pr diff 546 --name-only` (3 files) |
| Integration SHA after merge | `f855aed` |
| Verification | lint green · full-suite tests `5 failed / 1952 passed / 5 skipped` (1962 total) — 2 known baseline (`cors-middleware`) + 2 known #521/#545 semantic conflict (`push-capability`, see §8 #1) + **1 new: `live-activity-flag.test.ts`** |
| Obstacles | O3 — see below; not conclusively attributed to #546's own change, flagged for follow-up |
| Time | ~30 min (incl. 5 isolated re-runs to characterize the new flake) |

### O3 — `live-activity-flag.test.ts` is slow and intermittently hook-times-out, first seen after #546

- **Symptom:** a 3-assertion file that should run in well under a second instead takes 60–90s wall-clock on every run, isolated or not, and intermittently throws `Error: Hook timed out in 30000ms` in `afterEach` on `server?.close()`. Across 5 isolated runs: 2/5 clean, 3/5 with 1–2 of the 3 tests failing (always the same `afterEach` timeout, never an assertion mismatch).
- **Cause:** not conclusively identified. It is **not** simple host-saturation noise in the pattern seen elsewhere in this run — those (cors-middleware aside) passed clean and fast every time once isolated; this file is slow *every* time, at load ranging from 6.02 to 10.57. It was not present as a failure at the #545 checkpoint (before #546 merged), but #545 is also where the test file was added, and #545's own checkpoint only ran the full suite once — it may simply not have been observed rather than not have existed. Did not investigate further inside `server.close()` / `initLiveActivityPush()` teardown path.
- **Fix:** not applied — needs a focused look at `StreamerServer.close()`'s teardown when `disableDb: true` + a feature-flag-only boot, ideally profiled independent of this rehearsal.
- **Cost:** ~20 min across repeated isolated runs trying to characterize it.
- **Recurs?** unknown — flag for the PR author (#545) to check before the real run, and re-measure at low host load as a first step.

---

## 10. Verification checkpoints

| Checkpoint | Integration SHA | Commits ahead of `main` | lint | typecheck | tests | Δ vs baseline |
|---|---|---|---|---|---|---|
| baseline (`main`) | `c76c257` | 0 | green | green | `2 failed / 1943 passed / 11 skipped` (low-load, isolated) | — |
| after #521 | `d3237eb` | 2 | green | green | `2 failed / 1946 passed / 5 skipped` | +0 failed (same 2 baseline), +3 net new tests |
| after #522 | `304ef8e` | 4 | green | green | `2 failed / 1949 passed / 5 skipped` | +0 failed, +3 net new tests |
| after #532 | `f5a561b` | 6 | green | (test skipped — docs-only, confirmed via diff scope) | — | — |
| after #536 | `48940a2` | 8 | (not re-run — single new `.md` file) | — | — | — |
| after #537 | `83769b5` | 10 | (not re-run — new `.md` files only) | — | — | — |
| after #545 | `6511ce0` | 12 | green | green | `5 failed / 1949 passed / 5 skipped` → isolated: 2 baseline + **2 new real** (`push-capability.test.ts`, §8 #1) + 1 saturation noise (`watch-for-jsonl`, cleared on retest) | +2 real new failures (semantic conflict with #521) |
| after #546 (final) | `f855aed` | 14 | green | green | `5 failed / 1952 passed / 5 skipped` (1962 total) → isolated: 2 baseline + 2 known #521/#545 conflict + **1 new, unresolved** (`live-activity-flag.test.ts`, O3) | +1 new flake/slow test, cause not conclusively identified |

---

## 12. Coverage gate

For each PR: `gh pr diff <n> --name-only` vs `git log HEAD -- <file>` on the integration branch.

| PR | Files reported missing | Hand-verified verdict |
|---|---|---|
| #521 | none (6/6 present) | confirmed — every merge in this run was a clean rebase with diff-scope check at merge time, no whole-file resolutions used |
| #522 | none (3/3 present) | confirmed |
| #532 | none (3/3 present) | confirmed |
| #536 | none (1/1 present) | confirmed |
| #537 | none (4/4 present) | confirmed |
| #545 | none (5/5 present) | confirmed |
| #546 | none (3/3 present) | confirmed |

No prior integration branch of this name existed, so there is nothing to diff against for "what the old branch had that this one doesn't."

---

## 11. Decisions, open questions, deferrals

| # | Decision | Alternatives considered | Reversible? | Owner |
|---|---|---|---|---|
| 1 | Exclude PR #548 from this run | merge and accept red checkpoint; pause until fixed | yes — re-add once #541's gaps are closed | user |
| 2 | Exclude both dependabot PRs (#475, #223) | include them | yes — standing exclusion, can be revisited per-run | user |
| 3 | Include draft PR #521... (n/a, no drafts remained after #548 excluded) | — | — | — |
| 4 | Log the #521/#545 semantic conflict (§8 #1) and continue rather than pause | pause the rehearsal to fix #521's test first | yes — the real run can still be paused before it replays this | user |

| Open item | Why deferred | Next action | Owner | Tracked as |
|---|---|---|---|---|
| #521's `push-capability.test.ts` "with APNs credentials" block asserts a default #545 removed | rehearsal doesn't modify PR content | update the test to also set the `liveActivityPush` feature flag before asserting `liveActivity: true`, or accept as a documented forced-order note for the real run | user / PR author | this log, §8 #1 |
| `live-activity-flag.test.ts` is slow (60–90s for 3 assertions) and intermittently hook-times-out | root cause not identified in this rehearsal | profile `StreamerServer.close()` teardown under `disableDb: true` + flag-only boot, independent of this integration | user / PR author (#545) | this log, §9 O3 |

---

## 13. Risk and rollback

- **Backup ref / archive tag:** none created — this is flow A (rehearsal), nothing was pushed to `origin`, so there is nothing on the remote to protect. `origin/main` was never touched.
- **Abort mid-run:** was not needed. Had it been: `git worktree remove ../tb-streamer-worktrees/int-2026-08-12-rehearsal --force` and `git branch -D integration/2026-08-12-rehearsal` from the primary checkout, plus `git update-ref -d refs/integration/pr/<n>` for each fetched PR-head ref.
- **Restore:** n/a — nothing was pushed or deleted upstream.
- **Blast radius:** none in this run (local-only). For the real run (flow C), the blast radius would be: force-pushing rebased PR heads for #521/#522/#532/#536/#537/#545/#546 (un-restacks nothing, since none were stacked), and eventually merging into `main` — none of that happened here.

---

## 14. Gaps in this log

- The full test suite was **not re-run** after #532, #536, #537 individually — confirmed via `git diff --name-only` that each touched only `.md` files, and skipped the ~6-7 min full suite run each time. If any of those three PRs had a hidden non-doc side effect not visible in the PR's own diff (not the case here, verified), this log would not show it until the #545 checkpoint.
- The `live-activity-flag.test.ts` slowness (O3) was characterized (5 isolated runs) but not root-caused. The log records the symptom and a next action, not a diagnosis.
- Host load was checked with `uptime` at each major step but not continuously monitored; some of the "isolated re-run passes clean" conclusions rest on a single confirming run rather than several.
- No sweep was run for behavior-flag/env-var wiring beyond `liveActivityPush` (§8) — the other flags/env vars touched by this set (`describePushCapability`'s consumers, `browse.ts`'s new file-listing option) were checked only by their own PR's tests passing, not by an independent cross-file grep.
- This run never reached flow C (a real push). Everything about force-push mechanics, backup refs, and re-verifying preconditions before a real run is untested by this rehearsal — it only proves the merge order and conflict set are known-good locally.

---

## 15. Timeline

| Phase | Start | End | Elapsed |
|---|---|---|---|
| Scope + preflight (flow/scope questions, PR list, CI checks, #548 investigation) | 22:30 | 23:04 | ~34 min |
| Baseline (`npm ci`, lint, test, saturation diagnosis) | 23:04 | 23:19 | ~15 min |
| Merge #521 → #546 (7 PRs, checkpoints) | 23:19 | 00:41 | ~82 min |
| #545/#546 anomaly investigation (§8, O3) | 00:41 | 00:47 | ~6 min |
| Coverage gate + log write-up | 00:47 | (ongoing) | |

**Total wall-clock so far:** ~2h20m. **Three biggest time sinks:** (1) full-suite test checkpoints at ~60–90s per run × many isolation re-runs (baseline alone took 3 runs to characterize); (2) the #521/#545 semantic-conflict root-cause read; (3) the O3 flaky-test characterization (5 isolated runs, still unresolved).

---

## 16. How to merge this into `main`

*Added 2026-08-13. The branch this section refers to is `integration/2026-08-12-rehearsal-v2` @ `e877cf2`, which supersedes the `f855aed` recorded in §1 and §12 — v2 was rebuilt after the O1 fix landed and is on `origin`, 17 commits ahead of `main` @ `c76c257`.*

**Do not merge the integration branch itself.** It carries seven `integrate PR #NNN: …` merge commits, and this repo requires a linear `main` with one squashed commit per PR. The branch is evidence that the seven compose cleanly and in what order — it is not a delivery vehicle. Merge the seven PRs individually in the rehearsed order, then delete the branch.

### Preconditions

| Check | Command | Expected |
|---|---|---|
| All seven still open | `gh pr list --state open --json number,isDraft` | #521, #522, #532, #536, #537, #545, #546 present, none draft |
| #521 carries the O1 fix | `git log origin/main..origin/feat/push-capability-surface --oneline` | includes `test(push): pin the liveActivityPush flag in the capability test` (`445ddd7`) |
| Mergeability is real, not `UNKNOWN` | `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup` | per-PR, never the bulk `gh pr list` (§9 rules learned) |
| Host is quiet | `uptime` | load below core count, or every test result is unreadable |

**O1 / §8 #1 is resolved at source** as of 2026-08-13, which changes the plan this log left open. #521's head is `445ddd7`, whose second commit pins the `liveActivityPush` flag inside its own test. The conflict no longer depends on merge order, and #545 may land before or after #521. The §11 open item and §8's "flagged for the user to decide" are closed by that commit.

### Order

`#521 → #522 → #532 → #536 → #537 → #545 → #546`

Chronological by `createdAt`, which this rehearsal confirmed is textually conflict-free at every step. With O1 fixed at source there is no remaining hard ordering constraint, so another order is legal — but this is the only one rehearsed end to end.

### Per PR, one at a time

```bash
gh pr checks <n>                                  # required checks green before touching anything
git fetch origin
git checkout <head-branch> && git rebase origin/main
git push --force-with-lease                       # never plain --force
gh pr merge <n> --squash --delete-branch
```

Wait for each merge to land before starting the next. Every merge advances `main`, so the next PR is behind and needs its own rebase — this is why the rule is one PR at a time and never in parallel. Squash titles must be conventional-commit compliant and carry no AI attribution. If CI is red on a flaky or infra failure, re-run it once; if the re-run still fails, stop and report rather than merging red.

### After all seven land

```bash
git push origin --delete integration/2026-08-12-rehearsal-v2
git worktree remove ../tb-streamer-worktrees/int-2026-08-12-rehearsal
```

Then the `src/server.ts` split stack rebases onto the new `main` and opens, bottom first. Only the bottom branch targets `main`; each one above targets the branch below it.

**The authoritative order for all ten refactor branches, and the `gh stack` commands to open them, are in [§17](#17-opening-the-ten-prs--canonical-order).** The table below covers stack A only and is kept for context.

| Branch | Base | Head |
|---|---|---|
| `refactor/server-split-1-http-helpers` | `main` | `cd3c1bf` |
| `refactor/server-split-2-scanner-manager` | split-1 | `83d426a` |
| `refactor/server-split-3-external-tails` | split-2 | `4e5f176` |
| `refactor/server-split-5-session-watchers` | split-3 | `26cd565` |
| `refactor/server-split-6-registry-boot` | split-5 | `7414246` |
| `refactor/server-split-4-conversation-handlers` | split-6 | `3750f35` |
| `refactor/server-split-8-session-handlers` | split-4 | `ccd3ca3` |
| `refactor/server-split-7-wiring` | split-8 | `e011af9` |

Rebase split-1 onto `main` first, then each branch above onto the one below, force-pushing with `--force-with-lease` after each. GitHub retargets a stacked PR's base automatically when that base merges, but it does **not** rebase the commits — the diff shows unrelated changes until you do.

> **Superseded — all eight landed on 2026-08-14.** The branches and SHAs above no longer exist. See [§18](#18-outcome--what-actually-landed).

### Split stack — PR 1 and PR 2, what they are and how to land them

Both are **pure mechanical moves** from `docs/plans/2026-07-12-server-ts-split.md`: no endpoint, response-shape or status change, so tb-mobile is untouched. `ApiDeps` is byte-identical in both. Neither has a pull request open yet — that is deliberate, so their diffs contain only their own code once `main` carries the seven.

| | PR 1 — `refactor/server-split-1-http-helpers` @ `cd3c1bf` | PR 2 — `refactor/server-split-2-scanner-manager` @ `83d426a` |
|---|---|---|
| Base | `main` (after the seven land) | `refactor/server-split-1-http-helpers` |
| New file | `src/api/handlers/http-helpers.ts` (173 lines) | `src/scanner-manager.ts` (554 lines) |
| `src/server.ts` | 6,557 → 6,400 | 6,400 → 5,965 |
| Diff | 2 files, +183 / −167 | 3 files, +693 / −578 |
| Moves | `classifyResumability`, `conversationToResumableSession`, `json`, `writeHonoResponse`, `intParam`, `parseSessionListQuery`, `readBody` | 9 fields + 16 methods: scanner lifecycle, freshness state, and the cache↔disk reconcile |

**PR 1 also reunites a doc comment** that had been spliced around `waitForProcessExit`'s since `8aec961` (#74) — a comment-only change, unavoidable because the move separates the two functions.

**PR 2 also edits `__tests__/server.test.ts`** (164 lines): scanner reach-ins move behind a `ScannerManagerView` cast, and four `vi.spyOn` targets are repointed. That test churn is expected and is not a behaviour change.

**One semantic detail worth not re-breaking.** `ScannerManager.markStaleOrDrop()` preserves an either/or: arm the stale flag when a scan exists, drop the scanner when it does not — never both. Doing both would discard a live scanner index on every JSONL bind, a silent performance regression no test asserts on.

#### Verification already done

| | lint | full serial suite | Δ vs the run below it |
|---|---|---|---|
| PR 1 | green | `15 failed / 1939 passed` (1962), 1259s | all 15 pre-existing — 2 `cors-middleware`, 2 `push-capability` (O1, since fixed at source), 7 `pair-endpoints`, 4 `security-hardening` |
| PR 2 | green | `30 failed / 1927 passed` (1962), 1781s | **0 assertion failures anywhere** — every failure is a timeout |

PR 2's checks that matter:

- `server.test.ts` — its only modified test file — **0 failures**.
- `push-capability` absent from the failures, confirming O1's source fix holds on this stack.
- `watch-for-jsonl` and `discovery-cache` failed in the full run but **do not reproduce** in a re-run — checked specifically because `watchForJsonl` contains a `markStaleOrDrop()` call site PR 2 created.

PR 2's higher failure count is host load, not code: that run took 41% longer than PR 1's because VS Code's plugin host hit 315% CPU mid-run, driving load to 23 on a 10-core box. The two counts are not comparable and should not be read as a regression.

#### Landing them

```bash
# after the seven have landed and main has advanced
git fetch origin
git checkout refactor/server-split-1-http-helpers
git rebase --onto origin/main e877cf2      # NOT `git rebase origin/main` — see §17
git push --force-with-lease
gh pr create --base main --head refactor/server-split-1-http-helpers

# only after PR 1 merges
git checkout refactor/server-split-2-scanner-manager
git rebase --onto origin/main <PR 1's pre-rebase head>
git push --force-with-lease
gh pr create --base main --head refactor/server-split-2-scanner-manager
```

While PR 1 is open but unmerged, PR 2 targets `refactor/server-split-1-http-helpers` instead of `main`. Either works; the sequential form above keeps each diff to its own code with no stacked-base retargeting to reason about.

Per-PR gate before merging either: `npm run lint` green, `git diff src/api/types/api-deps.ts` empty, no changes under `__tests__/contracts/` or `__tests__/e2e/`, and `server.ts` only shrinks.

### Split stack — PRs 3, 5, 6 and 4, built 2026-08-13

Same discipline as PR 1 and PR 2: pure mechanical moves, `ApiDeps` type byte-identical, opened only once `main` carried the seven. They merged on 2026-08-14 as #566, #567, #568 and #569.

| | PR 3 `…split-3-external-tails` @ `4e5f176` | PR 5 `…split-5-session-watchers` @ `26cd565` | PR 6 `…split-6-registry-boot` @ `7414246` | PR 4 `…split-4-conversation-handlers` @ `3750f35` |
|---|---|---|---|---|
| New file | `src/external-tails.ts` (269 L) | `src/session-watchers.ts` (410 L) | `src/session-registry-boot.ts` (537 L) | `src/api/handlers/conversations.handlers.ts` (1,049 L) |
| Moves | the 9 external-tail methods | `linkSessionToProject`, `watchConversationFile`, `readFirstLineSessionId`, `watchForJsonl`, `watchForCodexRollout` | the 8 boot-registry methods | the 12 conversation read handlers |
| `src/server.ts` | 5,965 → 5,777 | → 5,456 | → 5,024 | → 4,087 |
| Diff | 3 files, +314 / −233 | 3 files, +450 / −361 | 4 files, +587 / −472 | 4 files, +1,113 / −997 |
| Tests touched | `external-live-tails` | `watch-for-jsonl` | `auto-resume-on-boot`, `server.test.ts` | `server.test.ts`, `resume-cwd-from-jsonl` |

**Cumulative: `src/server.ts` is down from 6,557 to 4,087 lines — 2,470 removed across PRs 1–6.**

#### How they were built, and why the order is what it is

PRs 3, 5 and 6 were built **concurrently** in three separate worktrees, each with its own `npm ci` (never a symlinked `node_modules` — that was tried once during PR 2 and produced a worktree where vitest could not resolve Node builtins on every file, an hour lost to a scaffolding fault that looked like a code failure). They parallelize because none of the three touches the `ApiDeps` object literal and their three regions do not overlap.

PR 4 could not join them: it retargets eight `ApiDeps` entries, and two agents rewriting the same object literal conflict on every entry. PRs 8 and 7 are in the same class and run strictly sequentially after it, PR 7 last because it moves the literal itself and every earlier PR shrinks it first.

The three parallel branches started as **siblings** on PR 2's head, then were chained into a stack (3 → 5 → 6) once built. Siblings would have deferred the same rebases to merge time and left PR 4 with no single branch to sit on.

#### The one conflict, and what it teaches

PR 5 rebased onto PR 3 clean. **PR 6 onto PR 5 produced three conflicts, one of them 860 lines**: PR 5 had rewired a `watchConversationFile` call site at line 1801, which sits *inside* the 431-line block PR 6 deletes wholesale. Git cannot reconcile "modified" against "deleted" and emitted both versions.

Resolution was verified rather than guessed — diffing PR 5's side against the base showed that single call site was the *only* difference across the whole region, which is what made deleting the block provably safe. The wiring then had to be carried across by hand: `SessionRegistryBoot`'s `watchConversationFile` dep pointed at `this.watchConversationFile`, which PR 5 had moved, so it became `this.sessionWatchers.watchConversationFile`. `tsc` catches that one, but only because the method genuinely vanished.

**The general rule this gives:** when one PR in a stack deletes a region another PR edits, the conflict is not a merge nuisance — it is the signal that a cross-PR dep needs rewiring. Resolve by diffing the two sides to prove what the edit actually was, never by picking a side.

#### Verification applied to each

Every branch was checked independently of the agent that built it: `tsc --noEmit` exit 0, `biome check` clean, `git diff src/api/types/api-deps.ts` empty, nothing under `__tests__/contracts/` or `__tests__/e2e/`, and `server.ts` only shrinking.

Beyond that, **every moved method body was diffed against its original** under a normalization that undoes only the declared rebinds (`private`, `this.` → `this.deps.`). Results:

| PR | Normalized diff | Explanation |
|---|---|---|
| PR 3 | 2 lines | `cacheMonitor.deferUnlink` → `cacheMonitor?.deferUnlink` (TS narrowing does not survive a thunk call); one signature reflow biome forces |
| PR 5 | 2 lines | two biome re-wraps caused by `this.X` → `this.deps.X` pushing lines over the width |
| PR 6 | **0 lines** | byte-identical across all 275 normalized lines |
| PR 4 | 6 lines | one signature reflow on `handleSearchTarget`; **0 across the other 11 methods**, including the 365-line `handleGetConversation` |

PR 4 additionally got a **wiring check that `tsc` cannot perform**: the `ApiDeps` literal has 58 keys before and after in the same order, exactly 8 retargeted, and every retargeted entry still resolves to a method of its own name. A mis-pointed entry type-checks fine whenever two handlers share a signature, so name-preservation is the only real guard.

Tests run at the stack tip after the chain was assembled: `auto-resume-on-boot`, `external-live-tails`, `server.test.ts` (163 passed) and `watch-for-jsonl` (7 passed). PR 4 ran 310 targeted tests across conversations, ETag, search and resume paths, 0 failures.

#### Landing them

```bash
# only after PR 2 has merged
git checkout refactor/server-split-3-external-tails
git rebase --onto origin/main <PR 2's pre-rebase head>   # NOT `git rebase origin/main` — see §17
git push --force-with-lease
gh pr create --base main --head refactor/server-split-3-external-tails
# repeat for split-5, split-6, split-4, then split-8 and split-7
```

This hand-chained form is the fallback. **Prefer `gh stack` — see [§17](#17-opening-the-ten-prs--canonical-order)**, which opens all eight in one command with the bases already chained.

Merge one at a time and **re-grep line numbers between merges** — every merge shifts them, and the next branch's targets go stale immediately. Stale line numbers are what made the original split plan unusable.

### Split stack — PRs 8 and 7, the sequential tail

| | PR 8 `…split-8-session-handlers` @ `ccd3ca3` | PR 7 `…split-7-wiring` @ `e011af9` |
|---|---|---|
| Base | split-4 | split-8 |
| New file | `src/api/handlers/sessions.handlers.ts` (1,547 L) | `src/server-wiring.ts` (701 L) |
| Moves | the 18 session lifecycle handlers | the `ConversationWatcher` + `LiveSessionManager` inline callbacks and the `ApiDeps` assembly, as three named factories |
| `src/server.ts` | 4,087 → 2,881 | → **2,501** |
| Diff | 5 files, +1,683 / −1,334 | 2 files, +782 / −461 |
| Tests touched | `auto-resume-on-boot`, `jsonl-question-suppression`, `permission-broadcast-dedup` | **none** |

**Final: `src/server.ts` 6,557 → 2,501 — 4,056 lines removed, 62% of the file, across seven PRs and eight extracted modules** (`http-helpers`, `scanner-manager`, `external-tails`, `session-watchers`, `session-registry-boot`, `conversations.handlers`, `sessions.handlers`, `server-wiring`).

PR 7 was deliberately scheduled last because it moves the `ApiDeps` literal itself, and every earlier PR shrank the callback bodies inside it first. It is also the only PR in the series that needed no test edits at all — by then every reach-in had already been repointed by the PR that moved its target.

#### Verification

| PR | Moved bodies | `ApiDeps` | Tests |
|---|---|---|---|
| PR 8 | 18 methods, **verbatim** bar 2 biome reflows — includes the 175-line `resumeSession` with its collision/409 logic | 58 keys, same order, 14 retargeted, 0 miswired | `server.test.ts` 142/142 |
| PR 7 | callbacks byte-identical; one line changed shape (see below) | 62 keys, same order, 0 miswired; `apiKey` still a live getter | 191/191 across WS, boot, watcher-error and permission files |

PR 7's single shape change: `onNewLineSpans` opened `if (!this.cache) return; const cache = this.cache;`, and with `cache` now a thunk it becomes `const cache = deps.cache(); if (!cache) return;` — guard and capture swapped so TS narrows without a cast. Same two reads, same early return.

The `apiKey` entry is worth calling out because it is the one place where a mechanical move could have silently broken a live behaviour: it was a getter (`get apiKey() { return self.apiKey; }`) specifically so `rotateApiKey()` takes effect without a restart. It is still a getter, now reading a thunk. A move that flattened it to a captured value would type-check, pass every test, and quietly break key rotation in production.

#### A false diagnosis worth remembering

PR 8's agent reported 32 failures in `server.test.ts`, attributed them to a `better-sqlite3` `NODE_MODULE_VERSION` mismatch (claiming Node 24 needs 147 against an installed 137), and concluded they were pre-existing because the same count appeared at base.

**All of it was wrong.** Node v24.15.0 reports `MODULE_VERSION` **137** — the installed build is correct, and the module opens and queries fine. `server.test.ts` passes 142/142 at base *and* with the change. The failures were transient, almost certainly from testing a mid-edit tree or during the agent's own stash/restore.

Its conclusion — "not caused by my change" — happened to be right, which is what made it dangerous: a plausible mechanism, a real-looking number, and a self-verification against its own stash. **Re-run a suspicious file in isolation from a genuinely clean tree before accepting any diagnosis attached to it**, and treat "same failure count at base" as unverified until the base is a checkout you did not produce by stashing.

A related monitoring trap from the same run: a progress sampler caught the worktree mid-stash and reported a clean tree at the base line count. That reading is indistinguishable between *not started*, *mid-verification*, and *work destroyed* — `git stash list` is what separates them, not the line count.

### Follow-up landed: shared PTY helpers

`refactor/pty-shared-helpers` @ `bf6ba11`, branched from `origin/main` and **independent of the split stack** — `pty-manager.ts` and `codex-pty-runner.ts` are byte-identical across `main`, the integration branch and all eight split branches, so this lands on its own schedule.

New `src/pty-shared.ts` (80 L) holds `digestBytes`, `loadPty`, `createScreen`, `stripAnsi` and the `InternalSession` shape, plus the three screen-geometry constants `createScreen` reads. `pty-manager.ts` 1,263 → 1,206; `codex-pty-runner.ts` 1,353 → 1,300; net −131 / +21 across the two. Lint green, 265 tests passing across 30 PTY/Codex/gate files, no test file changed.

All five were verified code-identical in both files before merging (ten comparisons, zero differences); they had drifted only in their comments. The four duplicated constants were checked too — `PTY_COLS` 120, `PTY_ROWS` 40, `SCREEN_SCROLLBACK` 1000, `INPUT_HISTORY_MAX` 50 in both. **That check was the point:** had the geometry differed between providers, sharing `createScreen` would have silently changed one provider's screen grid, and nothing downstream would have reported it. `INPUT_HISTORY_MAX` was left duplicated — nothing forces it to move.

The two classes are **not** merged and should not be. Their detection logic is genuinely provider-specific: Claude uses OSC 777 plus prompt markers, Codex uses rendered status-bar predicates and no OSC at all. Only the plumbing is shared.

#### `grep` is shadowed in this shell — it produces silent false negatives

The first pass at this concluded the duplication **did not exist**, because `grep` reported no matches for all five names in `pty-manager.ts`. It was wrong. `command -v grep` returns a bare name rather than a path, and the shadowed version silently exited 1 with no output for that file while working normally on the other one. `/usr/bin/grep` then found all five at exactly the lines predicted.

What caught it was a contradiction between two tools: `tail` printed `stripAnsi` from a file `grep` swore was clean. Without that accident the conclusion would have been "already resolved, nothing to do" — a plausible, clean, entirely wrong answer with no error anywhere.

This is the same family as the `git`-function shadowing already documented for this machine. **Use absolute binaries (`/usr/bin/grep`, `/opt/homebrew/bin/git`, `/usr/bin/wc`) in scripted checks**, and treat an absence-of-matches result as unproven until a second tool agrees.

A second instance of the same trap surfaced within the hour, deleting the `threadbase-wfj-*` leftovers: a shell glob over `~/.claude/projects` returned **zero** matches, because those directories are path-encoded starting with `-` and the expanded glob was read by `ls` as flags, with the error swallowed by `2>/dev/null`. `find` found 1,261. **Prefer `find -name` over globs for generated names**, and never route a discovery command's stderr to `/dev/null`.

### Follow-up landed: Codex screen predicates moved for symmetry

`refactor/codex-question-predicates` @ `9285a63`, stacked on `refactor/pty-shared-helpers` — stack B's top layer.

New `src/services/questions/codexScreen.ts` (211 L) holds Codex's ten `CODEX_*` regexes and constants, `CodexBlockingPrompt`, `parseCodexNumberedOptions`, `detectCodexBlockingPrompt`, the four `codexScreen*` predicates and `gateCard`. `codex-pty-runner.ts` 1,300 → 1,114 (−186). The moved code is **byte-identical**, 180/180 lines. Lint green, 289 tests passing across 34 Codex/PTY/gate files.

This is the symmetry fix the split brief flagged as optional: Claude's equivalents (`detectPermissionGate`, `detectQuestionFromScreen`, `detectShellPrompt`, `parseStatusLine`) already lived in that directory, and Codex's did not.

Two judgment calls worth recording. **The extractable range was not contiguous** — the brief described it as one block, but the runner's timing constants (`QUIET_DETECT_MS`, `CODEX_READY_FALLBACK_MS`, the three `CODEX_SUBMIT_*`) sit in the middle of it and are behaviour, not screen predicates; two ranges were extracted around them and the timing constants stayed. And **no re-export shim was left behind**: the three importers (`src/server.ts` plus two test files) now point at the new module directly, because a shim would have preserved exactly the asymmetry the change exists to remove. `gateCard` gained `export`, having been file-private; nothing else changed visibility.

### Expected test noise, so it is not misread as merge damage

**Superseded 2026-08-13 — the "known-bad" set did not reproduce once the leaked directories were deleted.** Read the entry below before treating any of it as expected.

- `cors-middleware.test.ts` × 2 — recorded in §2 as failing on plain `main` *even in full isolation*.
- `live-activity-flag.test.ts` — O3, 60–90s for 3 assertions with intermittent `afterEach` hook timeouts.
- `watch-for-jsonl.test.ts` — needed `--hookTimeout` far above the 30s default.
- Timeouts are suspect and warrant an isolated re-run; assertion mismatches are real (§2, §9).

### The known-bad set was environmental, not a property of the suite

On 2026-08-13, 1,261 leaked `threadbase-wfj-*` directories (1,749 files) were deleted from `~/.claude/projects`, plus 54 more in `$HOME` (see [#562](https://github.com/RonenMars/threadbase-streamer/issues/562)). `ConversationWatcher` holds roughly one watch handle per file under that root, so every `server.close()` in the suite was paying for the pile.

A full run afterwards, on `test/all-work-2026-08-13` — a throwaway branch carrying `main` plus **all ten** refactor branches:

| | Result |
|---|---|
| Test files | 201 passed, 1 skipped (202) |
| Tests | **1957 passed, 0 failed**, 5 skipped (1962) |
| Duration | **256.68s** |
| lint | `tsc` exit 0, biome clean, 396 files |

**None of the three known-bad entries reproduced.** `cors-middleware` passed, `live-activity-flag` passed, `watch-for-jsonl` passed inside a 120s hook timeout rather than needing 300s.

**On the timing, be careful about causation.** 256s against the ~1,259s recorded for PR 1's full run is 4.9×, but that is **not a controlled comparison**: PR 1's run was on a different tree, and §16 records that the adjacent PR 2 run was slowed by VS Code's plugin host at 315% CPU. Today's ran at load 2.60 on a 10-core box. Host load is an uncontrolled variable, so treat the leak as the *leading hypothesis* for both the speedup and the vanished failures, not as proven. What is solid: every one of the three previously-reproducing failures passed, and all three failed as **timeouts**, which §9's own triage rule already classifies as environmental rather than real.

**What to carry forward.** Do not treat `cors-middleware`, `live-activity-flag` or `watch-for-jsonl` as expected failures any more — a failure in any of them now deserves investigation rather than a shrug. And re-check the `~/.claude/projects` directory count before trusting any timing or flake measurement from this suite; until #562 is fixed the pile rebuilds on every run of `watch-for-jsonl.test.ts`.

---

## 17. Opening the ten PRs — canonical order

**This section is the single source of truth for PR order.** Earlier sections describe individual branches; where they disagree with this table, this table wins.

**Precondition: every PR from the integration branch (#521, #522, #532, #536, #537, #545, #546) must be merged into `main` first**, following §16. None of the ten below opens until `main` carries all seven. Opening earlier puts the integration commits inside each refactor diff, which is the whole reason these were held back.

### The order

| # | Branch | Base | Head | Stack |
|---|---|---|---|---|
| 1 | `refactor/server-split-1-http-helpers` | `main` | `cd3c1bf` | A |
| 2 | `refactor/server-split-2-scanner-manager` | split-1 | `83d426a` | A |
| 3 | `refactor/server-split-3-external-tails` | split-2 | `4e5f176` | A |
| 4 | `refactor/server-split-5-session-watchers` | split-3 | `26cd565` | A |
| 5 | `refactor/server-split-6-registry-boot` | split-5 | `7414246` | A |
| 6 | `refactor/server-split-4-conversation-handlers` | split-6 | `3750f35` | A |
| 7 | `refactor/server-split-8-session-handlers` | split-4 | `ccd3ca3` | A |
| 8 | `refactor/server-split-7-wiring` | split-8 | `e011af9` | A |
| 9 | `refactor/pty-shared-helpers` | `main` | `bf6ba11` | B — independent |
| 10 | `refactor/codex-question-predicates` | pty-shared-helpers | `9285a63` | B — independent |

> **All ten landed on 2026-08-14. This table is history, not a runbook.**
> Every branch above has been merged and deleted, and **every SHA in it is now an unreferenced dangling object** — they resolve in no fresh clone. Do not try to rebase or open any of them. The permanent record is the merge commits in [§18](#18-outcome--what-actually-landed).

**These are two separate stacks, not one chain of ten.** Stack A is the eight-branch `src/server.ts` split, rooted at `main`. Stack B is the two PTY-refactor branches, also rooted at `main`, and touches neither `src/server.ts` nor anything stack A changes — `pty-manager.ts` and `codex-pty-runner.ts` are byte-identical across `main`, the integration branch and all eight split branches. Stack B can therefore open and merge before, after, or alongside stack A.

The branch-number ordering inside stack A is deliberately not sequential (3 → 5 → 6 → 4 → 8 → 7). It follows how they were built and chained, not their plan numbers: PRs 3, 5 and 6 were built concurrently because none touches the `ApiDeps` object literal, then 4, 8 and 7 ran strictly sequentially because each rewrites entries inside it, with 7 last because it moves the literal itself.

### Use GitHub's stacked PRs — `gh stack`

Open these with GitHub's stacked-PR support rather than eight hand-chained `gh pr create --base` calls. It sets each PR's base correctly, links them as a **Stack** on GitHub so reviewers see only each layer's own diff, and gives a cascading rebase as PRs merge underneath.

**`gh stack` is an official GitHub CLI extension, not part of core `gh`.** Installed on this machine 2026-08-13: `gh stack v0.1.0`, against `gh` 2.97.0. On a fresh machine it needs:

```bash
gh extension install github/gh-stack
```

Then, once `main` carries all seven integration PRs, adopt the existing branches into stacks bottom-to-top. `gh stack init` accepts branch names in stack order and adopts branches that already exist rather than creating new ones — which is exactly this situation, since all nine are already built and pushed.

### Before `gh stack`: rebase the split stack with `--onto`, never plain `rebase main`

**`git rebase origin/main` on any stack-A branch is wrong and will fail.** Measured 2026-08-13, after #521 had merged:

```
$ git checkout -b probe origin/refactor/server-split-1-http-helpers
$ git rev-list --count origin/main..HEAD      → 18
$ git rebase origin/main
CONFLICT (add/add): Merge conflict in __tests__/push-capability.test.ts
error: could not apply 4e4d5e0... feat(push): report push capability…
```

The cause is structural, not incidental. Stack A was cut from `integration/2026-08-12-rehearsal-v2`, so every split branch's history contains the integration branch's 17 commits. Those same changes reach `main` as **squashes**, one per PR — different SHAs, different patch ids. `git rebase origin/main` therefore tries to replay all 17 integration commits on top of a `main` that already has their squashed equivalents, and collides on the first file both touch.

Use `--onto` with the integration base as the cut point, so only the branch's own commits replay:

```bash
git rebase --onto origin/main e877cf2 <split-branch>
```

Same probe, correct form: **1 commit replayed, clean, no conflict**. `e877cf2` is `integration/2026-08-12-rehearsal-v2`'s head — the commit every stack-A branch was cut from. Keep that SHA even after the branch is deleted from `origin`; it is the cut point, not a live ref.

Stack B (`pty-shared-helpers`, `codex-question-predicates`) was cut from `main`, not from the integration branch, so a plain `git rebase origin/main` is correct there.

**`--update-refs` will move your other local branches.** The corrected probe above printed `Updated the following refs with --update-refs: refs/heads/refactor/server-split-1-http-helpers` and left that local branch pointing at the rebased commit while `origin` still had the original. This is O2 from §9, and it is not hypothetical — it happened on the first real attempt. After any rebase in a checkout that holds other stack branches, verify every branch against its remote before pushing anything.

### The cross-stack import fix — stack A and stack B are not fully independent

They are independent *textually* — git reports no conflict between them — but not *semantically*. `src/api/handlers/sessions.handlers.ts` (created by PR 8, stack A) imports `CODEX_ACTIVE_WRITER_CODE` from `../../codex-pty-runner`, and stack B moves that symbol to `../../services/questions/codexScreen`. Different files, so nothing conflicts; the result is a dangling import that only `tsc` catches.

**Whichever stack lands second needs this one-line fix**, applied in the same PR or as a follow-up before CI runs:

```ts
// src/api/handlers/sessions.handlers.ts
-import { CODEX_ACTIVE_WRITER_CODE } from "../../codex-pty-runner";
+import { CODEX_ACTIVE_WRITER_CODE } from "../../services/questions/codexScreen";
```

Verified by building `test/all-work-2026-08-13`, a throwaway branch merging both stacks onto `main`: with the fix, `npm run lint` is green (`tsc` exit 0, biome clean) across all 396 files. Biome also re-sorts that import block afterwards, so run `biome check --write` before committing.

This is the §8 semantic-conflict pattern recurring, and the same lesson applies: two branches can be individually correct, individually green, and textually non-conflicting, yet break on merge with no git conflict and no warning.

### Opening the stacks

```bash
git fetch origin && git checkout main && git pull

# Stack A — the src/server.ts split, in the order above
gh stack init --base main \
  refactor/server-split-1-http-helpers \
  refactor/server-split-2-scanner-manager \
  refactor/server-split-3-external-tails \
  refactor/server-split-5-session-watchers \
  refactor/server-split-6-registry-boot \
  refactor/server-split-4-conversation-handlers \
  refactor/server-split-8-session-handlers \
  refactor/server-split-7-wiring

gh stack rebase          # cascading rebase onto the advanced main
gh stack submit --open   # creates all 8 PRs, chained bases, linked as a Stack

# Stack B — independent, run separately
gh stack init --base main \
  refactor/pty-shared-helpers \
  refactor/codex-question-predicates
gh stack rebase
gh stack submit --open
```

`gh stack view` shows the stack and each layer's PR state; `gh stack checkout <n>` moves between them.

**Pass `--open`, or you get ten drafts.** With `--auto` (and in CI, where the interactive editor cannot run) `gh stack submit` creates PRs **as drafts** unless `--open` is given. A draft PR reports `MERGEABLE` / `CLEAN` with every check green and still refuses to merge, and `isDraft` does not appear in the readiness fields you would normally query — this repo has already lost time to exactly that. If you use the interactive editor instead, new PRs default to ready for review.

Two smaller notes: `gh stack init` enables `git rerere` automatically, so conflict resolutions are remembered across the cascading rebases — useful here, because the split branches conflict on the import block and class-field declarations. Stack metadata lives in `.git/gh-stack`, which is local and never committed.

**If the extension is unavailable**, `gh stack link` is the lighter alternative — it takes branches bottom-to-top, pushes them, creates or reuses PRs with correct base chaining, and links them into a Stack **without** any local tracking state. Failing that, fall back to hand-chained `gh pr create --base <branch below>` in the order above, one at a time.

### Landing them

Two options, and the choice is a real one.

**One at a time** — what this repo's convention says, and the safer default. Merge the bottom PR, wait for CI green, then `gh stack rebase` to cascade the rest onto the advanced `main`, and repeat. GitHub retargets a stacked PR's base automatically when its base merges, but it does **not** rebase the commits — the diff shows unrelated changes until you do. By hand the cascade is `git rebase --onto origin/main <previous base>` (see the `--onto` warning above — plain `git rebase origin/main` is wrong for stack A) then `git push --force-with-lease`, never plain `--force`, one branch at a time.

**Atomically** — `gh stack merge --squash` merges every PR up to your chosen one into the base in a single all-or-nothing operation: if any one cannot merge, none do. `--squash` is what keeps `main` linear with one commit per PR, so pass it explicitly (the command also accepts `--merge` and `--rebase`, neither of which fits this repo). Add `-y` to skip the wizard.

Atomic merge is attractive for stack A precisely because the eight are a single mechanical refactor that was verified as a chain — but it forfeits the per-PR CI gate the convention exists to provide, since the whole stack lands on one decision. Use it only if every PR is already green; otherwise merge one at a time.

Whichever path: **`gh stack merge` checks only that a PR is open and not a draft.** Branch protection and repository rules are evaluated by GitHub when the merge runs, and bypassing merge requirements is not supported for stacks — so a rule failure surfaces mid-merge rather than up front.

The per-PR gate for every branch in stack A stays the same: `npm run lint` green, `git diff src/api/types/api-deps.ts` empty, no changes under `__tests__/contracts/` or `__tests__/e2e/`, and `src/server.ts` only shrinking.

### Command reference, as installed (v0.1.0)

| Command | Use here |
|---|---|
| `gh stack init --base main <branches…>` | adopt the existing branches, bottom to top |
| `gh stack view` | show the stack and each layer's PR state |
| `gh stack rebase` | cascading rebase across the stack |
| `gh stack sync` | sync the local stack with the remote |
| `gh stack submit --open` | create/update the PRs, chained bases, linked as a Stack |
| `gh stack merge --squash` | atomic all-or-nothing merge of the stack |
| `gh stack link` | link existing PRs into a Stack with no local tracking |
| `gh stack unstack` | remove a stack locally and on GitHub |
| `gh stack checkout` / `up` / `down` / `top` / `bottom` | navigate layers |

---

## 18. Outcome — what actually landed

*Written 2026-08-14, after everything above executed. Sections §16 and §17 are the plan; this is the result. Where they disagree, this section wins.*

### The seven integration PRs

Merged into `main` on 2026-08-14 in the rehearsed order, one at a time, each rebased and gated on its own CI run:

| PR | Merge commit |
|---|---|
| #521 | `9fc6fb8` |
| #522 | `64a9513` |
| #532 | `192d480` |
| #536 | `b54d12d` |
| #537 | `9c97f3b` |
| #545 | `217758c` |
| #546 | `62ae04d` |

The rehearsed order held: seven clean rebases, zero textual conflicts. **O1 is closed** — `push-capability.test.ts` + `live-activity-flag.test.ts` passed 11/11 at the exact checkpoint where the conflict used to appear. **O3 did not reproduce.**

### The ten refactor PRs

Opened with `gh stack` as two stacks (A: #572, B: #575) and merged one at a time:

| # | PR | Module | Merge commit | `src/server.ts` after |
|---|---|---|---|---|
| 1 | #564 | `api/handlers/http-helpers.ts` | `fd1bace` | 6,400 |
| 2 | #565 | `scanner-manager.ts` | `f697018` | 5,965 |
| 3 | #566 | `external-tails.ts` | `5d22105` | 5,777 |
| 4 | #567 | `session-watchers.ts` | `3be3dbf` | 5,456 |
| 5 | #568 | `session-registry-boot.ts` | `9a8944c` | 5,024 |
| 6 | #569 | `api/handlers/conversations.handlers.ts` | `170bfc2` | 4,087 |
| 7 | #570 | `api/handlers/sessions.handlers.ts` | `08aa0e5` | 2,881 |
| 8 | #571 | `server-wiring.ts` | `778a77a` | **2,501** |
| 9 | #573 | `pty-shared.ts` | `d94ad16` | — |
| 10 | #574 | `services/questions/codexScreen.ts` | `090e10e` | — |

**Final: `src/server.ts` 6,557 → 2,501, a 4,056-line reduction (62%).** Verified on `main` by reading the file, not inferred. `main` afterwards: lint green, **1957 passed / 0 failed / 5 skipped** across 202 files in 280s. Deployed to prod as `1.52.0+090e10e`.

### What the plan got right, and what it got wrong

**Right:** the `--onto` rule (§17) was essential — plain `git rebase origin/main` on split-1 replayed 18 commits and conflicted; `--onto origin/main e877cf2` replayed 1, clean, and the cascade through the other seven replayed 1 each with zero conflicts. The **cross-stack import fix** was needed exactly as predicted: #574 rebased onto a `main` that now had `sessions.handlers.ts`, whose `CODEX_ACTIVE_WRITER_CODE` import pointed at the old path. Git flagged no conflict; only `tsc` caught it.

**Wrong or incomplete:**

- **`gh pr merge` does not work on stacked PRs.** GitHub refuses with *"must be merged using the asynchronous merge REST API."* Use `gh stack merge <pr#> --squash -y` — passing a **PR number** merges only up to that PR, which is how one-at-a-time works inside a stack. Passing a *stack* number merges the whole thing atomically.
- **`gh stack init` needs every branch free of worktrees.** It checks each one out; a branch held by a worktree aborts it. It also reported a hard error on first run while having already written correct metadata — verify with `gh stack view` before re-running.
- **`gh stack merge` checks only that a PR is open and not a draft.** Branch protection and repo rules are evaluated mid-merge, so a rule failure surfaces partway through.

### Three failures worth carrying forward

Each produced a **clean, confident, wrong signal with nothing thrown**, and each was caught only because a second source disagreed.

1. **#522's CI was a false green.** The gate matched the bracketed skip tag in its *body* — the author describing a different PR — and skipped lint, tests and both smoke jobs on a code change while reporting 12/12 in 39 seconds. Filed as #563, **fixed and merged 2026-08-14 in `2c78352`**: the gate now matches the commit message and PR title only. The fix was verified by a negative control — a PR carrying the tag in its body only, which must run the full matrix. That control failed on the first attempt because the PR *title* contained the literal tag; renaming it gave the real result: **0 skipped steps across all 11 jobs, 5m 50s**, against 34s and 4-of-8 skipped before.
2. **#537's local branch was contaminated.** `--update-refs` during the 2026-08-12 rehearsal had silently rewritten `docs/agent-status-and-cursor-plans` to contain four `integrate PR #…` merge commits. It was still contaminated a day later. **O2's "harmless — local-only, never pushed" verdict in §9 was wrong**: the ref outlived its worktree and was one force-push from turning #537 into the rehearsal branch. Always check local refs against `origin` before rebasing.
3. **An invented `better-sqlite3` ABI mismatch.** An agent reported 32 `server.test.ts` failures, blamed a `NODE_MODULE_VERSION` mismatch, and called them pre-existing "because the same count appears at base" — where the base was its own stash. Node v24.15.0 reports `MODULE_VERSION` **137**, exactly what is installed; the file passes 142/142 both ways. The conclusion was right and the evidence was fabricated.

### Scope boundary

This log covers the nine PRs open on **2026-08-12** and the refactor work that followed. PRs **#551, #552, #553** (created 2026-08-12, after scope was fixed) and **#554, #559, #560, #561** (created 2026-08-13) are **not covered here** and were never part of this run. GitHub is the worklist; this file is a record of one operation.

Note **#553** re-baselines the `server.ts` split plan against 6,539 lines — obsolete now that the file is 2,501. It wants closing or rewriting.
