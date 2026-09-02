# W1b release-notes correction — continuation prompt

Session name: `e2ee-W1b-release-notes`.

You are responsible only for delivering the already prepared Streamer release-notes compatibility correction and closing W1b Step 11.
Do not change product/runtime code and do not absorb unrelated release work.

## Read first

1. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/AGENTS.md`
2. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/PLAN-FINISH-E2EE-2026-08-30.md`, Task 1 Step 11
3. `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/W/REPORT-W1b.md`, from `Task 1E merge and release verification` onward
4. `/Users/ronenmars/dev/ai-tools/tb-streamer/AGENTS.md`
5. `/Users/ronenmars/dev/ai-tools/tb-streamer/CLAUDE.md`, especially merging and semantic-release rules
6. `~/dotfiles/docs/claude-code/merge-rebase-squash.md`
7. The `operating-git-and-github` skill before any PR, rebase, push, merge, or GitHub-writing action

## Verified starting point to re-check

- Worktree: `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/fix/release-notes-rendering`
- Branch: `fix/release-notes-rendering`
- Local and remote commit: `87354b18722922a9e9268e817abf00b6501487fb`
- Base: streamer release commit `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`
- Changed paths only:
  - `__tests__/release-notes.test.ts`
  - `package.json`
  - `package-lock.json`
- No Streamer PR is currently open.
- PR #749 is closed and unrelated.

Run these read-only checks first:

```bash
cd /Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/fix/release-notes-rendering
/opt/homebrew/bin/git status --short --branch
/opt/homebrew/bin/git rev-parse HEAD
/opt/homebrew/bin/git ls-remote --heads origin fix/release-notes-rendering
gh pr list --repo RonenMars/threadbase-streamer --state open --json number,title,headRefName,url
```

Stop if the worktree is dirty, the local and remote branch SHAs differ, the three-path scope differs, or another Streamer PR is open.
Do not modify or close another PR to obtain the slot.

## Defect and frozen fix

The pinned `conventional-changelog-conventionalcommits` 10.3.0 preset exposes function-based templates that `conventional-changelog-writer` 8.4.0 does not consume correctly.
`generateNotes` therefore emitted only a version heading for W1b, matching the header-only GitHub release body and tagged changelog.

The approved minimal correction pins `conventional-changelog-conventionalcommits` to 9.3.1 and adds a real-plugin regression test.
The test was seen red before the dependency change:

```text
renders a release-worthy commit in the generated notes
AssertionError: expected '## [1.72.0](https://github.com/RonenM…' to contain '### Features'
```

Do not edit the generated `CHANGELOG.md`, workflow files, application code, or any dependency other than the existing approved pin.

## Delivery sequence

1. Verify that `origin/main` still equals the branch base.
2. If `origin/main` advanced, fetch and rebase using the repository policy, then rerun all verification below before opening the PR.
3. If the rebase changes content, stop and present the changed diff and renewed approval boundary before replacing the approved commit.
4. Open exactly one PR against `main`.
5. Use this exact PR title:

```text
fix(release): render conventional commit entries in notes
```

6. The PR body must state, one sentence per line:
   - preset 9.3.1 is pinned for compatibility with writer 8.4.0;
   - the regression test invokes the real release-notes plugin;
   - the exact seen-red test name and assertion above;
   - focused tests, TypeScript, pinned Biome, direct real-commit generation, and the full suite passed;
   - there are no product or runtime changes.
7. Watch every required GitHub check.
8. If one check fails from infrastructure or a known flaky cause, rerun it once after recording evidence.
9. When all required checks are green, show current PR state, mergeability, checks, and the exact squash title, then stop for fresh explicit squash-merge approval.
10. After approval, fetch current `origin/main`, rebase if required, and reverify if bytes changed.
11. Push only the branch, using `--force-with-lease` only if the approved rebase requires it.
12. Squash-merge and confirm GitHub reports `MERGED`.
13. Wait for semantic-release to finish and identify the new remote tag.
14. Verify the release tag contains the correction and that its published/generated notes include the release-worthy `fix(release)` entry rather than only the version heading.
15. Run the direct `generateNotes` control against the real commits covered by the new release.
16. Record exact PR, merge commit, release commit, tag, workflow conclusions, and notes assertion in:
    - `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/W/REPORT-W1b.md`
    - `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/STATUS.md`
17. Check Task 1 Step 11 in `tracks/PLAN-FINISH-E2EE-2026-08-30.md` only after the tagged and published notes verification succeeds.
18. Report that the Streamer PR slot is free for X-server.

## Verification commands

Use Node v24.15.0 and the commands already proven on the approved bytes:

```bash
npx vitest run __tests__/release-notes.test.ts __tests__/release-precheck.test.ts
npx tsc --noEmit
npx --yes @biomejs/biome@2.5.10 check .
```

Run the direct real-commit `generateNotes` control described in `tracks/W/REPORT-W1b.md`.
Run the full suite only while holding `/tmp/tb-streamer-suite.lock`, and always remove the lock through a trap.

## Approval boundaries

The existing commit was already approved and pushed.
Do not amend or replace it without a new staged-diff approval if content changes.
Opening the PR is authorized by this prompt.
Merging is not authorized until the user explicitly approves after green CI.

## Report

Report the PR URL, checks, final merge and tag SHAs, direct notes output assertion, all command exit codes and totals, and anything that contradicts this prompt.

