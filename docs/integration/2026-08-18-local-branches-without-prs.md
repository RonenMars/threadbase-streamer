# Local branches without a PR — 2026-08-18

Snapshot of local branches and worktrees on this machine that have **no GitHub PR whose head is that branch name**, then whether their code is already on latest `origin/main` or unique to the branch.

Covers **threadbase-streamer** and **threadbase-mobile**. This is a snapshot, not a worklist. GitHub is the worklist.

Checked 2026-08-18; `origin/main` was fetched again on 2026-08-18 before the uniqueness pass (`streamer` `2cf660a..a45b855`, `mobile` `2b53bf1d..36165ce7`).

## Method

1. List local heads and worktrees (`git branch -vv`, `git worktree list`).
2. For each non-`main` branch, `gh pr list --head <branch> --state all`.
3. Against latest `origin/main`:
   - SHA containment (`git merge-base --is-ancestor`).
   - File-level blob compare vs the merge-base: **same blob as main** = already landed; **only on the branch** (or main still at the merge-base blob) = unique; **both sides changed** = diverged (main moved on).

`git cherry` is not used as proof of “unmerged”. Squash-merges rewrite patch ids, so `+` is the normal state of every landed branch. Same trap as [2026-08-14-branch-inventory.md](2026-08-14-branch-inventory.md).

**Bottom line:** nothing in the no-PR set is unmerged feature work. It is old integration/worktree leftovers. The only content not byte-identical on main is archived or deleted docs.

---

## threadbase-streamer — no PR

### Local-only (no origin tracking)

| Branch | Worktree |
|--------|----------|
| `delete` | — |
| `feat/live-external-sessions-rebased` | `worktrees/streamer-rebase-prs` |
| `fix/windows-deploy-progress` | `worktrees/threadbase-streamer-windows-deploy-progress` |
| `integration-dev/v1.0.0-07d0812-2026-07-22-deps` | `worktrees/streamer-integration-deps` |
| `worktree-merge-all-open-prs` | — |

### On origin, but never a PR under this name

| Branch | Worktree |
|--------|----------|
| `fix/test-isolation-remaining` | `worktrees/streamer-fix-remaining` |
| `integration-dev/v1.0.0-2026-07-22` | `worktrees/streamer-merge-all-prs` |
| `integration/2026-08-08_14-22-prs-441-442-444-446-447-448-449-450-451-452-453-454` | — |
| `integration/missing-prs-2026-07-23` | — |
| `integration/prs-223-441-442-444-446-447-448-449-450-451-452-453-454-455-456` | — |
| `test/all-work-2026-08-13` | — |

### Detached worktree

| Path | HEAD |
|------|------|
| `worktrees/deploy-main` | `e587bd30` (detached) |

The only local streamer feature branch with an **open** PR at check time was `feat/hold-when-idle` (#646) — not in this no-PR set.

---

## threadbase-mobile — no PR under this local name

### Integration / scratch

| Branch | Worktree |
|--------|----------|
| `integration-dev/v1.0.0-2026-07-22` | `worktrees/merge-prs-v2` |
| `integration-dev/v1.0.0-bfc800d-2026-07-20` | `.claude/worktrees/merge-open-prs` |
| `integration/open-prs` | — |

### Local aliases (no PR named `pr*-fix`; they track remotes that did have PRs)

| Local branch | Tracks | Worktree |
|--------------|--------|----------|
| `pr346-fix` | `origin/fix/abandoned-empty-sessions` | `worktrees/pr346` |
| `pr360-fix` | `origin/feat/onboarding-polish-top5` | `.claude/worktrees/pr360` |
| `pr362-fix` | `origin/fix/onboarding-pair-token-exchange` | `worktrees/pr362` |

### Detached worktree

| Path | Notes |
|------|--------|
| `worktrees/ci-i18n-verify` | Detached at the `ci/i18n-parity-gate` commit (that branch had closed PR #368) |

The only local mobile feature branch with an **open** PR at check time was `feat/session-leave-action` (#773). Checkout `chore/agents-setup-cloudflared-and-ship` had already merged as #775.

---

## Uniqueness vs latest `origin/main`

### threadbase-streamer

**Already in main (SHA ancestor, 0 unique commits)**

| Ref | Notes |
|-----|--------|
| `delete` | Ancestor of main; 0 unique commits |
| `worktrees/deploy-main` (detached) | Same |

**Work landed; remaining files only diverged because main kept moving**

| Branch | Notes |
|--------|--------|
| `fix/windows-deploy-progress` | Same work as merged #464 on `fix/windows-deploy-version-check` |
| `integration/2026-08-08_14-22-prs-441-442-444-446-447-448-449-450-451-452-453-454` | Integration rollup |
| `integration/prs-223-441-442-444-446-447-448-449-450-451-452-453-454-455-456` | Integration rollup |
| `test/all-work-2026-08-13` | Throwaway; also noted in the 2026-08-14 inventory |

**Looks “unique” but the only extra files are three July pre-release markdowns** that now live on main under `docs/archive/pre-release-snapshots/`:

- `docs/pre-release-backlog-roadmap-analysis-2026-07-18.md`
- `docs/pre-release-issues-cursor.md`
- `docs/pre-release-open-issues-by-severity-2026-07-18.md`

Feature/test code on these branches is already on main or superseded:

| Branch | Notes |
|--------|--------|
| `feat/live-external-sessions-rebased` | Live-sessions merged as #253 |
| `fix/test-isolation-remaining` | Isolation work landed elsewhere |
| `integration-dev/v1.0.0-07d0812-2026-07-22-deps` | Integration rollup |
| `integration-dev/v1.0.0-2026-07-22` | Integration rollup |
| `integration/missing-prs-2026-07-23` | Integration rollup |
| `worktree-merge-all-open-prs` | Merge scratch |

Rebasing any of those onto current main would either be a no-op or resurrect archived doc paths.

### threadbase-mobile

**Work landed; no unique blobs vs current main**

| Branch | Notes |
|--------|--------|
| `pr346-fix` | Abandoned-empty-sessions / stop-on-back; files evolved on main |
| `pr360-fix` | Onboarding polish |
| `pr362-fix` | Pair-token exchange |
| `integration-dev/v1.0.0-bfc800d-2026-07-20` | Integration rollup |
| `integration/open-prs` | Integration rollup |
| `worktrees/ci-i18n-verify` | i18n job is already on main (`.github/workflows/test.yml`); original PR #368 was closed after landing another way |

**One unique file, and it is an intentional delete on main**

| Branch | Notes |
|--------|--------|
| `integration-dev/v1.0.0-2026-07-22` | Only leftover blob is `KICKOFF-landing-runbook.md`, which #474 removed. Rebasing would resurrect a file main deleted on purpose. |

---

## Counts (at check time)

| Repo | Local branches in the no-PR set | Worktrees tied to those branches / detached |
|------|----------------------------------|-----------------------------------------------|
| streamer | 11 branches + 1 detached | 13 streamer worktrees listed in the first pass (including ones whose branches *did* have PRs) |
| mobile | 6 branches + 1 detached | listed above |

Streamer local branches that *did* have a PR (for contrast, not cleanup candidates from this pass): `#620` MERGED through `#646` OPEN and older merged heads such as `#232`, `#234`, `#251` CLOSED, `#252`–`#272`, `#348`, `#350`, `#442`, `#447`, `#455`, `#464`, `#520`, `#523`, `#565`, `#644`, `#645`.
