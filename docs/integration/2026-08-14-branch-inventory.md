# Local branch inventory — 2026-08-14

A record of the branches that survived the post-refactor cleanup, what each actually is, and why `git cherry` is the wrong tool for deciding.

Written after landing 17 PRs (the 2026-08-12 integration set plus the ten-PR `src/server.ts` refactor — see [the rehearsal log §18](2026-08-12-rehearsal-log.md#18-outcome--what-actually-landed)).
This is a snapshot, not a worklist. GitHub is the worklist.

## The cleanup

Local branches went **60 → 22**, worktrees **33 → 18**, in two passes:

- **20 deleted** as provably merged — zero unique commits by patch-id against `origin/main`.
- **18 deleted** as scaffolding — seven `rebase/pr-*` rehearsal branches, five `*-tmp`, four integration rollups, the throwaway `test/all-work-2026-08-13`, and `docs/agent-status-and-cursor-plans` (which had been silently rewritten by `--update-refs`; see the log's O2 correction). Every backing PR was confirmed MERGED first.

Seven branches survived that had no `origin` counterpart. All seven were pushed on 2026-08-14 so nothing lived only on one laptop.

## What the seven turned out to be

| Branch | Commits | PR | Real state |
|---|---|---|---|
| `feat/claude-open-file-collision` | 20 | **#465** | **already merged** |
| `fix/codex-active-writer-resume` | 21 | **#463** | **already merged** |
| `docs/readme-security-posture` | 2 | **#518** | **already merged** |
| `fix/windows-supervised-logs` | 2 | **#520** | **already merged** |
| `pr523-review` | 1 | — | **never opened** — `fix(windows): stabilize native dependency and test compatibility`, 6 files incl. `package.json` / `package-lock.json` |
| `stack/lifecycle-starting-on-448` | 2 | — | **never opened** — `fix(sessions): scope lifecycle-starting gate to the PTY path`, 7 files incl. `docs/compatibility/tb-mobile.md` |
| `feat/end-to-end-encryption` | 1 | — | **deliberate** — spec notes started 2026-08-14, `specs/end-to-end-encryption/` |

## The trap: `git cherry` cannot see through a squash

`git cherry origin/main <branch>` compares by **patch id**. A squash-merge rewrites the patch, so every branch that landed via squash reports its commits as `+` — "not in main" — even though its content is fully merged.

That produced a confident wrong reading here: four merged branches looked like they held 20+ commits of unique unmerged work that existed nowhere else. They held none.

**Use `git cherry` only to prove a branch IS merged (a zero count is trustworthy). Never to prove it is not.** A non-zero count means "not byte-identical", which on a squash-merge repo is the normal state of every branch that ever landed.

What settles it instead, cheapest first:

1. `gh pr list --state all --head <branch>` — a MERGED PR is decisive.
2. Grep `main` for a distinctive symbol the branch introduced. Here, `handleJsonlDeleted` in `src/external-tails.ts` and `CODEX_USAGE_LIMIT_RE` in `src/services/questions/codexScreen.ts` were both present, confirming the work had shipped.

This is the same shape as the other failures recorded in the log §18: a clean, confident, wrong signal with nothing thrown, caught only because a second source disagreed.

## Consequence for rebasing

Rebasing the four merged branches onto today's `main` would replay ~20 commits of already-merged content onto a tree where `src/server.ts` has since gone 6,557 → 2,501 lines. That is the `--onto` failure from log §17, for no gain. They are duplicate refs and can be deleted once their remote copies are no longer wanted as backups.

Only `pr523-review` and `stack/lifecycle-starting-on-448` are candidates for real rebase work. Both date from 2026-08-09, predate the refactor, and touch files the split moved, so both need genuine conflict resolution rather than a mechanical replay.
