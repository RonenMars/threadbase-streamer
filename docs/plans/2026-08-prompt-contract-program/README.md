# Prompt-contract program, 2026-08-24 → 2026-08-28

The working documents of the cross-repo program that shipped Phase 1 (safety stabilization), Phase 2 (prompt contract) and the Phase 3 feasibility gates for interactive prompts across `threadbase-streamer` and `threadbase-mobile`.
Copied verbatim from the neutral workspace `ai-tools/ai-investigation-claude/` at the program's close; they are a record, not living documentation — the issues and PRs they cite are the source of truth.

## What is here

- `WORKSPACE-CLAUDE.md` — the workspace directives the program ran under (scope, no-go, Phase 1 defects, verification methodology, stop-work triggers).
- `codex-results.md`, `PROMPT-pr700-*.md` — the review inputs for PR #700 and the fix prompts that followed.
- `tracks/README.md`, `tracks/STATUS.md` — the five-group program (A–E: model/effort tiers, kick-off protocol) and the owner's running status table with its decisions log.
- `tracks/<group>/prompt.md`, `kickoff.md`, `briefs/`, `PLAN-*.md` — each orchestrator's brief, the message it received, and the persisted plans.
- `tracks/A-fable5-high/evidence/` — the Phase 3 gate: `PROTOCOL.md`, both scorecards, `STOP-T2.md` / `STOP-T7.md`, `GO-NO-GO.md` (final, with the product-owner decisions in §7) and `FOLLOWUPS.md`.
- `tracks/C-opus5-medium/` — the live cross-version probe: `PROBE-PLAN.md` (method notes in §6), `PROBE-REPORT.md` (verdict of record) and the four phase close-outs.

Raw captures, logs and screenshots were deliberately not copied; the scrubbed evidence tree stays in the workspace (`tracks/C-opus5-medium/evidence-scrubbed/`).

## Outcomes, for orientation

Streamer: #692–#696 (v1.69.2–v1.69.6), #700 (v1.70.0), #703 (v1.70.1), #720 (v1.70.2), #721 (v1.70.4), #723 (v1.70.5); follow-ups filed #709–#717, #719, #722, #724, #727, #730.
Mobile: #864, #872, #887, #888, #896; follow-ups #884–#886, #890, #893; TestFlight build 210 (`ios-v210`).
Verdict of record (`PROBE-REPORT.md`): Phase 2 exit criteria met for every shape the app answers on streamer v1.70.4; #730 (payload fidelity on a refused shape) tracked as a follow-up.
Phase 3 (`GO-NO-GO.md`): Claude Code 2.1.247 conditional GO for a one-provider internal structured pilot; Codex 0.150.1 NO-GO for production.
