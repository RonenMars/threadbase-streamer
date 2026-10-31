# SB1 rebuild: conflicts and resolutions (2026-10-27)

Worktree `tb-streamer-worktrees/int-20261027-sb1`, branch `integration/20261027-sb1`, cut from `origin/main` 17d237c1 (v1.118.0).
Replaces `integration/20261026-sb1` (b530debd), now deleted with its worktree.
Local only: nothing pushed (`git ls-remote --heads origin "integration/*"` = 0), PR branches untouched.

## Method
Per PR, in order #1012 #1066 #1013 #1075 #1055 #1071: `rebase` the PR head (`refs/integration/pr/<n>`) onto the batch tip, then `merge --no-ff` as `integrate PR #<n>`.
PR heads did not move since the 10-26 build. Each was 22-76 commits behind main.

## Conflicts
| # | Kind | Where | Resolution |
|---|---|---|---|
| 1-6 | Textual (rebase) | none, all six rebased clean | n/a |
| 7 | Semantic (no git conflict) | `src/api/handlers/sessions.handlers.ts` ~L2740, adopt path | `npx tsc --noEmit` failed: `TS2304 Cannot find name 'opts'`. #1013 moved adopt onto `resolveExternalOwner`, so `opts` no longer exists there; #1066 still reads `opts.provider` to skip spawn-flag overrides for Copilot. Fix: `opts.provider` -> `owner.provider`. Same one-line fixup as the 10-26 build, re-applied by `cherry-pick b530debd`. |

The fixup lives only on the integration branch. When landing, #1066 (or whichever of #1066/#1013 lands second) needs the same one-line change in its own rebase.

## Verification
- `tsc` clean after the fixup, `npm run lint` exit 0.
- `npm test` (Node v24.15.0): 343 files passed | 1 skipped; 3730 tests passed | 11 skipped.
- `npm run deploy:force` -> running `1.118.0+802b09ec`, `dirty: true` (accepted).

## Notes
- Deploy ended 1 live PTY session; auto-resume brought 1 back.
- `/healthz` was unresponsive for ~6.5 min after the restart. Main thread was stuck in `uv__fsevents_close` after `watcher.limit_exhausted` (EMFILE on `~/.claude/projects`, 9706 EMFILE lines in stdout.log). Known macOS watch ceiling, not caused by this batch; it recovered by itself.
- Still open: `int-20261024-sb1` worktree/branch (decision #2 in the reconciled plan), `refs/integration/pr/*` kept for the landing step.
