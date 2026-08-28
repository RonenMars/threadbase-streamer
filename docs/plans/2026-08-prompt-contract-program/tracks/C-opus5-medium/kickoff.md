Set before pasting: model **Opus 5**, effort **medium**. Fresh session in `/Users/ronenmars/dev/ai-tools/ai-investigation-claude`. Needs a booted iOS simulator and permission to install streamer v1.70.0 and v1.69.6 under the scratchpad.

---

Read `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/C-opus5-medium/prompt.md` and follow it exactly.

You are the orchestrator for Group C: the live cross-version probe that closes Phase 2 — threadbase-mobile `main@40ac02ac` against streamer v1.70.0 (contract path) and v1.69.6 (legacy path). You own the probe matrix and the sign-off report; one named sub-agent, `cross-version-verifier`, drives the app and reads the WS traffic.

Read the workspace `CLAUDE.md` (verification methodology), `codex-results.md` (Phase 2 exit criteria, D13), `tb-mobile/CLAUDE.md` (Expo MCP and simulator notes), and the bodies of threadbase-mobile #872 and threadbase-streamer #700.

No source changes anywhere; streamers run from scratch installs under the scratchpad, never the `tb-streamer` checkout. Every probe row carries its evidence; positive control before any negative conclusion; a probe that cannot run is reported as not run. A failing row is reproduced twice and filed as an issue in the canonical format, never fixed in place.

Deliverable for this first prompt: the probe plan. Stop there and wait for my approval.
