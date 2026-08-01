# Landing `integration/missing-prs-2026-07-23` onto `main`

## Context

`integration/missing-prs-2026-07-23` was assembled to test a batch of open PRs together. It has since become a parallel trunk: `main` is **249 commits behind** it, work kept landing on the integration branch instead of on `main`, and two PRs (#303, #295) now target the integration branch rather than `main`.

> **Updated 2026-08-01.** The gap grew from 221 to 241 because a further 26 PRs (#301–#332) were developed and merged **onto this branch**, not onto `main` — the whole live-sessions-persistence plan, Phases 0 through 7. That is a new stranded group (**Group E**) and it is now the largest single block of unlanded work. The live streamer is deployed from this branch (`1.33.0+80a2b40`), so `main` is not what is running in production.

> **Re-audited 2026-08-01, late.** Three things changed and one was previously missed.
> **(a)** `main` has moved: #224 and #226 merged to it on 07-31 and #340 on 08-01, so `main` is **no longer an ancestor** of this branch — the fast-forward escape hatch at the end of this runbook no longer works.
> **(b)** Group E has grown from 26 PRs to **37** — #333–#339 and #341 all merged onto this branch after the group was first written.
> **(c)** A previously unrecorded block exists: **#292, #293, #294, #296** were squash-merged onto this branch back on 07-26 and belong to no group in this document. They are now **Group F**.

The goal is to get that work onto `main` without replaying an unreviewable 221-commit history.

**This runbook deliberately differs from the tb-mobile one.** The mobile integration branch is linear (0 merge commits) and had to be sliced. This branch is a merge DAG assembled *from PRs that still exist*, so the right move is to land those PRs — not to slice the branch.

**Deliberately out of scope:** any behaviour change. This is a merge/landing operation. If something must be fixed to go green, that fix belongs to the PR that needs it.

---

## Measured facts

Against `origin/main` and `origin/integration/missing-prs-2026-07-23`:

| Fact | Value (2026-08-01, re-measured after #340/#341) | Consequence |
|---|---|---|
| Commits ahead of `main` | **249** (07-18 → 08-01) | Far too many to review as one PR |
| Merge commits in range | **63** | History is a **DAG, not linear** — slicing/rebasing is the wrong tool |
| `main`-only commits | **3** (`bfdc2c9` #224, `2c1b038` #226, `28da612` #340) | `main` is **no longer an ancestor** → the fast-forward escape hatch is **dead** |
| Same-subject commits | **61 of 221** (measured before Group E) | Heavy duplication from repeated re-merges |
| First-parent spine commits (non-merge) | **101** | Of which **43** are squash-merged PRs (37 Group E, 4 Group F, plus `#298` and the `#269` duplicate) and **58** are direct commits needing triage — see Group D |
| PRs the branch integrated | **23** via `chore(merge): integrate PR #NNN`, plus **43** squash-merged directly (#269, #292–#298, #301–#341) | The branch documents its own provenance — use it |

### Contrast with tb-mobile (why the strategy differs)

| | tb-mobile | tb-streamer |
|---|---|---|
| Merge commits | 0 (linear) | **63** (DAG) |
| `main` an ancestor? | No (2 divergent commits) | **No longer** (3 divergent commits since 07-31) |
| Duplicate commits | 9 | **61** |
| Source PRs recoverable? | No — direct pushes | **Yes — 23, named in commits** |
| Strategy | Slice the linear history | **Land the original PRs** |

Rebasing 63 merges into a line would explode them into replayed commits and conflict heavily, and the 61 duplicates would carry re-merge noise onto `main`. Slicing is the wrong instrument here.

### Hotspot files

| File | Commits touching it |
|---|---|
| `src/server.ts` | 56 |
| `__tests__/server.test.ts` | 38 |
| `src/types.ts` | 25 |
| `CLAUDE.md` | 17 |
| `src/api/types/api-deps.ts` | 15 |
| `src/pty-manager.ts` | 13 |

`src/server.ts` at 56 touches is the main conflict surface. It is a further argument against thematic cherry-picking, and a reason to land PRs **one at a time** rather than in parallel.

---

## The work splits six ways

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

### Group B — closed against a dead base (4) → content is stranded

`#271` `#273` `#274` `#275` — all based on `integration-dev/v1.0.0-2026-07-22`, a superseded integration branch. Closed, so nothing carries them to `main`, but their commits are on this branch.

Cut **one fresh PR per logical change**, branched from `main`, cherry-picking from the integration branch.

### Group C — merged into the integration branch, never to `main` (7) → content is stranded

`#276` `#281` `#282` `#283` `#284` `#285` `#287` — the C-series features (Claude CLI flags, durable session runtime, provider compatibility, status confidence, idempotency keys, device identity, push registration).

Same treatment as Group B: fresh PRs from `main`. These are substantial features and should be one PR each.

**Carry the drift-check spec with `#282`.** `docs/superpowers/specs/2026-07-27-provider-version-drift-check-design.md` landed on this branch via PR #317 (cherry-picked from #303). It is a design doc, so it looks like free-standing content — it is not. It cites `VERIFIED_AGAINST` in `src/services/providers/providerHealth.ts` and the "C2" section of `docs/architecture/2026-07-24-provider-compatibility.md`, both of which arrive with `#282`. Recovered on its own it ships two dangling references; recovered in `#282`'s PR the references resolve on arrival. It has no PR of its own to `main`, so nothing will surface it — this note is the only thing that will.

### Group E — the live-sessions-persistence work (37 PRs, #301–#341) → stranded, but clean

**Added 2026-08-01, roster extended the same day.** The single largest block of unlanded content, and the one that behaves *least* like the rest of this branch.

`#301` `#305` `#306` `#307` `#308` `#309` `#310` `#311` `#312` `#313` `#314` `#315` `#316` `#317` `#318` `#319` `#320` `#321` `#322` `#323` `#324` `#325` `#326` `#327` `#328` `#329` `#330` `#331` `#332` `#333` `#334` `#335` `#336` `#337` `#338` `#339` `#341`

**The tail (#333–#341) arrived after this group was first written** and is CI and documentation work rather than session-persistence code: `#333` promotes the cross-platform smoke job from advisory to required, `#337` widens the Windows ConPTY probe timeouts, `#336` fixes the `enrichResumedSessionAsync` throwaway-copy bug, and `#334`/`#335`/`#338`/`#339`/`#341` are docs and backlog entries. `#340` is *not* in this list — it is the only 08-01 PR that went to `main` directly (see Step 0.5).

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

**Do not treat these as Group-D spine noise.** A blanket "triage every non-merge spine commit" pass would put 37 reviewed, tested, conventional-commit PRs into the same bucket as merge fixups. Filter them out first — match the squash shape rather than a number range, because several titles carry a trailing `[skip-ci]`:

```bash
G=/opt/homebrew/bin/git
$G log --first-parent --no-merges --format='%h %s' origin/main..origin/integration/missing-prs-2026-07-23 \
  | /usr/bin/grep -E '\(#[0-9]+\)( \[skip-ci\])?$'
```

That reports **43** commits: the 37 above, Group F's 4, `fad5d5f` (#298, covered by open PR #297), and `518ede9` (#269), which is a duplicate of `8b49ad7` already on `main` — discard that one.

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

Verified stranded: `src/db/repositories/push.repository.ts` and `src/services/push/apnsClient.ts` are **absent from `origin/main`**. Their head branches were deleted on merge, so the squash commits on this spine are the only copies.

`#292` → `#293` → `#294` are a stack in that order — the sender needs the token store, and the renewal loop needs the sender. This is the iOS Live Activity push feature that `CLAUDE.md` documents; landing the docs without these three would describe a feature `main` does not have. `#296` is independent and may already be moot on today's `main` — check whether `npx biome check .` is clean there before recovering it.

`#298` (`fad5d5f`) sits next to this block on the spine and looks like a fifth member. It is not: it is a cherry-pick of **`#297`, which is still open against `main`**. Merge `#297` (Group A) rather than recovering `fad5d5f`.

### Group D — 58 direct commits on the branch spine → triage required

**Revised 2026-08-01: 73 → 86 → 58.** The number *fell* because the spine is now classified properly: 101 non-merge first-parent commits, minus the 43 squash-merged PRs (Groups E and F, plus `#269`/`#298`), leaves **58** genuine direct commits to triage.

Not attributable to any PR. Expect a mix of:

- **merge-conflict fixups** — meaningless outside this branch; must **not** be carried to `main`
- **real fixes** made directly on the branch — must be carried

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

## Step 0 — Freeze and re-target

1. Announce the freeze on `integration/missing-prs-2026-07-23`. New work branches from `main`.
2. Resolve the two PRs based on this branch — **verified, and they need opposite handling** (see the section above):
   - **`#303`** → **done via PR #317**, which cherry-picked its two new commits onto this branch (its spec references files that exist only here). Close `#303` once #317 merges.
   - **`#295`** → **close it.** `git cherry` reports 0 unique commits and its fix is patch-identical to `20c02fc`, already on the branch.
3. Delete or clearly mark the stale sibling branches so nobody re-integrates into them:
   `integration/merge-missing-prs-2026-07-26`, `integration/rebase-missing-prs-2026-07-26`,
   `backup/integration-missing-prs-2026-07-23-pre-sync`.

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
| A whole block of stranded PRs going unrecorded | Group F (#292–#296) sat outside every group for six days. Re-run the `(#NNN)`-suffix spine scan against this document's rosters whenever the branch moves; a squash commit whose PR number appears in no group is unlanded work. |
| Re-landing something `main` already has | `#224`, `#226`, `#269` and `#340` are on `main` now. Check `git log origin/main --grep` before cherry-picking any commit dated 07-23 or later. |

**Rollback:** Group A merges are ordinary squash-merges — revert the single commit. Groups B/C are fresh PRs, revertible the same way. The integration branch is never rewritten and stays available as a reference until Step 3 confirms it is empty.

---

## Cost note

Group A is 11 ordinary PR merges remaining (10 listed plus `#297`) — mostly mechanical, and two are dependabot bumps. Two of the original 12 have already landed.

Group E is 37 squash commits to cherry-pick in order — far more PRs than any other group, but the cheapest per PR: each is one commit, already reviewed, already CI-green, with a written rationale.

Group F is 4 more of the same shape, with the added catch that nothing but this document points at them.

The real work remains Groups B, C and D: ~11 PRs' worth of stranded content plus **58** spine commits to triage once Groups E and F are filtered out. That is where the estimate should go, and it is the direct cost of having merged PRs into an integration branch instead of `main`.

**The cost is still growing.** This runbook was written when the gap was 221 commits; it is **249** now, because a whole feature programme — 37 PRs by the time it stopped — was developed on this branch after the runbook existed. The live streamer is deployed from here, which is what keeps making it the path of least resistance. Landing Group A + Group E would cut the gap substantially and is the highest-value next move; Step 0.5 is done, so Step 1 can start immediately.

The cheapest way to avoid repeating this: land PRs on `main` and use integration branches only as short-lived, throwaway test vehicles that are never merged into.
