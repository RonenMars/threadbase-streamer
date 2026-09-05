---
name: merge-prs
description: What actually enforces linear history on threadbase-streamer `main` — the two GitHub rulesets, their exact rules, why the admin `always` bypass and the absent `required_signatures` rule are load-bearing for semantic-release. Use when a merge is refused, when reading or changing branch protection, or when auditing why main is protected the way it is.
---

# Merge PRs — what enforces it

Moved out of the repo root `CLAUDE.md` so it loads on demand. The merge *rules* themselves stay in `CLAUDE.md`.

**What actually enforces this.** `main` is protected by the `main protection` repository ruleset ([rules/17561930](https://github.com/RonenMars/threadbase-streamer/rules/17561930)).
It is a *ruleset*, not classic branch protection, so `GET /repos/RonenMars/threadbase-streamer/branches/main/protection` answers `Branch not protected` — read `GET /repos/RonenMars/threadbase-streamer/rulesets` instead.

| Rule | What it refuses |
|---|---|
| `pull_request` (0 approvals, squash + rebase only) | A direct push to `main`, and the merge-commit button |
| `required_status_checks` (strict) | A merge while `Gate`, `Setup`, `Lint`, `Test (Node 22)`, `Test (Node 24)`, `Build`, `Smoke (macos-latest)` or `Smoke (windows-latest)` is not green, **or** while the branch is behind `main` |
| `required_linear_history`, `non_fast_forward`, `deletion` | A merge commit, a force-push to `main`, deleting `main` |

The strict flag is the mechanism behind "wait for the release commit" below: a branch that went `BEHIND` cannot merge until it is rebased, whoever moved `main`.

A second ruleset, `release tags` ([rules/22312521](https://github.com/RonenMars/threadbase-streamer/rules/22312521)), refuses deleting or force-moving any `v*` tag.
It carries no bypass actor, and it does not restrict tag *creation*, so semantic-release tags releases exactly as before while a published tag can no longer be rewritten by anything short of editing the ruleset.

**The `always` bypass is load-bearing — do not narrow it.** The admin role bypasses every rule above in `always` mode because semantic-release pushes `chore(release): x.y.z [skip ci]` straight to `main` with `RELEASE_PAT`, with no PR and no checks.
`threadbase-mobile` runs the tighter `pull_request` bypass mode precisely because its bot merges a PR instead of pushing; copying that setting here would break every release.

**`required_signatures` is deliberately absent** for the same reason — `semantic-release-bot` commits are unsigned, so the rule would reject the release push.
Add it only if that identity starts signing.
