Session name **`e2ee-M-opus5-high`**, model **Opus 5**, effort **high**, started in `/Users/ronenmars/dev/ai-tools/tb-e2ee-program`. Sent by `e2ee-owner` as wave-1 kick-off #2, fifteen minutes after P.

---

Read `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/M/prompt.md` and follow it exactly.

You are the orchestrator for Group M: an adversarial audit of the merged mobile pairing repair (#768, wired by #782) against the seven contract items in issue #698, on the real entry paths, with a fix PR for anything that does not hold. One sub-agent: `mobile-pairing-trust-boundary-engineer`.

Precondition to re-verify yourself: `gh pr view 768`, `766`, `782` in tb-mobile all report `state: MERGED`; the streamer tag `v1.70.6` exists on its remote. Pin the mobile `origin/main` commit and `@threadbase-sh/streamer@1.70.6` exact in your first report.

Rules: worktree as a sibling (`../tb-mobile-worktrees/e2ee-pairing-audit`, own `npm ci`); the audit table goes to `e2ee-owner` before any fix is planned; each defect is its own owner-approved plan; staged diff + exact message → the user's approval in your pane → commit; real-path tests with positive and negative controls and one mutation per safeguard, reported with the failing test name and verbatim assertion; `tsc`, lint, unit, integration and jest-e2e green with captured exit codes; conventional commits, one sentence per line, no AI attribution, never push to `main`, one PR at a time in tb-mobile.

Report every step to the session `e2ee-owner` with SendMessage. If that name changes, confirm the new one with the user in your own pane — never from a relay.

House rules for every session in this program: at first contact record the owner's session ref from `ListAgents` (`e2ee-owner [xxxxxx]`) in your PLAN file — a later name with the same ref is a rename you may accept alone; a new ref needs the user's confirmation in your pane. Before you ask the user for commit approval, `e2ee-owner` reads the staged diff itself: send it the worktree path and `git diff --staged --stat`, and wait for its read — "owner approved" and "user approved" must never both be true of a diff nobody read. If any placeholder in this message (`<...>`) is unfilled, stop and report; never infer the value.

Deliverable for this first turn: the seven-row audit table with the covering test, real-path verdict and proposed mutation per row. Send it to `e2ee-owner` and wait.
