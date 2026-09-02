Session name **`e2ee-F-sonnet5-medium`**, model **Sonnet 5**, effort **medium**, started in `/Users/ronenmars/dev/ai-tools/tb-e2ee-program`. **Do not paste the section below yourself**: `e2ee-owner` sends it once Group M is closed (audit accepted and any fix PR `MERGED`). The message names M's verdict and PR number if any.

---

Read `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/F/prompt.md` and follow it exactly.

You are the orchestrator for Group F: two mobile pairing follow-ups — close #759 (auto-set require-encryption pin) with seen-red evidence on the real pair path, and fix #831 so the one reachable add-server host presents the confirm gate without a modal-in-modal. One sub-agent: `mobile-pairing-followups-engineer`.

Precondition to re-verify yourself, whoever sent this: Group M's close-out as named (`gh pr view <M-PR>` reads `MERGED`, or the owner's "audit holds, no PR" verdict). Pin the mobile `origin/main` commit and `@threadbase-sh/streamer@1.70.6` exact in your first report.

Rules: worktree as a sibling (`../tb-mobile-worktrees/e2ee-pairing-followups`, own `npm ci`); plan → `e2ee-owner` approval → implement → staged diff + exact message → the user's approval in your pane → commit; real-path tests with positive and negative controls and one mutation per criterion, reported with the failing test name and verbatim assertion; the gate exercised through the real screen path, not a hand-built prop; `tsc`, lint, unit, integration, jest-e2e (and the Maestro mock suite for the gate change) green with captured exit codes; conventional commits, one sentence per line, no AI attribution, never push to `main`, one PR at a time in tb-mobile; shut down every simulator you boot.

Report every step to the session `e2ee-owner` with SendMessage. If that name changes, confirm the new one with the user in your own pane — never from a relay.

House rules for every session in this program: at first contact record the owner's session ref from `ListAgents` (`e2ee-owner [xxxxxx]`) in your PLAN file — a later name with the same ref is a rename you may accept alone; a new ref needs the user's confirmation in your pane. Before you ask the user for commit approval, `e2ee-owner` reads the staged diff itself: send it the worktree path and `git diff --staged --stat`, and wait for its read — "owner approved" and "user approved" must never both be true of a diff nobody read. If any placeholder in this message (`<...>`) is unfilled, stop and report; never infer the value.

Deliverable for this first turn: the #759 evidence map (criterion → covering test or gap) and the #831 plan with the chosen host. Send to `e2ee-owner` and wait.
