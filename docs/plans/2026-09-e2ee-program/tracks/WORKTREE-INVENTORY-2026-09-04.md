# Worktree inventory — recorded 2026-09-04 ~07:00 IDT, before any close-out sweep

Recorded so the sweep is a comparison rather than a guess, and so anything removed can be named.
**A worktree with uncommitted changes, or whose work is not actually in `main`, is not swept without asking.**

> **Method note.** The first version of this table used `git merge-base --is-ancestor <branch> origin/main`, which reported **NO** for every branch this program merged.
> That answer is truthful and misleading: these repositories **squash-merge**, so a squash creates a new commit and the branch's own commits are never ancestors of `main`.
> The check asked *is this branch an ancestor?* when the question that mattered was *was this branch's work merged?* — the same shape as every entry in `PLAN-D.md` §14.
> The column below asks GitHub for the pull request's state instead.

## Streamer

| worktree | branch | dirty | PR | state |
|---|---|---|---|---|
| `tb-streamer` | `main` | 0 | — | no PR |
| `lookup-moved-project` | `fix/conversation-lookup-moved-project` | 2 | — | no PR |
| `e2ee-program-record` | `docs/e2ee-program-record` | 0 | #755 | MERGED |
| `e2ee-program-record-updates` | `docs/e2ee-program-record-updates` | 0 | #760 | OPEN |
| `e2ee-access-probe` | `feat/e2ee-access-probe` | 0 | — | no PR |
| `e2ee-d2-followups` | `feat/e2ee-d2-followups` | 0 | #752 | MERGED |
| `e2ee-no-e2ee-flag` | `feat/e2ee-no-e2ee-flag` | 0 | — | no PR |
| `e2ee-open-refusal-log` | `feat/e2ee-open-refusal-log` | 0 | — | no PR |
| `e2ee-plaintext-boot-disclosure` | `feat/e2ee-plaintext-boot-disclosure` | 0 | #758 | MERGED |
| `e2ee-ws-app-ping` | `fix/e2ee-ws-app-ping` | 0 | #761 | MERGED |
| `e2ee-date-header-flake` | `test/e2ee-date-header-flake` | 0 | #763 | OPEN |

## Mobile — worktrees this program created

| worktree | branch | dirty | PR | state |
|---|---|---|---|---|
| `e2ee-permanent-refusal` | `fix/e2ee-permanent-refusal` | 0 | #942 | MERGED |
| `e2ee-silence-prompt` | `fix/terminal-escape-and-ping-liveness` | 0 | #948 | MERGED |
| `g-device-run` | `HEAD` | 1 | — | detached |
| `e2ee-device-run` | `HEAD` | 1 | — | detached |

Mobile carries many older worktrees predating this program; they are **out of scope** for this sweep.
