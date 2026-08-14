# Integration summary — integration/2026-08-12-rehearsal (2026-08-12)

**Verdict:** complete — everything rehearsed here landed on `main` on 2026-08-14. See [log §18](2026-08-12-rehearsal-log.md#18-outcome--what-actually-landed) for the outcome and the merge commits.
**Branch:** `integration/2026-08-12-rehearsal` @ `f855aed` — 7 PRs, 16 commits ahead of `main` @ `c76c257` (local rehearsal worktree only)
**CI:** not run on this branch (flow A, never pushed) — every individual PR's own CI was green (10/10) before merging, except the excluded #548
**Full log:** [2026-08-12-rehearsal-log.md](2026-08-12-rehearsal-log.md)

This rehearsal merged 7 of 9 open PRs (excluding a broken draft and two dependabot PRs) into a local integration branch in chronological order with no stacking or forced-order constraints, and found the order is clean and mergeable — but surfaced one real cross-PR semantic conflict and one unexplained flaky/slow test that should be resolved before a real run.

---

## 1. Final refs

| What | Ref | SHA |
|---|---|---|
| Integration branch | `integration/2026-08-12-rehearsal` | `f855aed` |
| Cut from | `origin/main` | `c76c257` |
| Backup / archive | — none (flow A, nothing pushed, nothing to protect) | |
| Worktree | `../tb-streamer-worktrees/int-2026-08-12-rehearsal` | (local only; not cleaned up yet) |

---

## 2. What is in the branch

| PR | Title | Effect in one line |
|---|---|---|
| #521 | feat(push): report push capability | Adds `push` capability object to `/api/info` and `/api/push/health` |
| #522 | feat(cli): warn at boot on bypass permission mode | Boot-time warning when a bypass permission mode is active |
| #532 | docs: correct stale CI-coverage claims [skip-ci] | Docs-only fix to handoff prompts |
| #536 | docs(architecture): structured session events design [skip-ci] | Adds a new architecture doc |
| #537 | docs(plans): viewport-cursor + server-side sub-status plans | Adds 4 new plan/task docs |
| #545 | feat(push): gate Live Activity push behind a feature flag | Live Activity now requires `liveActivityPush` flag, not just APNs credentials |
| #546 | feat(browse): return files alongside directories in /api/browse | `/api/browse` now lists files, not just directories |

### Not included

| PR / branch | Why | Standing exclusion? |
|---|---|---|
| #548 | Self-described incomplete draft (gaps tracked in #541); CI red on macOS + Windows smoke with 2 real assertion failures in its own code, unrelated to anything else in the set | One-off — re-add once #541 is closed |
| #475 | Dependabot (postcss bump) | Yes, for this run |
| #223 | Dependabot (typescript 6→7 major bump) | Yes, for this run |

---

## 3. The order that actually worked

**Final order:** `#521 → #522 → #532 → #536 → #537 → #545 → #546`

Pure chronological order by `createdAt`. No stacking (`git merge-base --is-ancestor` checked all 7×7 pairs — none), no forced-order constraints (checked all PR bodies/comments for dependency language — none found), no reordering during the run.

| Constraint | Kind | Reason |
|---|---|---|
| — none | | |

---

## 4. Conflicts that mattered

No `J` (judgment) conflicts — every one of the 7 rebases was textually clean, no git conflict markers at any step.

| Conflict | Kept | Discarded | Rule applied | How you would know it was wrong |
|---|---|---|---|---|
| — none (all mechanical/clean) | | | | |

---

## 5. Silent problems found (and the ones still possible)

| Found | Where | How it was caught |
|---|---|---|
| #521's `push-capability.test.ts` asserts a default #545 later removed (APNs credentials alone → `liveActivity: true`; #545 also requires the `liveActivityPush` flag, default off) | `__tests__/push-capability.test.ts` × 2 tests | Test checkpoint after merging #545, confirmed real via isolated re-run (not saturation noise) |
| `live-activity-flag.test.ts` runs 60–90s for 3 assertions and intermittently hook-times-out on `server.close()` — first observed after #546 merged, cause not identified | `__tests__/live-activity-flag.test.ts` | Test checkpoint after #546; characterized across 5 isolated re-runs, still unresolved |

**Sweeps run clean:** `describePushCapability` call-site grep (single call site, correctly wired); CLAUDE.md's two independent additions (from #521 and #545) both survived the merge intact with no blanket per-file resolution needed.
**Sweeps not run:** cross-file grep for the `browse.ts` file-listing option's consumers beyond its own test; continuous host-load monitoring during test runs (checked with `uptime` at each step, not continuously).

---

## 6. Verification

| | Baseline (`main`) | Final (integration) | Δ |
|---|---|---|---|
| lint | green | green | none |
| typecheck | green | green | none |
| tests | `2 failed / 1943 passed / 11 skipped` (low-load, isolated) | `5 failed / 1952 passed / 5 skipped` (1962 total) | +3 failed: 2 are the known #521/#545 semantic conflict, 1 is the unresolved `live-activity-flag.test.ts` flake |

**Not verified:** no CI run on the integration branch itself (flow A never pushes); Windows/Linux platforms untested (macOS-only rehearsal); the `live-activity-flag.test.ts` slowness was not root-caused, only characterized.

---

## 7. Obstacles worth remembering

| # | Obstacle | Fix | Recurs? | Automate? |
|---|---|---|---|---|
| O1 | #521's test asserts a default #545 later changed | not applied (needs a decision — update the test, or accept as a documented forced-order note) | one-off for this pair, but the pattern (later PR narrows an earlier PR's assumed default) recurs whenever two PRs touch the same flag-gated subsystem | worth a standing sweep: diff each PR's tests against every other PR's default-changing code before trusting a green checkpoint |
| O2 | `git rebase --update-refs` moved an unrelated local branch ref that happened to point at a rebased commit | **the "harmless" verdict was wrong** — the ref outlived its worktree and was still contaminated a day later, one force-push from turning #537 into the rehearsal branch (log §18) | yes, whenever a coincidental local branch exists | yes — check every local branch against its `origin` counterpart before rebasing |
| O3 | `live-activity-flag.test.ts` is slow (60–90s) and intermittently hook-times-out, cause unknown | not applied — needs a focused look at `StreamerServer.close()` teardown timing | unknown — needs re-measurement at low host load as a first step | no — needs a human debugging pass first |

---

## 8. Follow-ups

| Item | Why it is open | Next action | Owner | Issue |
|---|---|---|---|---|
| ~~Fix #521's `push-capability.test.ts`~~ — **done**, fixed at source in `445ddd7` and verified 11/11 at the merge checkpoint | — | closed | — | — |
| Investigate `live-activity-flag.test.ts` slowness / intermittent hook timeout | not root-caused in this rehearsal | profile `StreamerServer.close()` under `disableDb: true` + flag-only boot at low host load | user / #545 author | — |

---

## 9. Rules learned

- Bulk `gh pr list --json mergeable` is `UNKNOWN` for every row on this repo too — per-PR `gh pr view` is mandatory, confirmed again this run.
- A draft PR's own CI failures should be checked against its own PR description before asking the user to decide — #548 self-documented as incomplete, which made the decision easy once surfaced.
- Docs-only PRs (confirmed via `git diff --name-only` against only `.md` files) are safe to skip the full test suite for at each individual checkpoint, as long as the final full-suite run before the coverage gate still covers them collectively.
- Host saturation (load > core count) produces false test failures that are always **timeouts**, never assertion mismatches — that distinction is a fast triage signal before spending time re-running.
- Two PRs can each be internally correct and individually green in CI, yet conflict semantically once merged, with zero git conflict and zero `tsc` error — only a post-merge test run catches it. This run's #521/#545 pair is a concrete example worth keeping as a reference case.

---

## 10. Cost

**Wall-clock:** ~2h20m+ (see log §15 for phase breakdown). **PR count:** 7 merged, 1 excluded for cause, 2 excluded by standing policy. **Conflicts resolved:** 0 textual conflicts; 1 semantic conflict found (not resolved, deferred to follow-up); 1 unresolved flaky-test obstacle.
**Three biggest time sinks:** (1) full-suite test checkpoints and their isolation re-runs to separate real failures from host-saturation noise; (2) root-causing the #521/#545 semantic conflict; (3) characterizing (without resolving) the `live-activity-flag.test.ts` slowness.

---

## 11. How to merge

*Added 2026-08-13. Full runbook with commands: [log §16](2026-08-12-rehearsal-log.md#16-how-to-merge-this-into-main).*

The live branch is `integration/2026-08-12-rehearsal-v2` @ `e877cf2`, which supersedes the `f855aed` in §1 — v2 was rebuilt after the O1 fix and is on `origin`, 17 commits ahead of `main` @ `c76c257`.

**The integration branch does not get merged.** It carries seven `integrate PR #NNN: …` merge commits and `main` must stay linear with one squashed commit per PR. Its job was to prove the seven compose and in what order; that job is done. Merge the seven PRs individually, then delete it.

**O1 is closed.** #521's head is `445ddd7`, which pins the `liveActivityPush` flag in its own test — the §5 semantic conflict is fixed at source rather than deferred to merge order, so #545 can land either side of #521. That resolves both §8 follow-ups' first row.

**Order:** `#521 → #522 → #532 → #536 → #537 → #545 → #546` — chronological, rehearsed conflict-free end to end. No hard constraint remains now that O1 is fixed, but this is the only order with evidence behind it.

**Per PR:** check CI green, rebase onto `origin/main`, `git push --force-with-lease`, `gh pr merge <n> --squash --delete-branch`. One at a time — each merge advances `main` and leaves the next PR behind.

**Then** the ten refactor branches open, in the order below. GitHub retargets a stacked base on merge but never rebases the commits.

### The order — open only after all seven integration PRs are merged

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

> **All ten landed on 2026-08-14 — this table is history, not a runbook.** Every branch has been merged and deleted, and every SHA above is now an unreferenced dangling object that resolves in no fresh clone. The permanent record is the merge commits in [log §18](2026-08-12-rehearsal-log.md#18-outcome--what-actually-landed).

Two separate stacks, both rooted at `main`: A was the eight-branch `src/server.ts` split, B the two PTY-refactor branches, which touched nothing A touched and could land on their own schedule.

**Open them with GitHub's stacked PRs (`gh stack`), not eight hand-chained `gh pr create --base` calls.** It is an official CLI extension, not core `gh`; installed here 2026-08-13 as `gh stack v0.1.0` against `gh` 2.97.0. On a fresh machine: `gh extension install github/gh-stack`.

```bash
gh stack init --base main <branches, bottom to top>   # adopts existing branches
gh stack rebase                                        # cascading rebase onto the new main
gh stack submit --open                                 # opens the PRs, bases chained, linked as a Stack
```

Run it twice — once per stack. **Pass `--open`**: with `--auto`, or in CI, `submit` creates PRs as **drafts**, and a draft reports `MERGEABLE`/`CLEAN` with green checks while refusing to merge — a trap this repo has already hit.

**Two things measured on 2026-08-13 that will break the naive version of this:**

**Rebase stack A with `--onto`, never plain `git rebase origin/main`.** Stack A was cut from the integration branch, so each split branch's history carries its 17 commits — which reach `main` as squashes with different SHAs. A plain rebase tries to replay all 17 onto a `main` that already has them: measured as **18 commits replayed and an immediate add/add conflict** on `push-capability.test.ts`. The correct form, `git rebase --onto origin/main e877cf2 <branch>`, replays **1 commit, clean**. Stack B was cut from `main`, so a plain rebase is right there. Also expect `--update-refs` to move other local stack branches (O2, confirmed live) — check every branch against its remote before pushing.

**Stack A and stack B are not fully independent.** They never conflict textually, but `sessions.handlers.ts` (PR 8) imports `CODEX_ACTIVE_WRITER_CODE` from `codex-pty-runner`, and stack B moves that symbol to `services/questions/codexScreen`. Whichever lands second needs a one-line import repoint, or `tsc` fails with a dangling import that git never flagged. Verified against a throwaway branch merging both onto `main`: with the fix, lint is green across 396 files.

For landing, `gh stack merge --squash` merges the whole stack atomically (all-or-nothing), which keeps `main` linear but forfeits the per-PR CI gate; merging one at a time with `gh stack rebase` between is the safer default. Full commands, the command reference as installed, the fallback (`gh stack link`), and the rationale for stack A's non-sequential order are in [log §17](2026-08-12-rehearsal-log.md#17-opening-the-ten-prs--canonical-order).

**PR 1 and PR 2 were built and verified before being opened, deliberately** — both pure mechanical moves with `ApiDeps` byte-identical, so opening them only after `main` carried the seven kept each diff to its own code. They merged on 2026-08-14 as #564 and #565.

| | PR 1 `…split-1-http-helpers` @ `cd3c1bf` | PR 2 `…split-2-scanner-manager` @ `83d426a` |
|---|---|---|
| New file | `src/api/handlers/http-helpers.ts` (173 L) | `src/scanner-manager.ts` (554 L) |
| `src/server.ts` | 6,557 → 6,400 | 6,400 → 5,965 |
| Diff | 2 files, +183 / −167 | 3 files, +693 / −578 |
| Verified | lint green · `15 failed / 1939 passed`, all pre-existing | lint green · `30 failed / 1927 passed`, **0 assertion failures** |

PR 2's own test file (`server.test.ts`) is clean, `push-capability` passes (O1's source fix holds on this stack), and the two files that failed only in its full run — `watch-for-jsonl`, `discovery-cache` — do not reproduce on re-run. Its higher failure count is host load: that run was 41% slower than PR 1's because VS Code's plugin host hit 315% CPU, driving load to 23 on 10 cores. Not a regression, and the counts are not comparable.

Land them one at a time after the seven: rebase onto `origin/main`, `--force-with-lease`, open, merge, then repeat for PR 2. Full commands in [log §16](2026-08-12-rehearsal-log.md#16-how-to-merge-this-into-main).

**PRs 3, 5, 6 and 4 were built and verified to the same discipline**, and merged on 2026-08-14 as #566, #567, #568 and #569. For the full chain including PRs 8 and 7, see the order table above.

| | PR 3 @ `4e5f176` | PR 5 @ `26cd565` | PR 6 @ `7414246` | PR 4 @ `3750f35` |
|---|---|---|---|---|
| New file | `src/external-tails.ts` (269 L) | `src/session-watchers.ts` (410 L) | `src/session-registry-boot.ts` (537 L) | `src/api/handlers/conversations.handlers.ts` (1,049 L) |
| `src/server.ts` | 5,965 → 5,777 | → 5,456 | → 5,024 | → 4,087 |
| Verbatim check | 2 lines differ | 2 lines differ | **0** | 6 lines differ |

**The split is complete and merged.** PR 8 (`src/api/handlers/sessions.handlers.ts`, 1,547 L) and PR 7 (`src/server-wiring.ts`, 701 L) finished the series; both landed on 2026-08-14.

**`src/server.ts` is down from 6,557 to 2,501 — 4,056 lines removed, 62% of the file**, across seven PRs and eight extracted modules: `http-helpers`, `scanner-manager`, `external-tails`, `session-watchers`, `session-registry-boot`, `conversations.handlers`, `sessions.handlers`, `server-wiring`. All eight landed on `main` on 2026-08-14 as PRs #564–#571.

PR 8 moved 18 handlers verbatim bar two biome reflows, retargeting 14 `ApiDeps` entries and fixing `handlePermissionChange`'s 13 test reach-ins. PR 7 ran last because it moves the `ApiDeps` literal itself, and it is the only PR in the series that needed no test edits — every reach-in had already been repointed by whichever PR moved its target.

**The near-miss worth remembering** is PR 7's `apiKey` entry: it was a getter specifically so `rotateApiKey()` takes effect without a restart. It stayed a getter, now reading a thunk. Flattening it to a captured value would have type-checked, passed every test, and quietly broken key rotation in production — the class of regression a "pure move" is most likely to introduce.

**And a false diagnosis worth remembering:** PR 8's agent reported 32 `server.test.ts` failures, blamed a `better-sqlite3` ABI mismatch, and called them pre-existing. Node v24.15.0 reports `MODULE_VERSION` 137, exactly what is installed; the file passes 142/142 at base and with the change. Its conclusion was right and its evidence was invented. Re-run a suspicious file from a genuinely clean tree before accepting any diagnosis attached to it — and never accept "same count at base" when the base was produced by the agent's own stash.

**Follow-up landed:** `refactor/pty-shared-helpers` @ `bf6ba11` merges the five helpers duplicated between `pty-manager.ts` and `codex-pty-runner.ts` into `src/pty-shared.ts` (80 L) — `digestBytes`, `loadPty`, `createScreen`, `stripAnsi`, `InternalSession`, plus the three geometry constants `createScreen` reads. Net −131 / +21 across the two runners, lint green, 265 tests passing, no test file changed. Branched from `origin/main` and independent of the split stack. The two classes stay separate: their detection logic is genuinely provider-specific.

**Second follow-up landed:** `refactor/codex-question-predicates` @ `9285a63`, stacked on `pty-shared-helpers` as stack B's top layer. It moves Codex's rendered-screen regexes, blocking-prompt detection, readiness/busy predicates and `gateCard` into `src/services/questions/codexScreen.ts` (211 L), where the Claude-side equivalents already lived — `codex-pty-runner.ts` 1,300 → 1,114, moved code byte-identical at 180/180 lines, lint green, 289 tests passing. The runner's timing constants stayed behind (behaviour, not screen predicates), and the three importers point at the new module rather than a re-export shim, which would have preserved the very asymmetry being fixed.

**Two traps that surfaced doing it.** All four duplicated constants were verified identical before merging — had the geometry differed, sharing `createScreen` would have silently changed one provider's screen grid with nothing downstream to report it. And `grep` is shadowed in this shell: it silently returned no matches for all five names in `pty-manager.ts`, which nearly produced the conclusion "already resolved, nothing to do." `/usr/bin/grep` found all five.

The same trap struck twice more the same day: a shell glob reported **zero** leaked `threadbase-wfj-*` directories under `~/.claude/projects` (they are path-encoded starting with `-`, so `ls` read the expanded glob as flags and `2>/dev/null` ate the error) where `find` reported 1,261. **Use absolute binaries in scripted checks, prefer `find -name` over globs for generated names, never send a discovery command's stderr to `/dev/null`, and treat absence-of-matches as unproven until a second tool agrees.** Three separate times in one day a check returned a clean, confident, wrong answer with no error attached; each was caught only by a second, disagreeing source.

Three of them (3, 5, 6) were built concurrently in separate worktrees because none touches the `ApiDeps` object literal. PR 4 retargets eight of its entries, so it had to run alone — as must PRs 8 and 7, with 7 last because it moves the literal itself.

**The finding worth carrying forward:** rebasing PR 6 onto PR 5 produced an 860-line conflict, because PR 5 had edited a call site *inside* a block PR 6 deletes wholesale. That is not a merge nuisance — it is the signal that a cross-PR dep needs rewiring (`SessionRegistryBoot`'s `watchConversationFile` dep pointed at a method PR 5 had moved). Resolve such a conflict by diffing the two sides to prove what the edit actually was, never by picking a side.

Every branch was verified independently of the agent that built it: `tsc` exit 0, biome clean, `api-deps.ts` and contracts/e2e untouched, and **every moved method body diffed against its original** under a normalization that undoes only the declared rebinds. The residual differences are all biome reflows and one TS-narrowing artifact; no semantic drift anywhere. PR 4 additionally got a name-preservation check on all 58 `ApiDeps` keys, since a mis-pointed entry type-checks fine whenever two handlers share a signature.

**The known-bad set is retired as of 2026-08-13.** `cors-middleware.test.ts` × 2, `live-activity-flag.test.ts` (O3) and `watch-for-jsonl.test.ts`'s raised timeout were all recorded as expected failures. After deleting 1,261 leaked `threadbase-wfj-*` directories from `~/.claude/projects` and 54 from `$HOME` ([#562](https://github.com/RonenMars/threadbase-streamer/issues/562)), **none of them reproduced**: a full run on `test/all-work-2026-08-13` — `main` plus all ten refactor branches — gave **1957 passed, 0 failed, 5 skipped across 202 files in 256s**, with lint green.

The suite also ran 4.9× faster than the ~1,259s recorded for PR 1, but that is **not a controlled comparison** — different tree, and the adjacent PR 2 run was slowed by VS Code at 315% CPU while today's ran at load 2.60. Treat the leak as the leading hypothesis, not proof. What is solid: all three previously-reproducing failures now pass, and all three failed as **timeouts**, which this log's own triage rule already classifies as environmental.

**Consequence:** a failure in any of those three now deserves investigation rather than a shrug. Timeouts are still suspect, assertion mismatches still real — and re-check the `~/.claude/projects` count before trusting any timing measurement, since the pile rebuilds on every `watch-for-jsonl` run until #562 is fixed.

---

## 12. Outcome

*Added 2026-08-14. Full detail and merge commits: [log §18](2026-08-12-rehearsal-log.md#18-outcome--what-actually-landed).*

**Everything rehearsed here landed on `main` on 2026-08-14.** The seven integration PRs merged in the rehearsed order — seven clean rebases, zero textual conflicts, order confirmed exactly as predicted. Then the ten refactor PRs (#564–#571, #573, #574) merged one at a time.

**`src/server.ts` finished at 2,501 lines, down from 6,557 — a 4,056-line reduction (62%)** across ten extracted modules. `main` afterwards: lint green, **1957 passed / 0 failed** across 202 files. Deployed to prod as `1.52.0+090e10e`.

**Both open obstacles closed.** O1 was fixed at source and verified 11/11 at the exact checkpoint where it used to fail. O3's slowness did not reproduce — it, and the rest of the "known-bad" set, turned out to be artifacts of a test leak (#562, still open).

**Three failures that a green tick could not distinguish from success**, each caught only because a second source disagreed:

- **#522's CI was a false green** — the gate matched the bracketed skip tag in its *body* and skipped every test on a code change while reporting 12/12 in 39 seconds. Filed as #563 and **fixed in `2c78352`**: the gate now reads the commit message and PR title only. Verified with a negative control that itself failed on the first attempt, because the fix PR's *title* contained the literal tag.
- **O2 was mis-verdicted.** A `--update-refs` side effect recorded as "harmless — local-only" had silently rewritten a local branch to contain four `integrate PR #…` merge commits; it was still contaminated a day later and nearly got force-pushed into #537.
- **An invented `better-sqlite3` ABI mismatch** was offered as the cause of 32 test failures, self-verified against the agent's own stash. Node v24.15.0 reports the version that is actually installed, and the file passes both ways.

### Scope boundary

This document covers the nine PRs open on **2026-08-12** and the refactor that followed. PRs **#551, #552, #553** (created 2026-08-12, after scope was fixed) and **#554, #559, #560, #561** (created 2026-08-13) are **not covered** and were never part of this run. GitHub is the worklist; this is a record of one operation.

Still open: **#562** (the test leak) and **#548 / #541** (a draft stranded by the refactor). **#553** re-baselines the split plan against 6,539 lines and is obsolete now the file is 2,501.
