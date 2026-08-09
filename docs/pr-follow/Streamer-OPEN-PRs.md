# tb-streamer — Open PRs

Snapshot: 2026-08-09 17:45. Regenerate with `gh pr list --state open --json number,title,headRefName,baseRefName,mergeStateStatus` in `tb-streamer`. Treat as stale by default — re-scan before acting.

The **On int** column is coverage of `integration/prs-223-441-…-456` at `6c1ed95`, measured by content equivalence rather than SHA ancestry — several of these were rebased, so `git branch --contains` reports them as absent when their content is present.

| PR | Title | Base | State | On int |
|---|---|---|---|---|
| [#468](https://github.com/RonenMars/threadbase-streamer/pull/468) | docs(pr-follow): add streamer PR-follow working notes [skip-ci] | integration | CLEAN | — (this PR) |
| [#464](https://github.com/RonenMars/threadbase-streamer/pull/464) | fix(deploy): bound Windows version check for forced deploys | main | UNKNOWN | yes |
| [#462](https://github.com/RonenMars/threadbase-streamer/pull/462) | refactor(db): drop the dead projects.message_count column | main | UNKNOWN | yes (equiv) |
| [#461](https://github.com/RonenMars/threadbase-streamer/pull/461) | fix(projects): resolve project paths from the recorded cwd, not the dir name | main | UNKNOWN | yes (equiv) |
| [#456](https://github.com/RonenMars/threadbase-streamer/pull/456) | feat(sessions): report a pre-attach session as lifecycle "starting" | main | UNKNOWN | yes |
| [#455](https://github.com/RonenMars/threadbase-streamer/pull/455) | docs(troubleshooting): document Windows dev-environment test quirks [skip-ci] | main | UNKNOWN | yes |
| [#454](https://github.com/RonenMars/threadbase-streamer/pull/454) | chore(deps-dev): bump @types/node to 26.1.2 | main | CLEAN | yes |
| [#453](https://github.com/RonenMars/threadbase-streamer/pull/453) | chore(deps-dev): bump @types/semver to 7.8.0 | main | CLEAN | yes |
| [#452](https://github.com/RonenMars/threadbase-streamer/pull/452) | chore(deps): bump tar to 7.5.22 | main | CLEAN | yes |
| [#451](https://github.com/RonenMars/threadbase-streamer/pull/451) | perf(server): keep detail fetches off the full-rescan critical path | main | UNKNOWN | yes |
| [#452](https://github.com/RonenMars/threadbase-streamer/pull/452) | chore(deps): bump tar from 7.5.19 to 7.5.22 | `8c581d8` | 12/12 green | Rebased `5d442ed` → `380949e`, no conflict | Packages-map check: 1 dependency moved. Also repaired the stale lockfile root (see follow-up defect). |
| [#453](https://github.com/RonenMars/threadbase-streamer/pull/453) | chore(deps-dev): bump @types/semver from 7.7.1 to 7.8.0 | `8ad8724` | 12/12 green | Rebased `1a66ad9` → `a8e0df7`, **no conflict** — the predicted sequential lockfile clash did not occur; the bumps sit in different regions | Verified `tar` stayed 7.5.22, i.e. the replay did not revert #452. |
| [#454](https://github.com/RonenMars/threadbase-streamer/pull/454) | chore(deps-dev): bump @types/node from 26.1.1 to 26.1.2 | `e3ca7c3` | 12/12 green | Rebased `bf01161` → `fb28553`, no conflict | The overshoot-hazard PR. Asserted the result **is `26.1.2` and is not `26.2.0`** (current registry latest), plus `tar` 7.5.22 and `@types/semver` 7.8.0 unreverted. |
| [#455](https://github.com/RonenMars/threadbase-streamer/pull/455) | docs(troubleshooting): document Windows dev-environment test quirks | `279dbb3` | 11/11 + status green | Rebased `f5a7a96` → `8947c79`, no conflicts | None. |
| [#462](https://github.com/RonenMars/threadbase-streamer/pull/462) | refactor(db): drop the dead projects.message_count column | `70b8fe2` | 11/11 + status green | Rebased `181e9a3` → `a77458e`, no conflicts | Checked migration numbering (`main` tops out at 014, so 015 is correct) and every consumer of `projects.message_count` — none remain; the two tb-mobile hits read `conversation_meta.messageCount`, a different table. |
| [#464](https://github.com/RonenMars/threadbase-streamer/pull/464) | fix(deploy): bound Windows version check for forced deploys | `e8d2f1b` | 11/11 + status green | Rebased `5bc4c0f` → `5a9b82c`, no conflicts | Last of the 16 originals. |
| [#476](https://github.com/RonenMars/threadbase-streamer/pull/476) *(supersedes #463)* | fix(codex): reject resume of a session Codex already has a writer for | `1dd0b7f` | 11/11 + status green | Cherry-picked `cb1a99c0`+`d6fb1817` onto `main`, squashed to one commit, prompt file removed | Verified post-merge on `main`: `codexRolloutOwner.ts` present, `CODEX_SESSION_ACTIVE` documented, **and #456's scoped gate still at both call sites**. |
| [#477](https://github.com/RonenMars/threadbase-streamer/pull/477) *(supersedes #465)* | docs(compatibility): record that claude never holds its transcript open | `aac0b41` | 11/11 + status green | Cherry-picked `46155a9a` after #476 landed | Genuinely stacked on #476 — it edits the contract doc that PR introduces, so the cherry-pick conflicted until #476 was on `main`. Deferred rather than opened as a stacked PR. |
| [#450](https://github.com/RonenMars/threadbase-streamer/pull/450) | fix(sessions): detach external tails promptly on JSONL delete | main | UNKNOWN | yes |
| [#449](https://github.com/RonenMars/threadbase-streamer/pull/449) | fix(server): do not re-arm scannerStale after a drained path set | main | UNKNOWN | yes |
| [#448](https://github.com/RonenMars/threadbase-streamer/pull/448) | fix(sessions): set lifecycle for historical and multi-agent sessions | main | BEHIND | yes |
| [#456](https://github.com/RonenMars/threadbase-streamer/pull/456) | feat(sessions): report a pre-attach session as lifecycle "starting" | `df02a45` | 12/12 green | Did **not** auto-restack when #448 merged — manually rebased `9a89538` → `7d1590e` onto `2b2fad9` (see open question below) | Local branch delete failed (held by a stale worktree); the **remote** delete succeeded, which is the part that matters. Scoped gate verified present at both call sites on `main` post-merge. |
| [#449](https://github.com/RonenMars/threadbase-streamer/pull/449) | fix(server): do not re-arm scannerStale after a drained path set | `9aa646f` | 12/12 green | Rebased `454e956` → `07e63be` onto `df02a45`, no conflicts | Was a draft; flipped with the batch. |
| [#450](https://github.com/RonenMars/threadbase-streamer/pull/450) | fix(sessions): detach external tails promptly on JSONL delete | `fb618c6` | 12/12 green | Rebased `0f60172` → `650e7fe`; **conflict in `src/server.ts`** resolved as agreed — #450's `onFileDeleted` delegation **plus** `main`'s `onError` block | Was a draft. The conflict is the one real either/or of the run; see the resolution note below. |
| [#451](https://github.com/RonenMars/threadbase-streamer/pull/451) | perf(server): keep detail fetches off the full-rescan critical path | `110ddbc` | 12/12 green | Rebased `120f417` → `9b8908a` onto `fb618c6`, no conflicts | Was a draft; flipped with the batch. |
| [#447](https://github.com/RonenMars/threadbase-streamer/pull/447) | fix(codex): hold input until Ready and quiesce before submit | main | **DIRTY** | yes |
| [#446](https://github.com/RonenMars/threadbase-streamer/pull/446) | docs(agents): add cloud dev environment setup + run notes | main | UNKNOWN | yes |
| [#444](https://github.com/RonenMars/threadbase-streamer/pull/444) | feat(docker): harden image — lean stages, non-root, healthchecks | main | UNKNOWN | yes |
| [#446](https://github.com/RonenMars/threadbase-streamer/pull/446) | docs(agents): add cloud dev environment setup + run notes | `6f4745e` | 12/12 green | Rebased `2e80a3a` → `1ff4dfc` onto `6003e18`, no conflicts | Was a draft; flipped with the batch. |
| [#447](https://github.com/RonenMars/threadbase-streamer/pull/447) | fix(codex): hold input until Ready and quiesce before submit | `de82c65` | 12/12 green | Re-rebased `1eb9764` → `861e0bc` onto `6f4745e`. Clean this time — the earlier `CLAUDE.md` resolution carried through and the diff scope was byte-identical to the first rebase. | None at merge time. |
| [#448](https://github.com/RonenMars/threadbase-streamer/pull/448) | fix(sessions): set lifecycle for historical and multi-agent sessions | `2b2fad9` | 12/12 green | Rebased `1c775c8` → `711bec1` onto `de82c65`, no conflicts | Draft **and** stack base for #456 — two failure modes at once. `gh pr merge` refuses a stack base; merged with `PUT /pulls/448/merge-async`, which returns a meaningless `{"status":"pending"}` 200. Polled `gh pr view 448 --json state,mergeCommit` until it genuinely reported `MERGED`. |
| [#442](https://github.com/RonenMars/threadbase-streamer/pull/442) | fix(sessions): single-flight process discovery on list | main | UNKNOWN | yes |
| [#444](https://github.com/RonenMars/threadbase-streamer/pull/444) | feat(docker): harden image — lean stages, non-root, healthchecks | `6003e18` | 12/12 green | Rebased `287d16d` → `95432a8` onto `6244c84`, no conflicts | Was a draft; flipped with the batch (see obstacle below). |
| [#441](https://github.com/RonenMars/threadbase-streamer/pull/441) | chore(deps): bump the npm_and_yarn group across 1 directory | main | CLEAN | **no — see below** |
| [#223](https://github.com/RonenMars/threadbase-streamer/pull/223) | chore(deps-dev): bump typescript from 6.0.3 to 7.0.2 | main | **BLOCKED** | no — excluded |

19 open. `UNKNOWN` = GitHub has not recomputed mergeability; re-fetch per-PR before acting.

## Two deliberate exclusions

**#441 must not be merged into the integration branch — it is a downgrade.** Its `nanoid`/`postcss` bumps are already present, and on the three packages where it still differs it moves them *backwards*: `@types/node` 26.1.2 → 26.1.1, `@types/semver` 7.8.0 → 7.7.1, `tar` 7.5.22 → 7.5.21. The individual bumps #452/#453/#454 merged after it and supersede it. Close it or let dependabot re-raise it.

**#223 (TypeScript 7) is excluded by standing decision** — it breaks `rollup-plugin-dts`, and was reverted from the integration branch once already. The branch name still carries `prs-223-…` from that attempt; `package.json` on the branch pins `^6.0.3`, same as `main`.

## Merged this wave, no longer open

#463 (Codex active-writer resume) and #465 (claude open-file measurement) were **auto-merged by GitHub** when the integration branch — their base — was advanced to contain their commits. They are merged into the integration branch, *not* into `main`.

## Note on #447

`DIRTY` against `main`, but its content is on the integration branch: its test file is byte-identical there and `quiesce` appears in both. `src/codex-pty-runner.ts` diverges only because #463 edited it afterwards. Do not treat the conflict as "the fix is missing".

---

# Merge log — fresh integration branch → `main` (2026-08-09)

Chronological record of the fresh-cut run. Written as each step happened, not reconstructed afterwards.

## Refs

| What | Ref | SHA |
|---|---|---|
| Cut point | `origin/main` | `419746d` (`chore(release): 1.46.2 [skip ci]`) |
| Backup of the old INT | `backup/int-streamer-2026-08-09` (pushed) | `7844eb2` |
| Fresh branch | `integration/fresh-2026-08-09` (pushed) | `3e061a1` |
| Worktree | `../tb-streamer-worktrees/int-fresh` | own `npm ci`, never a copied `node_modules` |

`origin/main` was re-fetched immediately before `git worktree add`; `419746d` is the fetched value, not the value from the prompt's snapshot table.

## Rebases done before integrating

| PR | Old head | New head | Conflict | Resolution |
|---|---|---|---|---|
| #447 | `3fb11525` | `1eb9764` | `CLAUDE.md`, twice (once per commit) | Kept `main`'s `pty-manager.ts` line (paint-time gate detection, landed via #459) and #447's `codex-pty-runner.ts` line. `src/codex-pty-runner.ts` auto-merged — the `DIRTY` was entirely the doc line, not the code. File set after rebase is identical to `gh pr diff 447 --name-only`. |
| #455 | `58a1aef8` | `f5a7a96` | `docs/troubleshooting.md` | Both-added section clash with `main`'s npm-12 `allowScripts` entry (#466). Kept both. Rebases to a pure +54 addition with all six of its headings intact. |

**#455 was not flagged as `DIRTY` in the source prompt but was.** Only #447 was named there.

## Integration merges

All 16 open PRs merged at their current head, in the prescribed order, plus three recovered PRs (below). One conflict:

- **#450 vs `main`** in `src/server.ts`. `main` (#467) added the `onError` ENOSPC handler to the same `ConversationWatcher` options object that #450 refactored `onFileDeleted` out of. Kept both: `onFileDeleted: (filePath) => this.handleJsonlDeleted(filePath)` alongside the `onError` block. Verified `handleJsonlDeleted` carries the identical body.

## Obstacle — three PRs merged to the INT branch, never to `main`

`#463`, `#465` and `#468` were merged with the **old integration branch as their base**. They are therefore closed on GitHub, absent from `gh pr list --state open`, and absent from the prescribed merge order — while their content exists nowhere except the old INT. `main` has no trace of #463 at all (`git grep CODEX_SESSION_ACTIVE origin/main -- CLAUDE.md` → no match).

The Part 3.1 content diff is what surfaced this: 28 files / 1712 deletions against the old INT. The Part 3.2 coverage audit could not have — its scope is *open* PRs.

Merged all three into the fresh branch on the repo owner's instruction. #463 needed four resolutions, all caused by its branch point predating #456's second commit and #447's rebase:

| File | Kept | Why |
|---|---|---|
| `src/session-store.ts` (×3) | ours | #463's only real change here is `forkedFromConversationId`, which auto-merged. The conflicting hunks were its stale pre-#456 *unscoped* lifecycle gate. #456's scoped gate (`currentTurnId === undefined && s.completedAt == null`) survives at both call sites. |
| `src/codex-pty-runner.ts` (×2) | theirs | Theirs is a strict superset — byte-identical #447 content plus `CODEX_ACTIVE_WRITER_RE`, `CODEX_ACTIVE_WRITER_CODE` and `startFork`. |
| `CLAUDE.md` | ours | Both sides' `codex-pty-runner` lines are identical; ours additionally carries `main`'s gate-detection paragraph. |
| `docs/troubleshooting.md` | ours | Ours already has both sections; theirs had only one of them. |

#468's merge hit a nested criss-cross conflict in `docs/troubleshooting.md`. #468 touches only `docs/pr-follow/*`, so the conflict is a merge-base artifact — took ours.

## Part 3 — acceptance gate

**3.1 content diff vs the old INT: PASSES.** After the three recovered PRs, 28 files → 5, and every one favours the fresh branch:

| File | Difference | Verdict |
|---|---|---|
| `CHANGELOG.md`, `package.json`, `package-lock.json` | `main`'s 1.46.2 release | fresh is ahead |
| `CLAUDE.md` | `main`'s paint-time gate-detection paragraph | fresh is ahead |
| `docs/troubleshooting.md` (18 lines) | section **reordering only**, content byte-identical | no loss |

Nothing the old branch had is missing from the fresh one.

**3.2 coverage audit: clean.** All 16 open PRs `included_head` (exact head SHA present); `included_equiv`, `included_patch`, `included_empty` and `missing` all empty; `branch_only_vs_all_prs.unique_non_doc_commits` empty. **No false negatives arose** — the #447/#461/#462 cases the prompt warned about did not appear, because every PR was merged at its exact head rather than rebased in place, so content equivalence never had to be inferred.

**3.3 lint: green.** `tsc --noEmit` + biome exit 0 on both `origin/main` and the integration branch.

**3.3 tests: triaged as load noise by failure *kind*, per R6 — not by name-diff against a base run.**

Host at the time of the run: 10 cores, booted 21:01:29, load averages **4.71 / 5.12 / 14.96** (the 15-minute figure is residue from the pre-kill window, not current state). Quiet enough to trust; the earlier 386%-CPU window is described below.

The integration run reported `31 failed | 1884 passed | 8 skipped (1923)` across 7 files. Those 31 rows come from **8 distinct errors**, and the two numbers reconcile exactly — a `beforeEach` timeout fails every test in its file, so 5 hook errors account for 28 rows while 3 test errors account for 1 row each:

| File | Rows | Error kind | Errors |
|---|---|---|---|
| `watch-for-jsonl` | 7 of 7 | `Hook timed out in 30000ms` | 1 |
| `pair-endpoints` | 7 of 9 | `Hook timed out in 30000ms` | 1 |
| `security-hardening` | 7 of 16 | `Hook timed out in 30000ms` | 1 |
| `webhook-update` | 5 of 5 | `Hook timed out in 30000ms` | 1 |
| `discovery-cache` | 2 of 2 | `Hook timed out in 30000ms` | 1 |
| `cors-middleware` | 2 of 5 | `Test timed out in 15000ms` | 2 |
| `codex-active-writer` | 1 of 9 | `Test timed out in 60000ms` | 1 |
| **Total** | **31** | | **8** |

28 rows from 5 hook errors + 3 rows from 3 test errors = 31 rows from 8 errors. **Zero assertion failures** — `grep` for `AssertionError` over the full run output returns nothing.

Six of the seven files are exactly the documented known-flaky set in [Streamer-FD-BUDGET-AND-SUITE-NOISE.md](Streamer-FD-BUDGET-AND-SUITE-NOISE.md): `pair-endpoints`, `security-hardening`, `watch-for-jsonl`, `webhook-update`, `cors-middleware`, `discovery-cache`. R6 says triage by kind before spending anything, and an all-timeout set is the load signature, never a regression. R8 says CI on a pushed branch is then the better oracle than a local base run.

The seventh file, `codex-active-writer.test.ts`, is new to the branch (it arrives with the recovered #463), so it has no name in any `main` baseline and could not be classified by name-diff at all. Resolved directly instead: **9 passed / 9 in 15.79s** when run alone with `THREADBASE_CODEX_STARTUP_TIMEOUT_MS=120000` and a 300s test timeout. The single failure in the full run had consumed 74.6s of wall clock against a 4s startup bound.

**Two baseline traps hit on the way to that verdict, both recorded because they produced confident wrong answers:**

1. **The host, not the code.** `Paste.app` was pegged at **386% CPU** with a 15-minute load average of 64, predating any test run. Whole files were failing together — `watch-for-jsonl` 7/7 against a 2/7 reference, `webhook-update` 5/5 against 0/5 — which is starvation shape, not regression shape. This is the "check the host before the query" rule from `CLAUDE.md`'s Query-timing section, applied to the test suite.
2. **The reference itself was invalid.** The first baseline (6 failures / 188s) ran at 20:37; the machine rebooted at **21:01:29**, and the reboot wiped that run's output file. Comparing a post-reboot run to it would have been a cross-machine-state diff reported as a code delta. Verify the reference, not only the measurement.

**Scope of this verdict, stated narrowly:** the failure-kind triage clears these 7 files as load noise on this host. It is *not* a full-suite pass claim, and a subset re-run cannot supply one — this repo's FD-budget problem means a subset changes FD pressure and can pass where the full suite fails for reasons unrelated to the branch. The authoritative gate is per-PR CI in Part 5, which runs Test on Node 20/22/24 on a clean box; all 16 open PRs are already green there on the full matrix (Gate, Setup, Lint, Build, Test ×3, both Smokes), not merely on Snyk.

## Per-PR merges to `main`

Appended one row per merge, as it happens.

| PR | Title | Squash SHA | CI | Rebased / resolved | Obstacles |
|---|---|---|---|---|---|
| [#461](https://github.com/RonenMars/threadbase-streamer/pull/461) | fix(projects): resolve project paths from the recorded cwd, not the dir name | `6f691aa` | 12/12 green (Test ×3, both Smokes) | Rebased `bf3e7ab` → `ebd5660` onto `419746d`, no conflicts, diff scope unchanged | None. Merged first rather than 14th — **closes item 1 of the release backlog**: the path decode that returned 0 conversations where 37 exist, live on `main` since June. It touches only `handleListProjects.ts` + a new test, which no other PR in the set touches, so promoting it could not reorder any other PR's conflicts. |
| [#442](https://github.com/RonenMars/threadbase-streamer/pull/442) | fix(sessions): single-flight process discovery on list | `6244c84` | 12/12 green | Rebased `1428ab1` → `21313db` onto `6f691aa`, no conflicts | None. |

## Obstacle — six PRs were drafts, and no readiness field says so

`#444`, `#446`, `#448`, `#449`, `#450` and `#451` were all **draft** PRs. Flipped in one pass with `gh pr ready` before reaching the first of them, rather than recovering from a 400 six times mid-sequence.

**The general lesson, not just the incident:** `mergeable`, `mergeStateStatus` and `statusCheckRollup` are all readiness signals, and **`isDraft` is orthogonal to every one of them**. All six read `MERGEABLE` with 12/12 green CI — indistinguishable from a mergeable PR in those fields — and would still have refused to merge. Any "is this PR ready?" survey must query `isDraft` explicitly; it will never surface in the fields that look like they answer the question.

This compounds with the known `UNKNOWN` mergeability trap already documented for bulk `gh pr list`: the per-PR re-fetch that fixes `UNKNOWN` still will not tell you a PR is a draft unless you ask for the field.

## Open question — GitHub's auto-restack of a stacked PR is not reliable

When a stack base merges and its branch is deleted, GitHub retargets the child PR to `main`. Whether it also **auto-restacks** the child (rewriting its head onto the new `main`) is not dependable. Two data points, opposite outcomes:

| Case | State of the child *before* the base merged | Base force-pushed first? | Auto-restacked? |
|---|---|---|---|
| streamer #456 on #448 | `MERGEABLE` / `CLEAN` | yes | **no** — retargeted to `main`, head unchanged at `9a895386`, went `CONFLICTING`/`DIRTY` |
| mobile #551 on #544 | `CONFLICTING` / `DIRTY` | yes | **yes** — and the auto-restack was byte-identical to the local one |

**A force-push explanation does not survive the pair** — both bases were force-shed before merging, so that is not the variable. The one observable difference runs counter to intuition: the child that was already broken got restacked, the clean one did not. That is an observation, **not a mechanism** — the cause is unknown and two cases are not enough to infer one.

**What to do regardless:** never assume the retarget implies a restack. After the base merges, re-read the child's `mergeStateStatus`; if it is `DIRTY`, rebase it manually. The manual rebase is safe and self-checking — `git rebase origin/main` reported `skipped previously applied commit 1c775c8`, recognising the base's commit was already on `main` as the squash, and replayed only #456's own two commits.

Verified afterwards rather than trusted, because #456's second commit exists in no other PR: both commits present (`ca4033c`, `7d1590e`), the scoped gate at **both** call sites in `session-store.ts`, and a diff scope identical to what was merged into the integration branch (4 files, +58/−6).

## #450's conflict — the one real either/or, and why the resolution is what it is

`main` (via #467) added an `onError` handler to the same `ConversationWatcher` options object that #450 refactored `onFileDeleted` out of. Disjoint edits that abut; the common ancestor has the inline body and no `onError`, so neither side reverts the other.

Resolution: **#450's one-line delegation `onFileDeleted: (filePath) => this.handleJsonlDeleted(filePath)` *plus* `main`'s `onError` block, unchanged.**

`onError` belongs **outside** the extracted helper, and the reason is the contract rather than precedent: `conversationWatcher.ts` calls `this.onError?.(directory, error)` for *directory* watches too, so a method named `handleJsonlDeleted` owning a directory-level ENOSPC path would be wrong by its own name. Cardinality agrees — the helper has two call sites, `onError` has one.

**The check that matters is the second call site.** #450's actual fix is the `handleJsonlDeleted(filePath)` call inside `onConversationChanged` (`server.ts:765`), reached when `statSync` throws — the directory-unlink path that survives when the per-file `unlink` is dropped (delete inside a write-finish window, or a dead handle). Without it an external tail stays attached until the 5-minute idle sweep (#393). **A lazy "keep `main`'s version" resolution would have dropped exactly that and still merged green**, because the behaviour it fixes only appears when a watcher handle dies. Verified on `main` post-merge: 3 `handleJsonlDeleted` occurrences (definition + both call sites) and the `watcher.limit_exhausted` branch intact.

## Follow-up defect — the release job leaves `package-lock.json`'s root version stale

Not introduced by any PR in this run, and **not to be fixed inside a dependabot bump.**

`semantic-release` bumps `package.json` and commits without regenerating `package-lock.json`, so the lockfile's own root `version` field lags. On `main` at `110ddbc`: `package.json` is `1.46.2`, the lockfile root is `1.44.4` — two releases stale, and every release widens the gap.

The dependabot PRs regenerate the lockfile, so each one incidentally picks up the true version and shows `<root>: 1.44.4 → 1.46.2` in a packages-map comparison. **That is a repair, not drift — keep the `1.46.2`.** Reverting to `main`'s value would preserve the bug. Expect the same line on #453 and #454; same cause, not per-PR.

Belongs in the streamer's follow-up set: make the release job regenerate the lockfile (or run `npm version` rather than editing `package.json` directly).

## Two more confident-but-wrong traps caught in Part 5

1. **`gh pr checks` right after a force-push reports the *previous* head's run.** On #452 it returned `0 non-pass of 12` seconds after the branch was rewritten — the old head's completed results — while the new head had one check done and three queued. Merging on that would have used evidence from a commit that no longer existed. Earlier merges were safe only by luck: their monitor loops polled for 30s+, so the stale window had closed. **Resolve the head SHA first and query `gh api repos/<o>/<r>/commits/<sha>/check-runs`**, which cannot drift.
2. **A bare `npm install --package-lock-only` overshoots a dependabot target.** All three bumps sit behind caret ranges, so regeneration resolves to the newest registry match. `@types/node` is `^26.0.1` with a target of `26.1.2` and a current latest of **26.2.0** — a bare regenerate ships a minor bump under a patch-bump title, and the PR still goes green. Pin the exact target (`npm install <pkg>@<target> --package-lock-only`), and assert the resulting version **is `26.1.2` and is not `26.2.0`** — not merely that the lockfile changed.

**Use a structured `packages`-map comparison, never a lockfile eyeball.** Comparing resolved `{path: version}` maps between the two refs is what distinguishes a real bump from machine noise; a raw diff cannot. It is what surfaced the `<root>` staleness above, which reads as just another changed line among five.

## Closing state

**All 19 PRs landed on `main`.** 16 originals plus three recreations of work that had been merged only into the old integration branch.

`main` moved `419746d` → `aac0b41` over the run. The fresh integration branch `integration/fresh-2026-08-09` (`3e061a1`) has served its purpose as the proving ground and its content is now fully on `main`; it can be retired. `backup/int-streamer-2026-08-09` (`7844eb2`) is kept — it is the only record of the pre-run integration state and the source the three recreations were recovered from.

**Never merged, by standing decision:**

- **#223** (TypeScript 7) — breaks `rollup-plugin-dts`. Still open.
- **#441** (the npm group downgrade) — **closed itself**: dependabot closed it at 19:23:11 and opened **#475** (`postcss` 8.5.16 → 8.5.26) three seconds later. The downgrade problem resolved without intervention. #475 is a *new* PR outside this run's brief and was left for the repo owner.

## Follow-ups this run produced

1. **Release job leaves `package-lock.json`'s root version stale** — see the section above. Real defect, widening every release.
2. **tb-mobile: the withheld Retry affordance is restorable.** Mobile omitted Retry on fork failure assuming no idempotency key; #476 answers that the other way. Recorded in #476's body so it is not lost.
3. **`auto-restack` reliability** — two data points, opposite outcomes, cause unknown. See the open question above.
