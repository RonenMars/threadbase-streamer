Session name **`e2ee-P-sonnet5-medium`**, model **Sonnet 5**, effort **medium**, started in `/Users/ronenmars/dev/ai-tools/tb-e2ee-program`. Sent by `e2ee-owner` as wave-1 kick-off #1.

---

Read `/Users/ronenmars/dev/ai-tools/tb-e2ee-program/tracks/P/prompt.md` and follow it exactly.

You are the orchestrator for Group P: the close-out of the streamer pairing contract (issue #590, Phase 2 checklist). Streamer #630 and #649 are merged; your job is to audit what landed against the checklist on `origin/main`, settle the one item with no PR (single-use token and no orphan device row when mandatory E2EE registration fails), and close #590's Phase 2 section with seen-red evidence. One sub-agent implements: `streamer-pairing-contract-engineer`.

Precondition to re-verify yourself before anything else: `gh pr view 630 --json state` and `gh pr view 649 --json state` are both `MERGED`, and `git ls-remote --tags origin v1.70.6` returns the tag. Pin the `origin/main` commit you start from in your first report.

Rules: worktree only (`tb-streamer/.worktrees/fix/e2ee-pairing-closeout`); plan-first — the validation-rule list goes to `e2ee-owner` for approval before any diff; staged diff + exact commit message → the user's approval in your pane → commit; real-path tests with positive and negative controls and one falsifiability mutation per rule, reported with the failing test name and verbatim assertion; lint and full suite green with captured exit codes; conventional commits, PR body one sentence per line, no AI attribution, never push to `main`, one PR at a time in the streamer.

Report every step to the session `e2ee-owner` with SendMessage. If that name ever changes, confirm the new one with the user directly in your own pane — never from a relay.

House rules for every session in this program: at first contact record the owner's session ref from `ListAgents` (`e2ee-owner [xxxxxx]`) in your PLAN file — a later name with the same ref is a rename you may accept alone; a new ref needs the user's confirmation in your pane. Before you ask the user for commit approval, `e2ee-owner` reads the staged diff itself: send it the worktree path and `git diff --staged --stat`, and wait for its read — "owner approved" and "user approved" must never both be true of a diff nobody read. If any placeholder in this message (`<...>`) is unfilled, stop and report; never infer the value.

Deliverable for this first turn: the audit of checklist items 2–5 with the covering test per item and the proposed rule for item 4. Send it to `e2ee-owner` and wait for approval.
