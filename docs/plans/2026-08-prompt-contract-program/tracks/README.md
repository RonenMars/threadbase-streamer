# Threadbase tracks — grouped by model and effort

Each group is one orchestrator session: the single source of truth for its tracks, the only writer of the group's status, and the owner of every merge in it.
The orchestrator never implements a track itself; each track runs in a named sub-agent with one speciality, spawned through the Agent tool, and reports back through the orchestrator only.

| Group | Model / effort | Tracks | Sub-agents |
|---|---|---|---|
| A | Fable 5 / high | Phase 3 Claude feasibility gate; Phase 3 Codex feasibility gate | `claude-gate-prober`, `codex-gate-prober` |
| B | Opus 5 / high | streamer #703 answered-vs-open arbitration; mobile #871 gateId dedupe | `streamer-arbitration-engineer`, `mobile-card-identity-engineer` |
| C | Opus 5 / medium | live cross-version probe (mobile × v1.70.0, × 1.69.6) | `cross-version-verifier` |
| D | Sonnet 5 / medium | streamer #701 type fold; streamer #702 sweepExpired; mobile #870 ghost-card message | `streamer-refactor-engineer`, `mobile-composer-engineer` |
| E | Sonnet 5 / low | mobile TestFlight build of main@40ac02ac | `release-operator` |

## Sessions and hand-offs

One Claude Code session per group, started from `/Users/ronenmars/dev/ai-tools/ai-investigation-claude`, **named exactly** after its folder suffix so the parent can address it with SendMessage:

| Session name | Group | Started by |
|---|---|---|
| `fable5-high` | A | you, now |
| `opus5-medium` | C | you, now |
| `sonnet5-medium` | D | you, now |
| `opus5-high` | B | `sonnet5-medium`, after #701 and #702 are `MERGED` |
| `sonnet5-low` | E | `opus5-medium`, after `PROBE-REPORT.md` says "exit criteria met" |

Create all five sessions up front (set model and effort in each), but paste a `kickoff.md` only into the three roots; the two children wait for their parent's message, which is the child's own `kickoff.md` paste section plus a one-line provenance note.
A child re-verifies its precondition on arrival (the PR states / the report file) rather than trusting the message.
Group sessions must not share context with each other; A's two sub-agents must not share findings with each other.

Each directory holds `prompt.md` (the orchestrator brief, read by the session) and `kickoff.md` (the message you paste to start it, with the model and effort to set first).
