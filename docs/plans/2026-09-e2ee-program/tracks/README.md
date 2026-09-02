# E2EE parallel continuation prompts — 2026-08-31

These prompts launch the three tracks that are unblocked after W1b released as streamer `v1.72.0`.

Use [`kickoff.md`](kickoff.md) to start and coordinate all three lanes in one parent session.

## Verified launch state

- Streamer PR #748 is `MERGED`.
- Streamer tag `v1.72.0` resolves to release commit `d7a27ab5d7ec963ae9350b60a99b8d48b0c1b99b`.
- The W1b merge commit is `fd89defcd2460b77acad6ee8c0cc068bffb66efd`.
- The release-notes correction is committed and pushed as `87354b18722922a9e9268e817abf00b6501487fb` on `origin/fix/release-notes-rendering`.
- No Streamer PR is currently open.
- X-server's preserved worktree is `/Users/ronenmars/dev/ai-tools/tb-streamer/.worktrees/feat/e2ee-rest-envelope`.
- XC1 has no worktree yet; create `/Users/ronenmars/dev/ai-tools/tb-mobile-worktrees/e2ee-transport` from freshly fetched mobile `origin/main`.

Every session must re-verify these facts rather than trust this snapshot.

## Launch order

Launch all three prompts now:

1. [`release-notes.md`](release-notes.md)
2. [`x-server.md`](x-server.md)
3. [`x-client-xc1.md`](x-client-xc1.md)

The release-notes session owns the first Streamer PR slot.
X-server may recover, rebase, implement, test, run mutations, and prepare its adversary review in parallel, but it must not open a PR while the release-notes PR is open.
After the release-notes PR is merged and its semantic-release artefact is verified, X-server rebases onto the resulting current `origin/main`, reruns every required post-rebase gate, and may then use the Streamer PR slot.

XC1 runs independently in the mobile repository using exact streamer tag `v1.72.0`.
XC1 must not begin XC2 REST work until X-server's release tag exists and XC1 is merged.

## Shared hard rules

- Product changes happen only in task worktrees; the repository roots are read-only.
- Preserve all existing, untracked, ignored, and historical evidence.
- Use `/opt/homebrew/bin/git`, never plain `git`.
- Never commit before showing the complete staged diff, explaining it, showing the exact commit message, and receiving explicit user approval.
- Never merge from an earlier approval; every squash merge needs a fresh explicit user approval after current CI and mergeability are shown.
- Never push to `main`.
- Never force-push except with `--force-with-lease`, and only when the approved workflow requires it.
- Conventional commit and PR titles use an imperative lowercase description with no trailing period.
- GitHub prose uses one sentence per line.
- No AI or Cursor attribution.
- A private key, ticket, device token, API key, or plaintext frame on a channel declared sealed is an immediate stop-work event.
- Streamer full suites use `/tmp/tb-streamer-suite.lock`.
- Update `tracks/STATUS.md` and the owning track report after every material gate.
