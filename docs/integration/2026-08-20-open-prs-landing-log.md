# Landing log — 2026-08-20 open-PR set (real run)

**Status:** complete
**Goal:** land the PR set the rehearsal validated. Done = every PR squash-merged to `main` with its required checks green, every backup ref removed, and no integration branch pushed.
**Operator:** Claude Code session  **Repo:** threadbase-streamer  **Log started:** 2026-08-20 11:20 IDT
**Rehearsal this replays:** [2026-08-20-open-prs-rehearsal-log.md](2026-08-20-open-prs-rehearsal-log.md) · [summary](2026-08-20-open-prs-rehearsal-summary.md)

---

## 1. How the real run differs from the rehearsal, by instruction

The rehearsal ended proposing to push `integration/2026-08-20-open-prs`. **That is not what was done, by explicit instruction:**

> "Integration branch never should be push/merged, unless I asked for it. Each branch PR that was merged into the integration branch should have a PR based on main, and merged directly to main, the following branch in the order following the rehearsal documents should be rebased with `--force-with-lease` and a backup ref first. After successfully merged, the backup ref should be removed."

So the integration branch stayed **local** and served only as the rehearsal artifact and conflict oracle. The PRs were landed individually to `main` in the rehearsal's order, each rebased onto the current `main` behind a backup ref.

`#475` was added to the set mid-run on a second instruction ("merge also the dependabot PRs that were mentioned in the rehearsal docs"). It appears in the rehearsal documents only as a **deliberate exclusion**, so **its conflict was never rehearsed** and was resolved live — see §5.

---

## 2. Order executed, and `main`'s progression

Order came from the rehearsal summary §3 and was followed exactly, with `#475` appended.

| Step | PR | `main` before | PR head before → after | `main` after |
|---|---|---|---|---|
| 1 | #580 | `2aa4672e` | `59e269fb` (no rebase — `CLEAN`) | `813028ce` |
| 2 | #646 | `813028ce` | `b17c556c` → `27e26bc6` | `5a0ef0c7` |
| — | *release* | | | `790d4f34` `chore(release): 1.65.0` |
| 3 | #650 | `790d4f34` | `94726308` → `cda1f9d9` → `bfbbe96b` | `25f06770` |
| — | *release* | | | `01e8b2f6` `chore(release): 1.66.0` |
| 4 | #651 | `01e8b2f6` | `acb679f9` → `fb36bec2` | `c0a7dc3a` |
| — | *release* | | | `669c6111` `chore(release): 1.67.0` |
| 5 | #653 | `669c6111` | `be98a361` → `917ade8a` | `246a0337` |
| 6 | #475 | `246a0337` | `05b8cde5` → `684e31a0` | `72783a80` |

`main` went `2aa4672e` → `72783a80`, v1.64.0 → v1.67.0.

**No release commit followed #653**, and that is correct rather than a stall: it is a `test:` commit, which semantic-release does not version. It was confirmed by watching for ~7 min rather than assumed.

---

## 3. The deviation the rehearsal did not predict

**The `main` ruleset sets `strict_required_status_checks_policy: true`.** Every squash-merge triggers semantic-release, which pushes a `chore(release)` commit and moves `main`; under a strict policy that immediately makes the *next* PR — and any PR already rebased — `BEHIND` and unmergeable.

It cost a full extra cycle on **#650**, which was rebased onto `5a0ef0c7` and went green on `cda1f9d9`, then turned `BEHIND` when v1.65.0 landed and had to be re-rebased onto `790d4f34` as `bfbbe96b` and re-run. Every later PR was rebased only *after* watching for the release commit, so it happened once.

**Rule for the next run:** after a squash-merge, wait for the `chore(release)` commit (or confirm the merged type produces none) **before** rebasing the next branch. A rehearsal cannot surface this — it never merges anything.

Verified with:
```
gh api repos/RonenMars/threadbase-streamer/rulesets/17561930 \
  --jq '.rules[] | select(.type=="required_status_checks") | {strict: .parameters.strict_required_status_checks_policy}'
# {"strict":true}
```

---

## 4. Where the rehearsal held

Every prediction the rehearsal made about the code was correct.

| Prediction | Outcome |
|---|---|
| #646 rebases losslessly, patch-id `b6fafd03…` | **held** — identical against `main` too |
| #650 rebases losslessly, patch-id `72341ed3…` | **held** — identical on both rebases |
| #651 conflicts in `__tests__/ws-capabilities.test.ts`, one line, mechanical | **held** — the conflict hunk was byte-identical to the rehearsal's |
| #653 rebases losslessly, patch-id `273ad941…` | **held** |
| #580 needs no rebase | **held** |
| Set is green together | **held** — every PR passed all 8 required checks on its rebased head |

