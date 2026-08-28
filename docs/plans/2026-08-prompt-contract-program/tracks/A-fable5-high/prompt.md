# Group A — Phase 3 Structured Feasibility Gates (orchestrator brief)

Model: Fable 5. Effort: high. You are the **orchestrator** for two research tracks. You do not run probes yourself; you own the plan, the evidence protocol, the scorecards, and the final go/no-go recommendation. Two named sub-agents do the work, each with one speciality, and they never see each other's findings.

## Read first, in this order

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md` — workspace directives, stop-work triggers, verification methodology.
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/codex-results.md` — "D. Gate 0" (expanded Claude gate, supplemental Codex gate, positive controls), "Open Dilemmas" D3–D6, D8, D11, D15, "Methodology Review", and the "Discoveries that stop a phase" list.
3. `tb-streamer/CLAUDE.md` and `tb-mobile/CLAUDE.md` for anything you touch in those repos — but this group touches **no production source**. Disposable harnesses only, under `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/A-fable5-high/evidence/<provider>/`.

## Non-negotiables

- No production code, no repo commits, no PRs. Evidence files, harness scripts and scorecards only.
- Exact-version discipline: every probe records the binary version, flags, config, session/rollout id, PIDs and transcript path. A probe without them is not evidence.
- Every claim is tagged with the doc's vocabulary: PROVEN BY LIVE CAPTURE / DOCUMENTED-TYPED / INFERRED / UNPROVEN. Types are never runtime evidence.
- Positive control before any negative conclusion; a negative or counterfactual control before any causal claim; the external effect (file, transcript, process, prompt settlement) verified, never just an HTTP or RPC reply.
- Stop-work triggers are yours to enforce: session identity forks, two writers on one transcript, terminal-origin history not preserved, prompt or answer content in logs, unknown actionable request that cannot fail closed. A sub-agent reporting one of these halts that track; you report it to the user before anything else continues.
- Secrets redacted in all preserved raw evidence.

## Sub-agents

Spawn each with the Agent tool, `name` set as below, a fresh context, and the track brief pasted in full. Use synchronous one-shot runs for each probe batch (the result returns directly); if a probe batch needs back-and-forth, a named teammate with no pinned tool list. Never let one sub-agent read the other's evidence directory.

### `claude-gate-prober` — speciality: Claude Code control-protocol capture

Target: the exact Claude Code version installed on this machine (record it; the streamer fixtures claim 2.1.214, the research used 2.1.239/241 — drift is itself a finding).

Probes, each with controls and preserved raw frames:
1. Session identity: start under the control protocol, capture the exact JSONL path and UUID, write a sentinel through the session, prove the append landed in that file and no second file appeared.
2. `can_use_tool`: allow and deny frames with an external side effect the harness can observe (a file written / not written).
3. `request_user_dialog`: the actual dialog kinds and opaque payloads; single, multi, free-text, partial answer, and a deliberately unknown kind — record what the CLI does with each and whether it can fail closed.
4. Expiry: real dialog expiry and the environment override; answer-before-expiry vs actual expiry.
5. Display corpus: user/assistant deltas, reasoning, tool start/output/completion, edits, prompts, interrupts, errors, turn/session completion, ordering and sequence behaviour — the complete list, with gaps named.
6. Failure paths: control-client disconnect, control-client crash, provider process exit, reconnect with a pending prompt.
7. Multiple control clients on one session.
8. Agent-spawned interactive command: stdin, resize, turn interrupt, reconnect, external effect.
9. Terminal-origin continuity: start in a real terminal with sentinels, attach a control client, answer, detach, resume in the same terminal — classify concurrent success / clean exclusive handoff / fork-corruption-cannot-return.

Deliverable: `evidence/claude/SCORECARD.md` with one row per probe: pass / fail / unknown, evidence tag, file references, and the control that makes the row falsifiable.

### `codex-gate-prober` — speciality: Codex app-server and rollout single-writer behaviour

Target: the exact Codex version installed (record it; captures exist for 0.149.0 and must not be re-run unchanged — recertify only on a version change, and say so).

Probes:
1. Terminal-origin continuity on the exact rollout id: terminal → app-server attach → answer → detach → terminal continues. A refusal that leaves the terminal intact is a safety pass, not a remote-control pass.
2. Behaviour of `requestUserInput` without the under-development flag in the installed version; stable feature negotiation without hidden configuration.
3. Complete event corpus and ordering.
4. Pending-prompt reconnect and crash behaviour; recovery of an active session after streamer failure.
5. Unknown event / unknown request handling — fail closed or not.
6. Agent-spawned interactive command control (stdin, resize, interrupt).
7. Second writer against the exact same identity as the negative control; wrong identity as a further control.

Deliverable: `evidence/codex/SCORECARD.md`, same shape.

## Orchestrator loop

1. Before any probe: write `evidence/PROTOCOL.md` — the evidence format, the control list per probe, the redaction rule, and the version matrix. Present it and wait for the user's approval.
2. Dispatch both probers with the approved protocol. They run in parallel and never exchange findings.
3. On each report: verify the row is falsifiable (a control exists that would have flipped it), that the raw evidence file exists, and that the tag matches the evidence. Send back anything that is INFERRED where a capture was possible.
4. Any stop-work trigger: halt that track, report to the user, wait.
5. Final deliverable: `evidence/GO-NO-GO.md` — per-provider verdict against the doc's provider scorecard criteria (stability, identity, continuity, event completeness, rollback, client compatibility), the display-view input (event corpus), and a recommendation on first production provider. Every line of the verdict cites a scorecard row.

## Deliverable for the first turn

Your `PROTOCOL.md` draft and the two sub-agent briefs as you will send them. Stop there and wait for approval.
