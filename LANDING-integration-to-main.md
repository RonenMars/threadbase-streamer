# Landing `integration/missing-prs-2026-07-23` onto `main`

## Context

`integration/missing-prs-2026-07-23` was assembled to test a batch of open PRs together. It has since become a parallel trunk: `main` is **221 commits behind** it, work kept landing on the integration branch instead of on `main`, and two PRs (#303, #295) now target the integration branch rather than `main`.

The goal is to get that work onto `main` without replaying an unreviewable 221-commit history.

**This runbook deliberately differs from the tb-mobile one.** The mobile integration branch is linear (0 merge commits) and had to be sliced. This branch is a merge DAG assembled *from PRs that still exist*, so the right move is to land those PRs — not to slice the branch.

**Deliberately out of scope:** any behaviour change. This is a merge/landing operation. If something must be fixed to go green, that fix belongs to the PR that needs it.

---

## Measured facts

Against `origin/main` and `origin/integration/missing-prs-2026-07-23`:

| Fact | Value | Consequence |
|---|---|---|
| Commits ahead of `main` | **221** (07-18 → 07-31) | Far too many to review as one PR |
| Merge commits in range | **63** (51 on the first-parent spine) | History is a **DAG, not linear** — slicing/rebasing is the wrong tool |
| `main`-only commits | **0** | `main` **is an ancestor** → fast-forward is possible |
| Same-subject commits | **61 of 221** | Heavy duplication from repeated re-merges |
| First-parent spine | 124 = 51 merges + **73 direct commits** | 73 commits were made on the branch, not via any PR |
| PRs the branch integrated | **23**, named in `chore(merge): integrate PR #NNN` commits | The branch documents its own provenance — use it |

### Contrast with tb-mobile (why the strategy differs)

| | tb-mobile | tb-streamer |
|---|---|---|
| Merge commits | 0 (linear) | **63** (DAG) |
| `main` an ancestor? | No (2 divergent commits) | **Yes** |
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

## The work splits four ways

Derived from the `integrate PR #NNN` commits plus each PR's current state.

### Group A — still open against `main` (12) → just merge them

No new PRs needed. Their content is already reviewed and targeted correctly.

`#224` `#226` `#227` `#237` `#253` `#254` `#264` `#266` `#267` `#270` `#272` `#299`

**Dependency order matters — three are stacked on feature branches, not `main`:**

| PR | Base | Merge after |
|---|---|---|
| `#254` | `feat/live-external-sessions` | `#253` |
| `#266` | `fix/stale-conversation-history` | that branch's PR |
| `#234` | `feat/cache-integrity-alert` | `#232` |

Suggested order: dependency-free dependabot bumps first (`#224`, `#226`, `#227`, `#264`) to get easy merges out of the way, then `#237`, `#267`, `#270`, `#272`, `#299`, then the stacked chains (`#253` → `#254`; `#232` → `#234`; `#266`).

### Group B — closed against a dead base (4) → content is stranded

`#271` `#273` `#274` `#275` — all based on `integration-dev/v1.0.0-2026-07-22`, a superseded integration branch. Closed, so nothing carries them to `main`, but their commits are on this branch.

Cut **one fresh PR per logical change**, branched from `main`, cherry-picking from the integration branch.

### Group C — merged into the integration branch, never to `main` (7) → content is stranded

`#276` `#281` `#282` `#283` `#284` `#285` `#287` — the C-series features (Claude CLI flags, durable session runtime, provider compatibility, status confidence, idempotency keys, device identity, push registration).

Same treatment as Group B: fresh PRs from `main`. These are substantial features and should be one PR each.

**Carry the drift-check spec with `#282`.** `docs/superpowers/specs/2026-07-27-provider-version-drift-check-design.md` landed on this branch via PR #317 (cherry-picked from #303). It is a design doc, so it looks like free-standing content — it is not. It cites `VERIFIED_AGAINST` in `src/services/providers/providerHealth.ts` and the "C2" section of `docs/architecture/2026-07-24-provider-compatibility.md`, both of which arrive with `#282`. Recovered on its own it ships two dangling references; recovered in `#282`'s PR the references resolve on arrival. It has no PR of its own to `main`, so nothing will surface it — this note is the only thing that will.

### Group D — 73 direct commits on the branch spine → triage required

Not attributable to any PR. Expect a mix of:

- **merge-conflict fixups** — meaningless outside this branch; must **not** be carried to `main`
- **real fixes** made directly on the branch — must be carried

Identify them with:

```bash
G=/opt/homebrew/bin/git
$G log --first-parent --no-merges --format='%h %ad %s' --date=short origin/main..origin/integration/missing-prs-2026-07-23
```

Anything titled `chore(merge)`, `fix(merge)`, or resolving conflicts is Group-D noise. Everything else needs a home in Group B/C's PRs or a PR of its own.

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

**Resolved — superseded by PR #317.** Re-targeting `#303` to `main` was the original plan, but its spec cites `providerHealth.ts` and the C2 architecture doc, both of which exist only on this branch (they came with `#282` and never reached `main`). On `main` today it would ship dangling references.

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

### Escape hatch

Because `main` **is** an ancestor of the integration tip, the whole branch can be fast-forwarded in one move if the staged approach proves too slow:

```bash
$G checkout main && $G merge --ff-only origin/integration/missing-prs-2026-07-23
```

This preserves every commit and merge exactly, with zero conflicts — but it pushes 221 commits including 61 duplicates onto `main` with no review, and branch protection will block a direct push. Treat it as a last resort, not a shortcut.

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

**Per PR, in CI** — required green: `gate`, `setup`, `warm-caches`, `lint`, `build`, `smoke`, `test`. `smoke` runs a cross-OS matrix, so Windows-specific changes (`#272`, the discovery path-separator fixes) must be watched there specifically.

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

**Rollback:** Group A merges are ordinary squash-merges — revert the single commit. Groups B/C are fresh PRs, revertible the same way. The integration branch is never rewritten and stays available as a reference until Step 3 confirms it is empty.

---

## Cost note

Group A is 12 ordinary PR merges — mostly mechanical, and four are dependabot bumps.

The real work is Groups B, C and D: ~11 PRs' worth of stranded content plus 73 spine commits to triage. That is where the estimate should go, and it is the direct cost of having merged PRs into an integration branch instead of `main`.

The cheapest way to avoid repeating this: land PRs on `main` and use integration branches only as short-lived, throwaway test vehicles that are never merged into.