**Diff scope was judged by `git patch-id --stable` at every step**, per the rehearsal's §9 rule, plus a file-list comparison against `gh pr diff <n> --name-only`. Three of the four rebases came back patch-id-identical; #651's differed only in the conflicted line, as designed.

---

## 5. Conflicts

### #651 — the rehearsed one, resolved identically

The conflict reproduced exactly once #646 was on `main`:

```
<<<<<<< HEAD
  return { startGraceTimer, armHoldWhenIdle, addSessionSubscriber, warn, handleWsMessage };
||||||| parent of acb679f9
  return { startGraceTimer, addSessionSubscriber, warn, handleWsMessage };
=======
  return { startGraceTimer, addSessionSubscriber, removeSessionSubscriber, warn, handleWsMessage };
>>>>>>> acb679f9
```

Resolved as the union in biome's wrapped form — the rehearsal's resolution, applied verbatim and then **diffed against it to confirm identity**. Applied with an assert that exactly one site matched. `npx biome check` exited **0**, so no follow-up style commit was needed. Both symbols confirmed present afterwards.

### #475 — not rehearsed, resolved live

`package-lock.json`, the only file the PR touches. The conflict is the lockfile's version header: the PR was cut when the package was `1.46.2` and rewrote it to `1.47.0`, while `main` had reached `1.67.0`.

**A lockfile conflict is regenerated, not hand-merged.** Resolution:

```
git checkout --ours package-lock.json          # main's lockfile, header 1.67.0
npm update postcss nanoid --package-lock-only  # exit 0
git add package-lock.json && git rebase --continue
```

The regenerated result reproduces the PR's intent exactly — **16 changed lines**: `postcss` 8.5.16 → **8.5.26**, `nanoid` 3.3.15 → **3.3.18**, and the peer range `nanoid: ^3.3.12` → `^3.3.17`. The version header stays at `main`'s `1.67.0` rather than the stale `1.47.0`, and no other file is touched. Dependabot's authorship (`dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>`) and commit message survive the rebase — resolving inside the rebase rather than authoring a replacement commit is what preserves that.

**Both bumps are transitive** — `package.json` names neither — which is why the fix is a lockfile regeneration and not a dependency edit.

---

## 6. Writes performed

Every write, in order, against the approved list.

| # | Write | Result |
|---|---|---|
| 1 | push `docs/integration-rehearsal-2026-08-20` | new branch |
| 2 | open PR #655 | opened |
| 3 | squash-merge #580, delete branch | merged 08:04:16Z |
| 4–8 | per PR: push `backup/<branch>-2026-08-20` → rebase → `--force-with-lease` → squash-merge → **delete backup** | #646 08:15:16Z · #650 08:34:16Z · #651 08:49:19Z · #653 09:02:14Z · #475 09:19:46Z |

- **`--force-with-lease` at every force-push.** Never `--force`. `main` was never force-pushed and never pushed to directly — every change reached it through a squash-merge.
- **Backup refs, all five created before their force-push and all five deleted after their merge.** Final check: `git ls-remote --heads origin 'refs/heads/backup/*'` returns **nothing**.
- **`integration/2026-08-20-open-prs` was never pushed.** `git ls-remote --heads origin | grep -c integration/2026-08-20-open-prs` → **0**.
- `origin/integration/2026-08-18-open-prs` @ `2c2e1b1c` was left untouched — it predates this session and removing it was not asked for.

### One imperfect write

`gh pr merge --delete-branch` failed to delete the **local** branches `feat/host-pressure` and `feat/unsubscribe-session`, because worktrees under `tb-streamer-worktrees/` still hold them. The **remote** branches were deleted normally, so this is local hygiene only. Those worktrees are now stale and should be pruned.

---

## 7. Verification

Each PR's own CI ran on its rebased head, and **all 8 required checks** — `Gate, Setup, Lint, Build, Test (Node 22), Test (Node 24), Smoke (macos-latest), Smoke (windows-latest)` — reported `SUCCESS` before its merge, with `mergeStateStatus=CLEAN`. So unlike the rehearsal, the landed set **is** verified on Node 22, Node 24 and Windows.

**`security/snyk` reported `null` on every rebased head** and never re-ran. It is not a required check and `mergeStateStatus` was `CLEAN` regardless, so it did not gate anything — but it means **no PR in this set was Snyk-scanned at the SHA that actually landed**. Named rather than glossed: a green Snyk on a pre-rebase SHA is not a scan of what merged.

The **merged `main` was never run as a whole locally.** The nearest evidence is the rehearsal's final checkpoint — `0 failed / 2275 passed / 5 skipped`, lint green — on a tree containing the same five PRs but built on `2aa4672e` and without #475.

