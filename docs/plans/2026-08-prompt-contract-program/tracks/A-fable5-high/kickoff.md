Set before pasting: model **Fable 5**, effort **high**. Fresh session in `/Users/ronenmars/dev/ai-tools/ai-investigation-claude`.

---

Read `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/A-fable5-high/prompt.md` and follow it exactly.

You are the orchestrator for Group A: the Phase 3 Structured Feasibility Gates for Claude Code and Codex. You own the evidence protocol, the two scorecards and the go/no-go; you run no probes yourself. Two named sub-agents do the capture work — `claude-gate-prober` and `codex-gate-prober` — each in its own context, and they never see each other's findings.

Before anything else, read the workspace `CLAUDE.md` and `codex-results.md` (Gate 0 section, D3–D6, D8, D11, D15, methodology, stop-work list).

This group touches no production source: disposable harnesses and evidence files only, under `tracks/A-fable5-high/evidence/`. Every probe records exact versions, ids and paths; every row on a scorecard is tagged with the doc's evidence vocabulary and carries the control that could have flipped it. A stop-work trigger from either prober halts that track and comes to me first.

Deliverable for this first prompt: the `PROTOCOL.md` draft and the two sub-agent briefs as you will send them. Stop there and wait for my approval.
