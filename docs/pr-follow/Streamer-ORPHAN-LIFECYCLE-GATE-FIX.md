# tb-streamer — multi-agent lifecycle gate fix: LANDED (as of 2026-08-09 17:40)

**Resolved.** This note described a one-commit fix that belonged to no PR because it patched the *merge* of two of them.
It is now on `integration/prs-223-441-…-456` as **`6c1ed95`**. Kept for the reasoning, which explains why it sat orphaned for a day.

## What it fixes

`fix(sessions): scope lifecycle-starting gate to the PTY path` — `src/session-store.ts`.

The #456/#448 merge resolution gated `completed` vs `starting` on `completedAt`, but multi-agent sessions never stamp `completedAt`, so an **idle multi-agent session was reported as `starting`**.
The fix scopes the gate to `currentTurnId === undefined` — the PTY-only signal — so multi-agent stays `completed`.

`lifecycle` is a field tb-mobile reads, so this was a client-visible wrong value, not an internal tidy-up.

## Why it was stuck

It needs symbols from both PRs at once, and no single branch had both:

| ref | `"starting"` (#456) | `isLiveMultiAgent` (#448) |
|---|---|---|
| `origin/main` (then and now) | absent | absent |
| `origin/feat/lifecycle-starting` (#456) | present | absent |
| `origin/cursor/fix-lifecycle-outside-pty-path-2a19` (#448) | absent | present |

Cherry-picking it onto any of those produced a patch against code that did not exist.

## What unblocked it

Syncing the integration branch merged **both** #456 and #448 into one tree, which is the first place both symbols coexist — and the first place the bug was actually live.
The cherry-pick conflicted only on the surrounding comment; the `lifecycle` ternary applied cleanly.

Verified after landing: lint exit 0, and `session-store` + `session-rehydration` + `server` = 211 tests passing.

## Still open

**The fix is on the integration branch, not on `main`.** `main` has neither #456 nor #448, so it does not have the bug either — but whenever those two reach `main`, this commit must travel with them.
If they land individually rather than via this branch, cherry-pick `6c1ed95` immediately after the second one merges.

## Related, for whoever prunes branches

`wip/lifecycle-starting-multi-agent-gate` on origin was the preservation ref for this commit and is now redundant.
`integration/2026-08-08_14-22-prs-441-…-454` is also redundant — it is 4 commits ahead of the current integration branch, all of them merges plus the TypeScript 7 bump that was deliberately reverted.
