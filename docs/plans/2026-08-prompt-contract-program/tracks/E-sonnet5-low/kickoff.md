Session name **`sonnet5-low`**, model **Sonnet 5**, effort **low**, started in `/Users/ronenmars/dev/ai-tools/ai-investigation-claude`. Do not paste the section below yourself: it is sent by the `opus5-medium` session once `PROBE-REPORT.md` concludes "exit criteria met". The brief makes the session read the report itself either way.

---

Read `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/E-sonnet5-low/prompt.md` and follow it exactly.

You are the orchestrator for Group E: a TestFlight build of threadbase-mobile `main` carrying #872 (`40ac02ac`), through the repo's `/expo-local-ship` runbook. You own the go/no-go gate and the report; one named sub-agent, `release-operator`, runs the pipeline.

Read the workspace `CLAUDE.md` and `tb-mobile/CLAUDE.md` (Shipping, Device Builds, Native Dependencies sections) plus `docs/deployment.md`.

Gate first: Group C's probe verdict must be "exit criteria met", `main` CI green, root checkout clean. No EAS commands, no hand-reverted `Podfile.lock`, no uncommitted `app.json`. On any failure stop and quote the output; a second attempt needs my word.

Deliverable for this first prompt: the gate result. Stop there and wait for my go.
