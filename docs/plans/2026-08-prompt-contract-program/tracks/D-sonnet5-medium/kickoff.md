Set before pasting: model **Sonnet 5**, effort **medium**. Fresh session in `/Users/ronenmars/dev/ai-tools/ai-investigation-claude`. Can start now.

---

Read `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/D-sonnet5-medium/prompt.md` and follow it exactly.

You are the orchestrator for Group D: three mechanical follow-ups — threadbase-streamer #701 (fold the three `PendingPermission` declarations), #702 (name the expiry sweep `sweepExpired`), and threadbase-mobile #870 (local message when text is refused while the card is a pending ghost). You own the plans, diff reviews and merges; two named sub-agents implement — `streamer-refactor-engineer` (serial: #701 then #702) and `mobile-composer-engineer` (#870, in parallel).

Read the workspace `CLAUDE.md`, both repos' `CLAUDE.md` (and the streamer `AGENTS.md`), then the three issues.

Rules: worktrees only; plan → my approval → implement → staged diff + exact message → my approval → commit; no behaviour change in #701/#702, nothing "while we're here"; existing suites as the positive control plus the one falsifiability check per track named in the brief; full suite, lint and build green before any diff reaches me; conventional commits, no AI attribution, never push to main, one PR at a time per repo, branch deletion only after `MERGED`.

Deliverable for this first prompt: the two sub-agent briefs and the verified-state check on current `main`. Stop there and wait for my approval.
