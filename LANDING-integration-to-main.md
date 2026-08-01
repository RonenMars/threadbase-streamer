# Landing `integration/missing-prs-2026-07-23` onto `main`

## Context

`integration/missing-prs-2026-07-23` was assembled to test a batch of open PRs together. It has since become a parallel trunk: `main` is **250 commits behind** it, and work kept landing on the integration branch instead of on `main`. Two PRs (#303, #295) used to target the integration branch rather than `main`; both were closed on 2026-07-31 and the section on them is now a record of *how* they were resolved, not open work.

> **Updated 2026-08-01.** The gap grew from 221 to 241 because a further 26 PRs (#301–#332) were developed and merged **onto this branch**, not onto `main` — the whole live-sessions-persistence plan, Phases 0 through 7. That is a new stranded group (**Group E**) and it is now the largest single block of unlanded work. The live streamer is deployed from this branch (`1.33.0+80a2b40`), so `main` is not what is running in production.

> **Re-audited 2026-08-01, late.** Three things changed and one was previously missed.
> **(a)** `main` has moved: #224 and #226 merged to it on 07-31 and #340 on 08-01, so `main` is **no longer an ancestor** of this branch — the fast-forward escape hatch at the end of this runbook no longer works. Only #340 is new *content*, though; see "The `main`-only divergence is 3 commits but only 1 patch".
> **(b)** Group E has grown from 26 PRs to **37** — #333–#339 and #341 all merged onto this branch after the group was first written.
> **(c)** A previously unrecorded block exists: **#292, #293, #294, #296** were squash-merged onto this branch back on 07-26 and belong to no group in this document. They are now **Group F**.
> **(d)** Sweeping every *open* PR against the same test found **15 more** that no group covered — Group A was derived from the `integrate PR #NNN` commits, and these never went through that path. They are now **Group A′**, and one of them (`#304`) turns out to be the only route to `main` for a Group-D commit.

The goal is to get that work onto `main` without replaying an unreviewable 250-commit history.

> **Rehearse before executing.** The prompts in [`docs/landing/`](docs/landing/) drive a full **local** replay of this runbook — backup, land every group onto a throwaway trunk cut from `origin/main`, then diff the result against the untouched branch — with `origin` read-only throughout. It converts this document's static analysis into a conflict ledger and a verified command sequence before anything touches a protected branch. There is one prompt for [Claude Code](docs/landing/rehearsal-prompt-claude-code.md) and one for [Codex](docs/landing/rehearsal-prompt-codex.md).

**This runbook deliberately differs from the tb-mobile one.** The mobile integration branch is linear (0 merge commits) and had to be sliced. This branch is a merge DAG assembled *from PRs that still exist*, so the right move is to land those PRs — not to slice the branch.

**Deliberately out of scope:** any behaviour change. This is a merge/landing operation. If something must be fixed to go green, that fix belongs to the PR that needs it.

---

## Measured facts

Against `origin/main` and `origin/integration/missing-prs-2026-07-23`:

| Fact | Value (2026-08-01, re-measured after #342/#343) | Consequence |
|---|---|---|
| Commits ahead of `main` | **250** (07-18 → 08-01) | Far too many to review as one PR |
| Merge commits in range | **63** | History is a **DAG, not linear** — slicing/rebasing is the wrong tool |
| `main`-only commits | **3** (`bfdc2c9` #224, `2c1b038` #226, `28da612` #340) — but only **1** by content | `main` is **no longer an ancestor** → the fast-forward escape hatch is **dead**. See the note below: the divergence is 3 commits but 1 patch. |
| Commits sharing a subject with another | **114 of 250** | Heavy duplication from repeated re-merges. Same-subject is **not** same-patch — verify with `git patch-id` before discarding any of them. |
| First-parent spine commits (non-merge) | **102** | Of which **44** are squash-merged PRs (38 Group E, 4 Group F, plus `#298` and the `#269` duplicate) and **58** are direct commits needing triage — see Group D |
| PRs the branch integrated | **23** via `chore(merge): integrate PR #NNN`, plus **44** squash-merged directly (#269, #292–#298, #301–#343) | The branch documents its own provenance — use it |

**These numbers move every time something merges into the branch.** Re-measure rather than quoting them; the commands are in the Group D and Group E sections.

### Contrast with tb-mobile (why the strategy differs)

| | tb-mobile | tb-streamer |
|---|---|---|
| Merge commits | 0 (linear) | **63** (DAG) |
| `main` an ancestor? | No (2 divergent commits) | **No longer** (3 divergent commits since 07-31) |
| Duplicate commits | 9 | **114** |
| Source PRs recoverable? | No — direct pushes | **Yes — 23 named in commits, plus 44 squash titles** |
| Strategy | Slice the linear history | **Land the original PRs** |

Rebasing 63 merges into a line would explode them into replayed commits and conflict heavily, and the duplicates would carry re-merge noise onto `main`. Slicing is the wrong instrument here.

### The `main`-only divergence is 3 commits but only 1 patch

Worth separating, because the two numbers answer different questions and only one of them is about lost work.

`git cherry origin/integration/missing-prs-2026-07-23` over `main`'s three commits marks two of them `-`, meaning their patches are already on the integration branch:

| `main` commit | PR | On the integration branch? |
|---|---|---|
| `bfdc2c9` | `#224` semantic-release 25.0.5 → 25.0.8 | **Yes**, as `93a24ab` — same patch, merged here separately |
| `2c1b038` | `#226` tsx 4.23.0 → 4.23.1 | **Yes**, as `c46aaf3` |
| `28da612` | `#340` cross-platform smoke job | **No** — genuinely absent |

So **ancestry is broken by 3 commits, but the only content `main` has that this branch lacks is #340's smoke job.** That matters in two directions:

- **It does not revive the escape hatch.** `--ff-only` compares ancestry, not patches. Three unreachable commits abort it regardless of what their patches duplicate, and rewriting `main` to fix that is a force-push the ruleset forbids.
- **It does shrink the reconciliation.** Any plan that needs the branch to become a superset of `main` — a squash PR, or re-establishing fast-forwardability — has to carry exactly one real change across, not three. The two dependabot bumps will resolve as no-ops or trivial lockfile conflicts.

Note that #340's `ci.yml` is deliberately *narrower* than this branch's: it omits the expanded `test:smoke` script and `__tests__/ci-workflow.test.ts`, both of which reference `pty-host` files `main` does not have. Reconciling it is a merge in this branch's favour, not a straight take.

### Hotspot files

Re-measured 2026-08-01 after #342/#343:

| File | Commits touching it |
|---|---|
| `src/server.ts` | 68 |
| `__tests__/server.test.ts` | 39 |
| `src/types.ts` | 30 |
| `CLAUDE.md` | 22 |
| `src/api/types/api-deps.ts` | 16 |
| `package-lock.json` | 14 |
| `src/pty-manager.ts` | 13 |

`src/server.ts` at 68 touches is the main conflict surface. It is a further argument against thematic cherry-picking, and a reason to land PRs **one at a time** rather than in parallel.

`package-lock.json` is new to this list and behaves differently from the rest: its conflicts are almost never semantic. Regenerate it with `npm install` against the resolved `package.json` rather than hand-merging hunks.

---

## Before any group: know which head branches still exist

**Added 2026-08-01.** Verified against `origin` on that date. This governs *how* you reach each group's content and nothing in the group sections below repeats it.

| Group | Head branches on `origin`? | Why |
|---|---|---|
| **A**, **A′** | **Exist** | The PRs are open; nothing has deleted them. The three stacked bases — `feat/live-external-sessions`, `fix/stale-conversation-history`, `feat/cache-integrity-alert` — exist too. |
| **B** (#271 #273 #274 #275) | **Exist** — `fix/slow-conversation-rescan`, `fix/hold-session-grace-timer`, `fix/detect-shell-prompt-numbered-menu`, `fix/osc-777-conflation-and-status-line` | Closing a PR does **not** delete its branch. Only their *base*, `integration-dev/v1.0.0-2026-07-22`, is gone. |
| **C** (#276 #281–#287) | **Gone** — all 7 | Squash-merged with `--delete-branch`. |
| **F** (#292 #293 #294 #296) | **Gone** — all 4 | Same. |
| **E** (#301–#343) | **Gone** — effectively all | Same. Irrelevant in practice: this group is recovered by cherry-picking spine commits, not by branch. |

**`refs/pull/<N>/head` survives branch deletion**, so nothing is unreachable. Fetch them all before starting:

```bash
G=/opt/homebrew/bin/git
$G fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
$G log --oneline -1 origin/pr/282     # verified working for a merged, branch-deleted PR
```

Skipping that fetch is the failure this table exists to prevent: `origin/feat/provider-compatibility` simply does not resolve, and an automated pass that treats a missing ref as "nothing to do" will silently drop Groups C and F rather than erroring.

---

## The work splits seven ways

Derived from the `integrate PR #NNN` commits, the `(#NNN)`-suffixed squash commits on the spine, and each PR's current state.

### Group A — still open against `main` (10 remaining of 12) → just merge them

No new PRs needed. Their content is already reviewed and targeted correctly.

`#227` `#237` `#253` `#254` `#264` `#266` `#267` `#270` `#272` `#299`

**Two have already landed.** `#224` (semantic-release bump, `bfdc2c9`) and `#226` (tsx bump, `2c1b038`) merged to `main` on 2026-07-31 — they are the first two of the three commits that ended `main`'s ancestry. Do not re-cherry-pick them.

`#297` (`fix/permission-broadcast-dedup`) belongs here too and was never listed: it is open against `main`, and this branch already carries its content as `fad5d5f` via the cherry-pick PR `#298`. Merging `#297` is how that fix reaches `main` — see Group F.

**Dependency order matters — three are stacked on feature branches, not `main`:**

| PR | Base | Merge after |
|---|---|---|
| `#254` | `feat/live-external-sessions` | `#253` |
| `#266` | `fix/stale-conversation-history` | that branch's PR |
| `#234` | `feat/cache-integrity-alert` | `#232` |

Suggested order: dependency-free dependabot bumps first (`#227`, `#264`) to get easy merges out of the way, then `#237`, `#267`, `#270`, `#272`, `#297`, `#299`, then the stacked chains (`#253` → `#254`; `#232` → `#234`; `#266`).

### Group A′ — open against `main`, never integrated via the `integrate PR` convention (15) → also just merge them

**Added 2026-08-01.** Fifteen open PRs target `main` and appear nowhere else in this runbook. Group A was derived from the `chore(merge): integrate PR #NNN` commits, and these were never merged that way — so the derivation could not see them. Being invisible to the derivation is not the same as being landed.

**Twelve are fully contained in the integration branch** — `git cherry origin/integration/… <head>` reports the PR tip as an ancestor, so the branch is already exercising their content. All twelve report `MERGEABLE` / `BEHIND` and are 8–15 commits behind `main`: rebase, wait for green, squash-merge, exactly like Group A.

| PR | Branch | New vs `main` | Behind `main` |
|---|---|---|---|
| `#232` | `feat/cache-integrity-alert` | 3 | 15 |
| `#234` | `feat/cache-warmup-status` | 8 | 15 |
| `#240` | `fix/bootstrap-agent-exit5` | 1 | 15 |
| `#241` | `fix/upload-filename-sanitize` | 1 | 15 |
| `#242` | `docs/pre-release-status-2026-07-19` | 1 | 15 |
| `#252` | `fix/pty-quiet-marker-screen-recheck` | 1 | 9 |
| `#255` | `fix/find-free-port-flake` | 1 | 9 |
| `#257` | `docs/pre-release-status-sync-2026-07-22` | 1 | 8 |
| `#258` | `fix/bootout-agent-busy-wait` | 1 | 8 |
| `#259` | `fix/log-truncation-sparse-nuls` | 2 | 8 |
| `#260` | `test/isolate-scanner-fixtures` | 2 | 8 |
| `#223` | `dependabot/npm_and_yarn/typescript-7.0.2` | 1 | 1 |

`#232` → `#234` is the stacked pair already named in Group A's dependency table; merge `#232` first. `#223` is a **major** TypeScript bump (6.0.3 → 7.0.2), not a routine patch — give it its own run rather than batching it with the other dependabot PRs.

**Every one of these predates #340**, so their check rollups currently show nine contexts and no Smoke. They cannot merge until rebased, because `main protection` now requires `Smoke (macos-latest)` and `Smoke (windows-latest)`. The rebase is what makes those contexts appear.

**Three need different handling:**

| PR | State | Why |
|---|---|---|
| `#302` | `MERGEABLE` / `BEHIND` | **The only PR here whose content exists nowhere else.** `docs/architecture/2026-07-27-sessions-ownership-path-filter.md` is absent from `main` *and* from the integration branch. It is based on `d5181b2`, which is on `main`, so it is clean and independent — merge it. Closing it loses the content outright. |
| `#245` | `CONFLICTING` | `test(server): replace flaky grace-timer setTimeout waits with polling`. Contained in the branch, but the grace-timer semantics it tests were rewritten by `#305` and Group E. Confirm the flake still exists before spending a rebase on it. |
| `#304` | `CONFLICTING` | **Do not merge as-is** — 138 commits of drift because it is branched from the *integration branch*, not `main`. Same trap as `#295` and `#303`. See below. |

**`#304` is the recovery vehicle for a Group-D commit, and that is worth stating plainly.** The feature-flag registry (`src/feature-flags.ts`) is on the integration branch and absent from `main`. It arrives on the spine as **`90c1c07`** (2026-07-28) — a *direct commit with no `(#NNN)` suffix*, so it is one of Group D's 58, and it is a real feature rather than merge noise. `CLAUDE.md` documents it as shipped. Recover it by cherry-picking `90c1c07` onto a fresh branch from `main`, then close `#304`.

### Group B — closed against a dead base (4) → content is stranded

`#271` `#273` `#274` `#275` — all based on `integration-dev/v1.0.0-2026-07-22`, a superseded integration branch that has itself been **deleted from `origin`**. Closed, so nothing carries them to `main`, but their commits are on this branch.

Cut **one fresh PR per logical change**, branched from `main`, cherry-picking from the integration branch.

**Their head branches still exist**, which makes this the easiest stranded group to recover — you can diff or cherry-pick from the branch directly rather than hunting the spine:

| PR | Head branch (present on `origin`) | Tip |
|---|---|---|
| `#271` | `fix/slow-conversation-rescan` | `4261160` |
| `#273` | `fix/hold-session-grace-timer` | `fea7dda` |
| `#274` | `fix/detect-shell-prompt-numbered-menu` | `6f51543` |
| `#275` | `fix/osc-777-conflation-and-status-line` | `d11734c` |

Check each with `git cherry origin/main origin/<branch>` first — these are the oldest PRs in the runbook (all 2026-07-23) and the branch has had ten days to absorb equivalent fixes.

### Group C — merged into the integration branch, never to `main` (7) → content is stranded

`#276` `#281` `#282` `#283` `#284` `#285` `#287` — the C-series features (Claude CLI flags, durable session runtime, provider compatibility, status confidence, idempotency keys, device identity, push registration).

Same treatment as Group B: fresh PRs from `main`. These are substantial features and should be one PR each.

**Unlike Group B, every one of these head branches is gone** — they were squash-merged with `--delete-branch`. Reach them through `origin/pr/<N>` after the PR-head fetch, or through their squash commits on the spine. `origin/feat/provider-compatibility` and its six siblings do not resolve.

**Carry the drift-check spec with `#282`.** `docs/superpowers/specs/2026-07-27-provider-version-drift-check-design.md` landed on this branch via PR #317 (cherry-picked from #303). It is a design doc, so it looks like free-standing content — it is not. It cites `VERIFIED_AGAINST` in `src/services/providers/providerHealth.ts` and the "C2" section of `docs/architecture/2026-07-24-provider-compatibility.md`, both of which arrive with `#282`. Recovered on its own it ships two dangling references; recovered in `#282`'s PR the references resolve on arrival. It has no PR of its own to `main`, so nothing will surface it — this note is the only thing that will.

### Group E — the live-sessions-persistence work (38 PRs, #301–#343) → stranded, but clean

**Added 2026-08-01, roster extended twice the same day.** The single largest block of unlanded content, and the one that behaves *least* like the rest of this branch.

`#301` `#305` `#306` `#307` `#308` `#309` `#310` `#311` `#312` `#313` `#314` `#315` `#316` `#317` `#318` `#319` `#320` `#321` `#322` `#323` `#324` `#325` `#326` `#327` `#328` `#329` `#330` `#331` `#332` `#333` `#334` `#335` `#336` `#337` `#338` `#339` `#341` `#342` `#343`

**The tail (#333–#343) arrived after this group was first written** and is CI and documentation work rather than session-persistence code: `#333` promotes the cross-platform smoke job from advisory to required, `#337` widens the Windows ConPTY probe timeouts, `#336` fixes the `enrichResumedSessionAsync` throwaway-copy bug, and `#334`/`#335`/`#338`/`#339`/`#341`/`#342`/`#343` are docs and backlog entries. `#340` is *not* in this list — it is the only 08-01 PR that went to `main` directly (see Step 0.5).

**This roster grows whenever anything merges into the branch, including this document's own updates.** `#342` and `#343` are edits to *this file*. Recount rather than trusting the number above — the command is below.

**This runbook is itself stranded content.** `LANDING-integration-to-main.md`, `docs/landing/` and `docs/testing/cross-platform-ci.md` exist only on the integration branch; all three are **absent from `origin/main`**. Landing the branch has to make a deliberate choice about them — carry them to `main` as the record of how it was done, or drop them as scaffolding — and either way it should be a decision, not an oversight. They will show up in any final tree comparison against the branch.

Every one was opened against `integration/missing-prs-2026-07-23`, went green on the full CI matrix, and was **squash-merged** — so each is exactly one commit on the spine, with a conventional title and a written rationale. That makes this group qualitatively different from Groups B–D:

- **No duplication.** These were rebased onto the branch tip before merging, one at a time.
- **No merge-fixup noise.** They are squashes, not merges — they do not appear in the 63-merge DAG count.
- **They are already reviewed.** Each has a PR body explaining the change and its verification.

**They are therefore the cheapest group to land, not the most expensive.** Cherry-pick each squash commit onto a branch from `main`, in ascending order, one PR at a time. They form a genuine stack — later ones assume earlier ones' types in `src/types.ts`, `src/api/types/api-deps.ts`, `src/db/repositories/managed-sessions.repository.ts` and `src/pty-host/` — so order is not optional.

Dependency notes that matter when re-landing:

| Commit | Depends on |
|---|---|
| `#311` rehydration | `#309`'s `runtime.db` split |
| `#319` Codex resume identity | `#318`'s `boot_token` (`classifySession`'s 4th parameter) |
| `#321` diagnostics | `#320`'s `PROBE_SET_MAX`, and it renames `shouldRehydrate` → `rehydrateSkipReason` |
| `#325` pty-host process | `#322`'s protocol module |
| `#324` `resumeSession()` | touches `handleResume`, which `#319` also changed — land in order or the extraction conflicts |

**Do not treat these as Group-D spine noise.** A blanket "triage every non-merge spine commit" pass would put 38 reviewed, tested, conventional-commit PRs into the same bucket as merge fixups. Filter them out first — match the squash shape rather than a number range, because several titles carry a trailing `[skip-ci]`:

```bash
G=/opt/homebrew/bin/git
$G log --first-parent --no-merges --format='%h %s' origin/main..origin/integration/missing-prs-2026-07-23 \
  | /usr/bin/grep -E '\(#[0-9]+\)( \[skip-ci\])?$'
```

That reports **44** commits as of 2026-08-01: the 38 above, Group F's 4, `fad5d5f` (#298, covered by open PR #297), and `518ede9` (#269), which is a duplicate of `8b49ad7` already on `main` — discard that one. Re-run it rather than trusting the count; it rises by one for every merge into the branch.

**Unfinished work this group depends on** — do not assume the feature is complete on landing:

- The plan is now **complete** on the streamer side: the pty-host is wired behind a default-off `ptyHost` feature flag (#329–#332), and auto-resume reads `auto_resume_on_boot` (#327–#328).
- **PR M2** (tb-mobile adopting `interruptedStatus`) is optional and not done — the only outstanding plan item, and it lives in the other repo.

Landing this group on `main` is therefore safe — the incomplete parts are unreachable — but the docs it adds to `CLAUDE.md` describe a partially-built feature. Say so in the landing PRs.

### Group F — the 07-26 live-activity push block (4 PRs) → stranded, and previously unrecorded

**Added 2026-08-01.** Found by diffing this document against the branch spine: four PRs were squash-merged onto this branch on 2026-07-26 and appear in **no group above**. They are not merge noise and not duplicates — nothing carries them to `main`.

| Commit | PR | Title |
|---|---|---|
| `6a01792` | `#292` | `feat(push): persist device push tokens` |
| `9f85ec5` | `#293` | `feat(push): add direct apns sender for live activities` |
| `03d2f11` | `#294` | `feat(push): renew live activities before the 8h cap` |
| `342c61c` | `#296` | `fix(ci): clear the biome failures blocking every open pr` |

Verified stranded: `src/db/repositories/push.repository.ts` and `src/services/push/apnsClient.ts` are **absent from `origin/main`**. All four head branches (`feat/push-token-store`, `feat/apns-live-activity-sender`, `feat/live-activity-renewal`, `fix/ci-lint-baseline`) were deleted on merge — reach them via `origin/pr/<N>` after the PR-head fetch, or via the spine commits above.

`#292` → `#293` → `#294` are a stack in that order — the sender needs the token store, and the renewal loop needs the sender. This is the iOS Live Activity push feature that `CLAUDE.md` documents; landing the docs without these three would describe a feature `main` does not have. `#296` is independent and may already be moot on today's `main` — check whether `npx biome check .` is clean there before recovering it.

`#298` (`fad5d5f`) sits next to this block on the spine and looks like a fifth member. It is not: it is a cherry-pick of **`#297`, which is still open against `main`**. Merge `#297` (Group A) rather than recovering `fad5d5f`.

### Group D — 58 direct commits on the branch spine → triage required

**Revised 2026-08-01: 73 → 86 → 58.** The number *fell* because the spine is now classified properly: 102 non-merge first-parent commits, minus the 44 squash-merged PRs (Groups E and F, plus `#269`/`#298`), leaves **58** genuine direct commits to triage.

This 58 is the one count in this document that has held steady while the others moved — every merge into the branch since has been a squash-merged PR, so it lands in Group E rather than here. Treat a *rise* in this number as a signal that someone pushed to the branch directly.

Not attributable to any PR. Expect a mix of:

- **merge-conflict fixups** — meaningless outside this branch; must **not** be carried to `main`
- **real fixes** made directly on the branch — must be carried

**Worked example, so the second kind is not theoretical:** `90c1c07` (`feat(config): add server feature-flag registry with boot-time resolution`, 2026-07-28) is a Group-D commit by this definition — no PR suffix, made straight on the branch — and it is an entire feature that `CLAUDE.md` documents as shipped. Its only open PR (`#304`) is unmergeable drift. Triage that treats "no `(#NNN)` suffix" as "probably noise" would drop it.

Identify them with:

```bash
G=/opt/homebrew/bin/git
$G log --first-parent --no-merges --format='%h %ad %s' --date=short origin/main..origin/integration/missing-prs-2026-07-23
```

Anything titled `chore(merge)`, `fix(merge)`, or resolving conflicts is Group-D noise. Everything else needs a home in Group B/C/F's PRs or a PR of its own — **after** excluding every `(#NNN)`-suffixed squash, which belongs to Group E or F and is already reviewed. Note that four of these 58 *mention* a PR number without being that PR (`e2ac107` #259, `c7f4107` #260, `a689b0c` #253, `b972dcd` #232/#237) — they are merge fixups and postmortem notes, so match on the trailing `(#NNN)` shape, not on any occurrence of `#`.

### Also — two PRs point at the integration branch (verified individually — they need opposite treatment)

Both are based on `integration/missing-prs-2026-07-23`, but checking each against the branch gives different answers. Do **not** treat them as a pair.

**`#295` (`fix/bind-retry-test-flake`) — fully absorbed. Close it; do not re-target.**

```
git cherry: unique(+)=0   already(-)=23
branch      61172af  fix(test): stop the bind-retry suite flaking on the startup warm-up scan
integration 20c02fc  same subject  ->  IDENTICAL PATCH (git patch-id --stable)
```

Every non-merge commit is already on the branch, including its titular fix. It is also **103 commits behind**, which is why `gh pr diff` reports 180+ files — that is staleness, not content. Re-targeting it to `main` would open a PR carrying 103 commits of drift for a fix that already exists. The bind-retry fix reaches `main` via whichever PR carries `20c02fc`.

*Branch hygiene note:* this branch also committed `auto: .remember …` commits — session-local memory files, `.tar.gz` archives, a `save-session.pid`. Contained: `.remember/` is gitignored (`.gitignore:42`) and **0 such files are tracked** on either the integration branch or `main`, so closing `#295` ends it. Nothing to clean up elsewhere.

**`#303` (`docs/provider-version-drift-check-design`) — genuinely new content, but it belongs on this branch, not `main`.**

```
git cherry: unique(+)=2   already(-)=1
docs/superpowers/specs/2026-07-27-provider-version-drift-check-design.md   ABSENT from integration
031a942  docs(providers): simplify drift-check and update-flow design          <- new
3968cf3  docs(providers): add provider version drift check … design spec       <- new
2c32aa6  feat(live-activity): retime pushes to per-turn …                      <- already on branch
```

**Resolved — superseded by PR #317, which has since merged (2026-07-31).** Re-targeting `#303` to `main` was the original plan, but its spec cites `providerHealth.ts` and the C2 architecture doc, both of which exist only on this branch (they came with `#282` and never reached `main`). On `main` today it would ship dangling references.

Merging `#303` as-is was also not viable: it is 17 commits behind and reports `CONFLICTING`, on `docs/compatibility/tb-mobile.md` — a conflict caused entirely by staleness, for content this branch already has via `2c32aa6`.

PR **#317** cherry-picks only its two genuinely-new commits (`3968cf3`, `031a942`) onto this branch. One file, no conflicts. Close `#303` once #317 merges, and see the Group C note about carrying the spec with `#282`.

**Generalise this.** Any other PR based on the integration branch gets the same two-step check before being re-targeted — `git cherry` for unique commits, then confirm a distinctive file or symbol is genuinely absent. A stale PR pointed at `main` is worse than a closed one.

---

## Step 0 — Freeze and re-target — **complete**

1. ~~Announce the freeze on `integration/missing-prs-2026-07-23`.~~ **Done 2026-08-01** — development on this repo is frozen; new work branches from `main`.
2. ~~Resolve the two PRs based on this branch.~~ **Done 2026-07-31** — both closed. `#303` was superseded by PR #317, which cherry-picked its two new commits onto this branch; `#295` was closed as fully absorbed (0 unique commits, patch-identical to `20c02fc`). The section above is kept as the record of *how* each was verified, because the same two-step check applies to any future PR based on this branch.
3. ~~Delete or clearly mark the stale sibling branches.~~ **Done** — verified 2026-08-01 that `integration/merge-missing-prs-2026-07-26`, `integration/rebase-missing-prs-2026-07-26` and `backup/integration-missing-prs-2026-07-23-pre-sync` are all gone from `origin`, along with Group B's base `integration-dev/v1.0.0-2026-07-22`. Local worktrees may still hold checkouts of the deleted branches; `git worktree list` will show them and they are safe to remove.

---

## Step 0.5 — Land `main`'s CI first *(added 2026-08-01)*

**Do this before Group A.** Everything downstream is verified by `main`'s CI, and `main`'s CI is currently weaker than the integration branch's — so every PR landed before this step is checked less thoroughly than it will be afterwards.

`main`'s `.github/workflows/ci.yml` has **no `smoke` job**: it runs ubuntu-only, while the repo ships Windows and macOS deploy scripts, has Windows-specific process discovery, and depends on node-pty, whose prebuilds differ per platform. That is precisely the coverage Group A's `#272` (Windows updater) and the discovery path-separator fixes need.

[PR #340](https://github.com/RonenMars/threadbase-streamer/pull/340) ports the `smoke` job and widens the triggers to `[main, 'integration/**']`. It deliberately excludes the expanded `test:smoke` script and `__tests__/ci-workflow.test.ts`, both of which reference `pty-host` files that do not exist on `main` — those follow with Group E.

**It also unblocks the ruleset.** `main protection` cannot require `Smoke (macos-latest)` / `Smoke (windows-latest)` until `main` can produce them. Adding them first is not merely useless — it makes **every** PR to `main` permanently unmergeable, which happened on 2026-08-01 and had to be reverted. See the warning in [`docs/testing/cross-platform-ci.md`](docs/testing/cross-platform-ci.md).

Sequence:

1. ~~Merge #340.~~ **Done 2026-08-01** — squash-merged as `28da612`.
2. ~~Confirm both Smoke contexts report on a real PR to `main`.~~ **Done** — #340's own run reported `Smoke (macos-latest)` and `Smoke (windows-latest)` green against `main`.
3. ~~Re-add them to the ruleset.~~ **Done** — `main protection` (ruleset `17561930`) now requires `Gate`, `Setup`, `Lint`, `Test (Node 20|22|24)`, `Build`, `Smoke (macos-latest)`, `Smoke (windows-latest)`. Expanded names only.
4. Then start Step 1. **← this is where the work resumes.**

---

## Step 1 — Land Group A, one PR at a time

Per `CLAUDE.md` → "One PR at a time": rebase onto latest `main`, wait for green, squash-merge, then move to the next. A merged PR advances `main`, so the next is behind and must be rebased again.

```bash
G=/opt/homebrew/bin/git
$G fetch origin && $G checkout <pr-branch> && $G rebase origin/main
# resolve preserving the PR's intent, then:
$G push --force-with-lease
gh pr merge <n> --squash --delete-branch     # squash IS correct here — see note below
```

**Squash-merge is right for Group A**, unlike the mobile runbook's rebase-merge guidance. That guidance existed only because mobile's slices were contiguous ranges of one linear history where squashing broke the stack. These are independent PRs, so the repo's normal squash convention applies unchanged.

After each merge, confirm the integration branch shrinks:

```bash
$G fetch origin && $G rev-list --count origin/main..origin/integration/missing-prs-2026-07-23
```

That number should drop as Group A lands. If it does not move for a PR, that PR's content was already on `main` — verify with `git cherry` before assuming otherwise:

```bash
$G cherry origin/main origin/<pr-branch>     # '-' = already applied, '+' = genuinely new
```

---

## Step 2 — Recover Groups B and C as fresh PRs

One PR per logical change, branched from the **current** `main` (after Group A has landed, so conflicts are minimal).

```bash
$G checkout -b <type>/<scope>-<summary> origin/main
$G cherry-pick <sha>...                       # commits belonging to that PR
npm run lint && npm test
$G push -u origin <branch>
gh pr create --base main --title "<type>(<scope>): <summary>"
```

To find a closed/merged PR's commits on the branch:

```bash
$G log --format='%h %s' origin/main..origin/integration/missing-prs-2026-07-23 --grep '<distinctive words>'
```

Land Group C's features **in their original order** (`#276` → `#281` → `#282` → `#283` → `#284` → `#285` → `#287`) — they were developed as a stack and later ones assume earlier ones' types in `src/types.ts` and `src/api/types/api-deps.ts`.

---

## Step 3 — Reconcile and retire the branch

Once Groups A–D have landed, the branch should contain nothing new:

```bash
$G fetch origin
$G cherry origin/main origin/integration/missing-prs-2026-07-23 | grep '^+' | wc -l
# target: 0
```

Anything still reported `+` is unlanded content — trace each with the Group-D command before deciding to carry or discard it. Do **not** assume leftovers are noise; the mobile triage found genuinely unmerged work (docs) hiding among apparent duplicates.

Then delete the branch.

### Escape hatch — **no longer available (2026-08-01)**

This used to read: because `main` **is** an ancestor of the integration tip, the whole branch can be fast-forwarded in one move.

```bash
$G checkout main && $G merge --ff-only origin/integration/missing-prs-2026-07-23   # now fails
```

That stopped being true on 2026-07-31, when #224 and #226 merged to `main`; #340 added a third. `main` has **3 commits the integration branch does not have**, so `--ff-only` now aborts with "not possible to fast-forward". The only remaining bulk option is an ordinary merge commit, which the `required_linear_history` rule on `main protection` forbids. There is no shortcut left — the staged approach is now the *only* approach.

**Do not read the patch-level finding as a reprieve.** Two of those three commits are patch-duplicates of work this branch already has, so the *content* divergence is one commit — but `--ff-only` tests ancestry, and ancestry is broken by all three. The distinction is useful for costing a reconciliation, not for reviving this hatch.

---

## Verification

**Per PR, before pushing:**

```bash
npm run lint          # tsc --noEmit && biome check .
npm test              # vitest run
npm run build         # tsup — catches emit-only breakage lint misses
```

For PRs touching contracts or end-to-end behaviour:

```bash
npm run test:contracts
npm run test:e2e
```

**Per PR, in CI** — required green: `gate`, `setup`, `warm-caches`, `lint`, `build`, `smoke`, `test`. `smoke` runs a cross-OS matrix, so Windows-specific changes (`#272`, the discovery path-separator fixes) must be watched there specifically. **Step 0.5 has landed**, so `main` produces `Smoke (macos-latest)` / `Smoke (windows-latest)` and both are required by the ruleset — an open PR to `main` created before #340 will need a rebase before those contexts appear.

**After the last PR lands** — confirm `main` runs:

```bash
npm ci && npm run build && npm test
node dist/index.js --help      # or the documented boot command
```

Then pair a tb-mobile client against it and confirm session list, conversation detail and PTY streaming still work — several of these PRs change the mobile-facing contract (`#267` session_name, `#299` terminal seq, `#282` provider capabilities).

---

## Risks

| Risk | Mitigation |
|---|---|
| Group-D merge-fixups leak onto `main` | Triage every non-merge spine commit; `chore(merge)`-style titles are noise. |
| Stacked PRs merged out of order | Follow the dependency table; merge base PR first, then rebase the child. |
| `src/server.ts` conflicts (56 touches) | One PR at a time; never rebase two in parallel. |
| Contract drift breaks tb-mobile | Run `test:contracts`; verify against a real mobile client after landing. |
| The drift-check spec lost during Group C recovery | It has no PR to `main` and reads as free-standing. The Group C note is the only pointer — carry it in `#282`'s PR. |
| Re-targeting a stale PR that is already absorbed | Verified per PR: `#295` has 0 unique commits and must be **closed**, not re-targeted. Apply the same `git cherry` check to any other PR based on this branch. |
| Assuming leftovers are duplicates | Verify with `git cherry` / `git patch-id`; same-subject ≠ same patch. |
| A whole block of stranded PRs going unrecorded | Group F (#292–#296) sat outside every group for six days, and Group A′ found 15 more open PRs no group covered. Two sweeps catch both: the `(#NNN)`-suffix spine scan for merged work, and `gh pr list --state open` cross-checked against this document's rosters for unmerged work. |
| Treating an unsuffixed spine commit as noise | `90c1c07` (feature-flag registry) is a whole documented feature with no PR suffix and no mergeable PR. Read every Group-D subject before discarding it. |
| Re-landing something `main` already has | `#224`, `#226`, `#269` and `#340` are on `main` now. Check `git log origin/main --grep` before cherry-picking any commit dated 07-23 or later. |
| A group silently skipped because its branch is gone | Groups C and F have **no** head branches on `origin` — a pass that reads a missing ref as "nothing to do" drops 11 PRs without erroring. Fetch `refs/pull/*/head` first and assert each group's refs resolve before starting it. |
| Trusting a count in this document | Every commit/PR count here moves when anything merges into the branch. Each is dated; re-run the command beside it rather than quoting the number. |

**Rollback:** Group A merges are ordinary squash-merges — revert the single commit. Groups B/C are fresh PRs, revertible the same way. The integration branch is never rewritten and stays available as a reference until Step 3 confirms it is empty.

---

## Cost note

Group A is 11 ordinary PR merges remaining (10 listed plus `#297`) — mostly mechanical, and two are dependabot bumps. Two of the original 12 have already landed.

Group A′ adds 13 more of the same kind (12 contained-in-branch PRs plus `#302`), all needing a rebase before they can produce the now-required Smoke contexts, plus two that need a decision rather than a merge (`#245`, `#304`).

Group E is 38 squash commits to cherry-pick in order — far more PRs than any other group, but the cheapest per PR: each is one commit, already reviewed, already CI-green, with a written rationale.

Group F is 4 more of the same shape, with the added catch that nothing but this document points at them.

The real work remains Groups B, C and D: ~11 PRs' worth of stranded content plus **58** spine commits to triage once Groups E and F are filtered out. That is where the estimate should go, and it is the direct cost of having merged PRs into an integration branch instead of `main`.

**The cost stopped growing on 2026-08-01, when development froze.** This runbook was written when the gap was 221 commits; it is **250** now, because a whole feature programme — 38 PRs by the time it stopped — was developed on this branch after the runbook existed. The live streamer is deployed from here, which is what kept making it the path of least resistance. With the freeze in place the number is finally stable, which is what makes a full rehearsal worth running: the target no longer moves. Landing Group A + Group E would cut the gap substantially and is the highest-value next move; Step 0 and Step 0.5 are both done, so Step 1 can start immediately.

The cheapest way to avoid repeating this: land PRs on `main` and use integration branches only as short-lived, throwaway test vehicles that are never merged into.
