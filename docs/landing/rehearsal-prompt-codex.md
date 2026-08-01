# Local rehearsal prompt — Codex

Copy everything inside the fence into a fresh Codex session with filesystem write access and
permission to run `git` and `npm`.

Companion: [`rehearsal-prompt-claude-code.md`](rehearsal-prompt-claude-code.md) — the same rehearsal
for Claude Code. Plan being executed: [`../../LANDING-integration-to-main.md`](../../LANDING-integration-to-main.md).

This prompt differs from the Claude Code one in two ways. Every path and command is spelled out and
the permission surface is stated up front, because Codex will not have loaded this repo's
`CLAUDE.md` conventions. And where the Claude Code prompt can point at skills and MCP servers —
`integration-branch-pr-audit`, Serena for symbol lookups, the GitHub MCP — Codex has none of that
layer, so the equivalent guidance is written out as plain instructions instead.

## Before you run this

- **Check out the integration branch and pull first.** The prompt has Codex read
  `LANDING-integration-to-main.md` from the working tree, so a stale checkout gives it a stale plan
  — and the section it would be missing is exactly the one that stops it silently skipping Groups
  C and F.
- **Substitute the `<today>` placeholders** in the branch and tag names, or tell it to. They appear
  in `backup/integration-rehearsal-<today>`, `archive/integration-<today>` and
  `rehearsal/main-<today>`.
- **Give it a long session.** Groups A and A′ alone are ~19 rebase-and-squash cycles. The prompt
  checkpoints after every group so an interrupted run resumes cleanly.
- **Expect stale worktrees.** This repo has accumulated 40+, several on branches that no longer
  exist upstream. `git worktree list` before starting; they are safe to remove and they make
  `git branch -D` fail confusingly if left.

---