---

## 8. Gaps in this log

- No local suite run against the final `main` (`72783a80`). Everything rests on per-PR CI plus the rehearsal.
- #475 was verified by CI only. `npm update` was run with npm 12, whose blocked install scripts do not affect `--package-lock-only`, but no local install was performed from the regenerated lockfile.
- Snyk did not scan any landed SHA (§7).
- Timings throughout are wall-clock on a box under load 15–30; they measure the box.
- The #651 resolution's agreement with the rehearsal is a real independent check on that one conflict and says nothing about #475's, which has no oracle.

---

## 9. Rules learned, on top of the rehearsal's

- **Under `strict_required_status_checks_policy`, a release-automating repo serialises hard.** Every merge invalidates every other PR's rebase. Wait for the `chore(release)` commit before rebasing the next branch, and expect one CI cycle per PR with no overlap.
- **Resolve a lockfile conflict by regenerating, inside the rebase.** `git checkout --ours` then `npm update <pkgs> --package-lock-only` yields a correct lockfile and preserves the original author and message; hand-merging lockfile hunks or authoring a replacement commit does neither.
- **A green check on a pre-rebase SHA is not a check on what landed.** Count the names again after the force-push, and say so when one never re-reported.
- **`gh pr merge --delete-branch` cannot delete a local branch a worktree holds.** It is not a failed merge; read the message rather than the exit code.

---

## 10. After the last merge — `main` went red, and why it was not #475

`main` @ `72783a80` (the #475 squash) reported **CI failure**. Every earlier commit in this run — `813028ce`, `5a0ef0c7`, `25f06770`, `c0a7dc3a`, `246a0337` — was green, so the obvious reading is that the last thing merged broke it. That reading is wrong.

**One job failed, and it is a wall-clock assertion:**

```
FAIL __tests__/server-shutdown.test.ts > StreamerServer.close() port release
     > resolves quickly with no clients connected (common deploy path)
AssertionError: expected 3311 to be less than 1000
  __tests__/server-shutdown.test.ts:82   expect(Date.now() - start).toBeLessThan(1000)

Test Files  1 failed | 225 passed | 3 skipped (229)
     Tests  1 failed | 2250 passed | 29 skipped (2280)
```

`Smoke (windows-latest)` only; `Gate, Setup, Lint, Build, Test (Node 22), Test (Node 24), Smoke (macos-latest)` all passed.

### The decisive evidence: identical trees

The same code passed this job on the PR ten minutes earlier.

```
git rev-parse 684e31a0^{tree}   # PR head, Smoke (windows-latest) = SUCCESS
git rev-parse 72783a80^{tree}   # main,    Smoke (windows-latest) = FAILURE
# both: e49fdc56d1024fa10f91b123f5b0c7846e83d162
```

A squash of one commit onto the base it was rebased on produces the same tree, so **the artifact under test was byte-identical in both runs**. Identical input, opposite outcome, minutes apart — that is a flaky test, and no property of #475 can explain it.

### The corroborating evidence

- **#475's merged commit changes one file:** `package-lock.json`, 7 insertions / 7 deletions.
- Both bumps are transitive. `postcss` has exactly one dependent in the lockfile — `node_modules/vite` — and nothing under `src/` or `cli/` imports it.
- `nanoid` *is* imported, but only by `src/agent/handle-start-agent-session.ts:8` and `src/agent/handle-send-agent-input.ts:7` — the multi-agent path, gated behind `MULTI_AGENT_FLOW`. `__tests__/server-shutdown.test.ts` references neither package and never reaches that code.
- The bump is `3.3.15 → 3.3.18`, a patch within the same major.

### Verdict and action

**Not #475's fault; not reverted.** Reverting would have removed a security bump on the strength of a timer, and left the actual defect in place. The failed job was re-run once, per the CI gate.

### The real defect this exposed

`__tests__/server-shutdown.test.ts:82` asserts a **hard 1 000 ms wall-clock bound** on `server.close()`. On a shared Windows runner it measured 3 311 ms. The behaviour being protected is real and worth protecting — the deploy path must not hang on shutdown — but a fixed millisecond bound on contended CI hardware tests the runner as much as the code, and it will keep firing at random on whichever PR happens to be merging.

This is the same lesson `CLAUDE.md` already records for query timing, in a new place: **a saturated host makes every duration look pathological, so a duration is not a safe assertion.** The bound belongs on an event (the port is released / `close()` resolved) rather than on a stopwatch, or at minimum needs a Windows-specific allowance like the one `vitest.config.ts` already applies to `testTimeout`.

**Follow-up:** loosen or re-express that assertion. It is unrelated to every PR in this set and should be its own change, not folded into one of these.
