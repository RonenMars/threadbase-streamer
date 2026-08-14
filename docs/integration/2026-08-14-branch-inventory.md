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
| `fix/windows-supervised-logs` | 2 | **#520** | **merged except one file** — all code is byte-identical to `main`; `docs/prompts/2026-08-10-verify-windows-logs.md` (150 lines) exists nowhere else |
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

Rebasing the four merged branches onto today's `main` would replay ~20 commits of already-merged content onto a tree where `src/server.ts` has since gone 6,557 → 2,501 lines. That is the `--onto` failure from log §17, for no gain. They are duplicate refs and can be deleted once their remote copies are no longer wanted as backups — **except `fix/windows-supervised-logs`**, whose one unmerged doc must be salvaged first (see the table above).

### Diffing a pre-refactor branch against post-refactor `main` invents work

Checked 2026-08-14, while deciding whether #559 conflicted with `fix/windows-supervised-logs`.

`git diff --stat origin/main..<branch>` on a branch cut before the `src/server.ts` split reports **every module the split extracted as a deletion** — `src/scanner-manager.ts`, `src/session-watchers.ts`, `src/external-tails.ts` and the rest, ~5,900 lines of them. The branch never touched those files; it is simply older than they are. That reads as a large, conflicting change and it is entirely an artifact of the base.

It produced a wrong call here: the branch looked like it held 8 files of rival work over `scripts/deploy.ps1` and blocked #559 on a which-is-authoritative decision. Diffing each side against **its own merge-base** instead showed the real content — 12 files, of which 11 were already byte-identical to `main`.

**Diff a branch against its own merge-base, or restrict the pathspec to the files the branch actually touches. Never against a `main` that has moved structurally underneath it.**

One caveat on the pathspec form, because it fails silently in this repo's shell: `F="a.md b.md"; git diff main..br -- $F` passes the whole string as **one** pathspec under zsh — no word-splitting — so it matches nothing and prints an empty diff that reads as "no differences". Pass the paths as literal arguments or a real array.

Only `pr523-review` and `stack/lifecycle-starting-on-448` are candidates for real rebase work. Both date from 2026-08-09, predate the refactor, and touch files the split moved, so both need genuine conflict resolution rather than a mechanical replay.
