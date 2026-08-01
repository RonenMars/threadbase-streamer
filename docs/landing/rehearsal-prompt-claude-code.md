# Local rehearsal prompt — Claude Code

Copy everything inside the fence into a fresh Claude Code session at the repo root.

Companion: [`rehearsal-prompt-codex.md`](rehearsal-prompt-codex.md) — the same rehearsal for Codex.
Plan being executed: [`../../LANDING-integration-to-main.md`](../../LANDING-integration-to-main.md).

Why a rehearsal at all: the landing is ~80 units of work against a protected `main`, and the
runbook is written from static analysis. A local replay costs nothing to get wrong and converts
every unknown into a written instruction for the session that does it for real.

## Before you run this

- **Check out the integration branch and pull first.** The prompt tells the agent to read
  `LANDING-integration-to-main.md` from the working tree, so a stale checkout gives it a stale plan
  — and the section it would be missing is exactly the one that stops it silently skipping Groups
  C and F.
- **Substitute the `<today>` placeholders** in the branch and tag names, or tell the agent to.
  They appear in `backup/integration-rehearsal-<today>`, `archive/integration-<today>` and
  `rehearsal/main-<today>`.
- **Give it a long session.** Groups A and A′ alone are ~19 rebase-and-squash cycles. This is not
  a single-burst task, and the prompt is written to checkpoint after every group so an interrupted
  run resumes cleanly.
- **Expect stale worktrees.** This repo has accumulated 40+ of them, several on branches that no
  longer exist upstream. `git worktree list` before starting; they are safe to remove and they
  make `git branch -D` fail confusingly if left.

---