```
Repository: /Users/ronenmars/dev/ai-tools/tb-streamer (git, branch integration/missing-prs-2026-07-23)
Read LANDING-integration-to-main.md in the repo root first — it is the plan you are executing.
You will need write access to the filesystem and permission to run git/npm. No network beyond `git fetch`.

TASK
Perform a complete LOCAL REHEARSAL of landing the branch `integration/missing-prs-2026-07-23`
onto `main`, and produce a findings document that lets a future session repeat the flow against
the real remote. Development on this repo is frozen; your notes are the handoff artifact.

ABSOLUTE CONSTRAINTS
1. `origin` is read-only. `git fetch` is the ONLY permitted network write-path command.
   Forbidden: git push (any form), gh pr merge/edit/close/create, gh api with -X/-f, any
   modification of GitHub rulesets or branches.
2. Do not modify or check out the real `main` or the real integration branch. Create your own.
3. On this machine a zsh function shadows `git`. Always invoke /opt/homebrew/bin/git explicitly.
4. Work inside a git worktree you create under ../tb-streamer-worktrees/. Do not edit the
   primary checkout.
5. The notes file must live OUTSIDE the repo during the run
   (../tb-streamer-landing-rehearsal/REHEARSAL-NOTES.md). Committing it into the rehearsal
   branch would corrupt the final tree comparison.

ENVIRONMENT NOTES
- There is no working TypeScript language server on this machine (the plugin is enabled but its
  binary is absent from PATH). Type errors surface ONLY from `npm run lint`, which runs
  `tsc --noEmit` followed by biome. Do not assume anything else is checking types for you.
- When a rebase conflict raises a semantic question — did this signature gain a parameter, who
  calls this renamed symbol — answer it by reading the file and grepping callers before resolving.
  Guessing from the conflict hunk alone is how a landing goes green and wrong.
- `gh pr diff` can return HTTP 406 on very large diffs in this repo. Fall back to
  `git diff <base>...<head>` rather than treating the failure as "no changes".
- Node version matters: use the version in `.nvmrc`. A newer Node picks up `better-sqlite3`
  compiled for a different ABI and produces failures unrelated to any landing.

STEP 0 — BACKUP
  /opt/homebrew/bin/git fetch origin --prune
  /opt/homebrew/bin/git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
  /opt/homebrew/bin/git branch backup/integration-rehearsal-<today> origin/integration/missing-prs-2026-07-23
  /opt/homebrew/bin/git tag archive/integration-<today> origin/integration/missing-prs-2026-07-23
The PR-head fetch is REQUIRED, not optional hygiene. Group C's 7 head branches and Group F's 4
were auto-deleted when those PRs merged, so origin/<branch> does not resolve for them;
refs/pull/<N>/head survives branch deletion and is the only ref-based route to that content.
Group B's 4 branches DO still exist — those PRs were closed rather than merged, and closing a PR
does not delete its branch. Verify before assuming either way.
Record every SHA. Also record:
  /opt/homebrew/bin/git rev-list --left-right --count origin/main...origin/integration/missing-prs-2026-07-23

STEP 1 — REHEARSAL TRUNK
  /opt/homebrew/bin/git worktree add -b rehearsal/main-<today> ../tb-streamer-worktrees/rehearsal origin/main
This branch is your stand-in for `main`. Everything lands on it.

STEP 2 — REPLAY
Execute the runbook's groups in order: A, A', B, C, F, E, then D triage. Read each group's
section in LANDING-integration-to-main.md immediately before executing it — the rosters,
dependency tables and per-PR warnings there are authoritative and you must not improvise around them.

Per open PR (Groups A, A') — model a GitHub squash-merge faithfully:
  1. git checkout -B replay/pr-<N> origin/<head>        # or origin/pr/<N> if the branch is gone
  2. git rebase rehearsal/main-<today>                  # conflicts surface here — record each one
  3. resolve, preserving only the PR's original intent
  4. git checkout rehearsal/main-<today>
     git merge --squash replay/pr-<N>
     git commit -m "<conventional title> (#<N>)"
  5. npm run lint

Per stranded group (B, C, F, E) — no PR exists to merge. Cherry-pick the exact commits the
runbook names onto a branch cut from the rehearsal trunk, then squash it in the same way.
Group E is a dependency stack: ascending PR number order is mandatory, not stylistic.

Group D — 58 direct spine commits. Read every subject line and classify each as carry / noise /
already-covered, with a one-line reason. Do not classify by commit-message shape alone: the
runbook documents 90c1c07 as a full feature that carries no PR suffix, and there are likely others.

Verification cadence (full per-PR test runs are too slow to finish):
  - npm run lint          after every squash
  - npm test              at the end of each group
  - npm run build         at the end of each group
Write the notes file to disk after every group and record the trunk SHA there, so an interrupted
run is resumable.

STEP 3 — COMPARE AGAINST THE BACKUP
  /opt/homebrew/bin/git diff --stat rehearsal/main-<today> backup/integration-rehearsal-<today>
  /opt/homebrew/bin/git diff rehearsal/main-<today> backup/integration-rehearsal-<today>
  /opt/homebrew/bin/git cherry rehearsal/main-<today> backup/integration-rehearsal-<today> | grep -c '^+'
Classify every differing file as EXPECTED (with the reason — e.g. ci.yml differs because main's
#340 version is deliberately narrower than the branch's #333 version), DRIFT (content lost or
invented by the replay), or UNEXPLAINED. Account for every remaining `+` commit individually.
An unexplained difference is the single most valuable thing this rehearsal can find — do not
round it off.

Note that LANDING-integration-to-main.md, docs/landing/ and docs/testing/cross-platform-ci.md
exist ONLY on the integration branch and will therefore appear as diffs. Decide deliberately
whether the landing carries them to `main`, and record that decision rather than letting them
wash out as noise.

STEP 4 — DELIVERABLE
Write ../tb-streamer-landing-rehearsal/REHEARSAL-NOTES.md. It COMPLEMENTS
LANDING-integration-to-main.md and must not restate it. Required sections:
  1. Provenance — all SHAs: backup, tag, starting origin/main, per-group checkpoints, final trunk.
  2. Corrected execution order — where the working order differed from the doc's, and why.
  3. Conflict ledger — PR/commit, file, what collided, resolution, and whether the resolution is
     mechanical (blindly repeatable) or a judgement call (must be re-made by a human).
  4. Detours and rabbit holes — missing head branches, tooling failures, lint/test breakage
     introduced by a landing, commits found already applied, ordering traps. Anything that cost
     time and is absent from the runbook.
  5. Group D classification table — all 58 commits, carry/noise/already-covered, with reasons.
  6. Final comparison result — the Step 3 classification.
  7. Corrections to LANDING-integration-to-main.md — quote the wrong line, give the correction.
  8. Replay script for origin — the exact ordered commands the next session runs for real.
Then commit that file into the repo on a new branch `docs/landing-rehearsal-notes` cut from
origin/main. Do not push it. Report the branch name.

BEHAVIOUR
- Do not stop to ask permission between groups; proceed and report after each one.
- Never skip a group to appear further along. Blocked work gets a BLOCKED entry stating exactly
  what blocked it and what you tried.
- Time-box any single conflict to roughly 15 minutes; then record the full conflict state and
  move on. A precise BLOCKED note beats a guessed resolution.
- Do not refactor, reformat, or improve any code you touch. Conflict resolutions preserve the
  original intent and nothing else.
- Report actual outcomes. If tests fail, say so and paste the failure.
```
