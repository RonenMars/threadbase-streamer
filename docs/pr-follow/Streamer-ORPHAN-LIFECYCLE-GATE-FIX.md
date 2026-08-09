# tb-streamer — orphan fix: multi-agent lifecycle gate (as of 2026-08-09 15:10)

A one-commit fix that belongs to no open PR because it patches the **merge** of two of them.
Preserved on origin as `wip/lifecycle-starting-multi-agent-gate` (`a681ac0`) so it cannot be lost with a worktree.

## What it fixes

`fix(sessions): scope lifecycle-starting gate to the PTY path` — `src/session-store.ts`, 12 insertions.

The #456/#448 merge resolution gated `completed` vs `starting` on `completedAt`, but multi-agent sessions never stamp `completedAt`, so an **idle multi-agent session was reported as `starting`**.
The fix scopes the gate to `currentTurnId === undefined` — the PTY-only signal — so multi-agent stays `completed`.

`lifecycle` is a field tb-mobile reads, so this is a client-visible wrong value, not an internal tidy-up.

## Why it cannot be a PR yet

It needs symbols from both PRs at once, and no single branch has both:

| ref | `"starting"` (#456) | `isLiveMultiAgent` (#448) |
|---|---|---|
| `origin/main` | absent | absent |
| `origin/feat/lifecycle-starting` (#456) | present | absent |
| `origin/cursor/fix-lifecycle-outside-pty-path-2a19` (#448) | absent | present |

Cherry-picking it anywhere today produces a patch against code that does not exist.

## What to do, and when

**Trigger: whichever of #456 / #448 merges second.** At that moment `main` has both symbols and the bug goes live.
Then cherry-pick `a681ac0` onto a branch off `main` and open it as an ordinary `fix(sessions):` PR.

Do not merge #456 and #448 without doing this — between their merge and this fix landing, every idle multi-agent session reports `lifecycle: "starting"` to mobile.

The other nine commits from the same abandoned `integration-sync-tmp` worktree are **content-landed on `main`** (the paint-time gate stack — `detectGateScreen` is in `src/pty-manager.ts` and `src/services/questions/detectPermissionGate.ts`) and need nothing.
Their SHAs differ because `feat/paint-time-gate-detection` was rewritten and deleted from origin, so a `git branch --contains` check reports them as unreachable and is misleading here.