```
Repo: /Users/ronenmars/dev/ai-tools/tb-streamer

Do a full LOCAL REHEARSAL of landing `integration/missing-prs-2026-07-23` onto `main`,
following LANDING-integration-to-main.md as the plan. Development on this repo is frozen,
so this rehearsal is the handoff: the next session will replay it against origin.

## Hard guardrails — violating any of these ruins the rehearsal

- `origin` is READ-ONLY. The only network command allowed is `git fetch`. Never `git push`,
  never `gh pr merge`, `gh pr edit`, `gh pr close`, `gh api -X`, never touch the ruleset.
  `gh pr view` / `gh pr list` (read-only) are fine.
- Never modify the real `main` or the real integration branch. Work only on branches you create.
- Work in a dedicated worktree under ../tb-streamer-worktrees/, not the repo root checkout.
- Use the absolute git binary `/opt/homebrew/bin/git` — a zsh function shadows `git` on this machine.
- Do NOT commit the notes file into the rehearsal branch. It would pollute the final tree
  comparison. Write it to ../tb-streamer-landing-rehearsal/REHEARSAL-NOTES.md (outside the repo)
  while working; only at the very end commit a copy into the repo on a fresh branch.

## Tooling available to you

Load these when they apply — do not load them all up front.

- `integration-branch-pr-audit` (personal skill) — audits an integration branch against the repo's
  PRs. This task's exact domain; read it before Group D triage and before the Phase 2 comparison.
- `repo-branch-cleanup` (personal skill) — branch/worktree/stale-PR triage. Useful in Phase 0:
  this repo has 40+ worktrees, several on branches deleted upstream.
- `superpowers:using-git-worktrees` — worktree mechanics, which this rehearsal leans on throughout.
- `superpowers:verification-before-completion` — run it before claiming any group landed clean.
  The specific failure it prevents is reporting a group green on the strength of a lint pass you
  did not actually read.
- `superpowers:systematic-debugging` — when a landing breaks `npm test` and the cause is not
  obvious from the diff.
- `handoff` (personal skill) — if you run low on context mid-run, use it to write the handoff
  before you lose the detail, then continue.
- **Serena MCP** (`mcp__plugin_serena_serena__*`) — `find_symbol`, `find_referencing_symbols`.
  The fastest way to answer the semantic questions rebase conflicts raise: whether a signature
  gained a parameter, who calls a renamed symbol. Faster and more reliable here than grep.
- **GitHub MCP** (`mcp__plugin_github_github__*`) — read-only PR metadata. Keep it read-only, same
  as `gh`. Worth reaching for when `gh pr diff` returns HTTP 406 on a very large diff, which this
  repo has hit before.

Two traps in this environment specifically:

- **There is no working TypeScript LSP here.** The `typescript-lsp` plugin is enabled but its
  server binary is absent from `PATH`, so it silently does nothing. Type errors surface only from
  `npm run lint` (`tsc --noEmit`) — do not assume an editor-grade diagnostic is watching.
- **The user-scope `github` stdio MCP server is failing.** Use `gh` on the CLI or the
  `plugin:github:github` HTTP server instead.
- **Use the Node version in `.nvmrc`** for every `npm test` run. A newer Node loads
  `better-sqlite3` built for a different ABI and fails in ways that have nothing to do with the
  landing you are testing.

Subagents are worth it for Group D — 58 commit subjects to read and classify is exactly the kind
of read-only fan-out that parallelises safely. Do **not** parallelise anything that touches the
rehearsal trunk: rebases and squashes stay strictly serial, per the runbook.

## Phase 0 — Backup and setup

1. `git fetch origin --prune`, then also fetch every PR head ref:
   `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`
   This is load-bearing, not hygiene. Group C's 7 and Group F's 4 head branches were auto-deleted
   when those PRs merged, so `origin/<branch>` does not exist for them. `refs/pull/<N>/head`
   survives deletion and is the only ref-based route to those PRs. (Group B's 4 branches DO still
   exist — those PRs were closed, not merged, and closing does not delete.)
2. Backup the integration branch two ways, both local:
   - `git branch backup/integration-rehearsal-<today> origin/integration/missing-prs-2026-07-23`
   - `git tag archive/integration-<today> origin/integration/missing-prs-2026-07-23`
   Record both SHAs in the notes.
3. Create the rehearsal trunk from the CURRENT origin/main:
   `git worktree add -b rehearsal/main-<today> ../tb-streamer-worktrees/rehearsal origin/main`
   Record origin/main's SHA. This branch stands in for `main` for the whole run.
4. Record the starting measurements so drift is provable:
   `git rev-list --left-right --count origin/main...origin/integration/missing-prs-2026-07-23`

## Phase 1 — Replay the plan onto the rehearsal trunk

Follow LANDING-integration-to-main.md's group order: A → A' → B → C → F → E, then D triage.
The doc is the source of truth for rosters, dependency order, and per-PR caveats — read it fully
before starting, and re-read the relevant group section before starting that group.

For each open PR (Groups A and A'), model exactly what GitHub would do:
  a. `git checkout -B replay/pr-<N> origin/<head-branch>` (or origin/pr/<N> if the branch is gone)
  b. `git rebase rehearsal/main-<today>`   ← this is where real conflicts will surface
  c. resolve conflicts preserving the PR's intent; record every one
  d. `git checkout rehearsal/main-<today> && git merge --squash replay/pr-<N> && git commit`
     with the PR's conventional title + `(#<N>)` suffix, mirroring a squash-merge
  e. `npm run lint` — if it fails, that's a finding; record it, fix minimally, record the fix

For stranded groups (B, C, F, E) there are no PRs to merge — cherry-pick the specific commits
named in the doc onto a branch from the rehearsal trunk, then squash into it the same way.
Group E must go in ascending PR order; the doc's dependency table says why.

For Group D, read all 58 subjects and classify each: `carry` (real fix), `noise` (merge fixup),
or `already-covered` (its content arrives with another group). `90c1c07` is the worked example
of a `carry` that looks like noise — expect more of them. Record the full classified list.

Checkpoints, to keep this tractable:
- `npm run lint` after every squash (fast enough to bisect blame)
- `npm test` at the end of each group, not per PR
- `npm run build` at the end of each group
- After each group, write the notes file to disk and record the rehearsal trunk's SHA, so a later
  session can resume from exactly there.

## Phase 2 — The comparison that makes this worth doing

When the replay is done, compare the rehearsal trunk against the untouched integration backup —
this answers "would a real landing have reproduced the branch?":

    git diff --stat rehearsal/main-<today> backup/integration-rehearsal-<today>
    git diff rehearsal/main-<today> backup/integration-rehearsal-<today>

Every differing file is a finding. Classify each as:
- EXPECTED — e.g. `.github/workflows/ci.yml` differs if Group E's #333 wasn't applied, or
  Group-D noise you deliberately dropped, or the runbook's own docs (see below)
- DRIFT — content the replay lost, or content the replay invented
- UNEXPLAINED — investigate before writing it off

Note that LANDING-integration-to-main.md, docs/landing/ and docs/testing/cross-platform-ci.md
exist ONLY on the integration branch. They will show as diffs. Decide deliberately whether the
landing carries them to `main` and record the decision — do not let them wash out as noise.

Also run `git cherry rehearsal/main-<today> backup/integration-rehearsal-<today> | grep -c '^+'`
and account for every remaining `+`.

## Phase 3 — The deliverable

Write ../tb-streamer-landing-rehearsal/REHEARSAL-NOTES.md as a COMPLEMENT to
LANDING-integration-to-main.md — it must not repeat the runbook, only record what the runbook
could not have known. Structure it as:

1. **Provenance** — every SHA: backup, tag, starting origin/main, final rehearsal trunk, and the
   trunk SHA at each group checkpoint.
2. **Corrected execution order** — the order that actually worked, wherever it differed from the
   doc's suggested order, with the reason.
3. **Conflict ledger** — one row per conflict: PR/commit, file, what collided, how you resolved
   it, and whether the resolution is mechanical (the next session can repeat it blind) or a
   judgement call (it must be re-made by a human).
4. **Detours and rabbit holes** — anything that cost time and is not in the runbook: PRs whose
   head branch was gone, `gh` failures, lint/test breaks introduced by a landing, commits that
   turned out to be already applied, ordering traps.
5. **Group D classification table** — all 58 commits with carry/noise/already-covered and why.
6. **Final comparison result** — the diff classification from Phase 2.
7. **Corrections to LANDING-integration-to-main.md** — anything the runbook states that the
   rehearsal proved wrong. Be specific: quote the line, state the correction.
8. **Replay script for origin** — the exact ordered command sequence the next session should run
   against origin, now that the unknowns are known.

Finally, commit that file into the repo on a fresh branch off origin/main
(`docs/landing-rehearsal-notes`), do NOT push it, and tell me the branch name.

## Rules of engagement

- Never skip a group to make progress. If a group is genuinely blocked, record precisely why,
  mark it BLOCKED in the notes, and continue with the next group.
- If a single conflict resists resolution for more than ~15 minutes, stop on it, record the full
  conflict state, and move on. An honest BLOCKED entry is worth more than a guessed resolution.
- Do not "improve" any code you touch. Resolutions preserve the original PR's intent, nothing more.
- Report progress after each group rather than only at the end.
```
