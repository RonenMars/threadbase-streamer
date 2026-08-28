# Group D dependency check — 2026-08-28, verified independently

Kick-off named #701/#702 as PRs; they are **issues**. Verified with `gh` in each repo:

| Item | State | Evidence |
|---|---|---|
| streamer issue #701 (fold `PendingPermission`) | CLOSED 05:13:37Z | `gh issue view 701` |
| streamer PR #706 `refactor/fold-pending-types` | **MERGED** 05:13:36Z | mergeCommit `3ec9861a137c7c72f7d5e11cf0990105dbaf67a5` |
| streamer issue #702 (name the expiry sweep) | CLOSED 05:45:23Z | `gh issue view 702` |
| streamer PR #708 `refactor/name-expiry-sweep` | **MERGED** 05:45:21Z | mergeCommit `e71487c89137a01c7ded3fac91f5c16eb76cd976` |
| `origin/main` (streamer) | `e71487c8` = #708's squash | `git log --oneline -5 origin/main` |

Both shas match the ones `sonnet5-medium` sent. **Streamer track unblocked.**

## Two dependencies the kick-off did not mention

1. **Group D's third track, mobile #870, is still open and in progress** (worktree `../tb-mobile-worktrees/fix-ghost-send-refusal-message`, branch `fix/ghost-send-refusal-message`). It does not touch `hooks/useActiveQuestion.ts` — it branches on `answerPhase === 'pending'` in `LiveConversationView`/`TerminalView` plus one locale key — so there is **no file collision** with #871. But "one PR at a time per repo" means the tb-mobile merge queue is D's until #870 lands; my mobile PR can be opened and go green, and I will hold its merge until #870 is `MERGED` unless told otherwise.
2. **#703 and #870 are the two halves of the same window** and are being built in parallel. #870 makes mobile show a local line during the ghost phase, so once both ship, the streamer's improved wording is the *fallback* rather than the primary text — which is what #870's own "Depends on" section anticipates. No ordering constraint follows, but #703 must not change `reason: "prompt_pending"`, or #870's branch (and every released client) stops recognising the refusal.

`origin/main` (mobile) is `3b2cca63`; the local checkout sits on `fix/rtl-directional-layout` with ~25 worktrees — the sub-agent branches from `origin/main`, not from the checkout.
