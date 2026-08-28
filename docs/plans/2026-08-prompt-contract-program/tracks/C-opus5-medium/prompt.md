# Group C — Phase 2 live cross-version probe (orchestrator brief)

Model: Opus 5. Effort: medium. You are the **orchestrator** for one verification track: prove on a real device or simulator that the mobile app at `main@40ac02ac` (threadbase-mobile #872) behaves correctly against streamer **v1.70.0** (contract path) and against **v1.69.6** (legacy path). You own the probe matrix and the sign-off report; one named sub-agent runs the probes.

## Read first

1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md` — verification methodology.
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/codex-results.md` — Phase "Prompt Contract Foundation" exit criteria and D13 (reconnect at every state, two-client race).
3. `tb-mobile/CLAUDE.md` — Expo MCP (`expo-local`, local dev server at 127.0.0.1:8081), on-device tracing traps, simulator notes.
4. threadbase-mobile PR #872 body and threadbase-streamer PR #700 body — the contract as shipped.

## Non-negotiables

- No source changes in either repo. The streamer versions run from scratch installs (npm or a scratch clone at the tag) under the scratchpad, never from the `tb-streamer` checkout.
- Every probe row records: app commit, streamer version, session id, what was sent, what frame arrived (type, `promptId`/`gateId`, `revision`, `state`), what the card did, what the composer did.
- Positive control first: a legacy permission gate on 1.69.6 opens a card and answers once. Negative control: the same on v1.70.0 must arrive as `prompt_snapshot`/`prompt_event` and the legacy frame must be ignored.
- Report faithfully: a probe that cannot be run is "not run", not "pass".

## Sub-agent

### `cross-version-verifier` — speciality: driving the Threadbase mobile app against live streamers and reading its WS traffic

Probe matrix (both streamer versions unless noted):
1. Permission gate opens → card renders (v1.70.0: from `prompt_snapshot` on subscribe; 1.69.6: from `permission`).
2. Tap an option → v1.70.0 sends `POST /prompt/answer` with ids, revision, idempotency key; 1.69.6 sends `POST /permission/answer` with `contentKey` + `gateId`. Exactly one write reaches the PTY.
3. Revision bump on v1.70.0 (cursor-only repaint must not bump; a content change must) → selection survives the repaint; the card updates on the bump.
4. Terminal state: answer accepted → ghost → `prompt_event resolved` clears it (v1.70.0); `permission_cancelled` clears it (1.69.6).
5. Reconnect at every state: card open, ghost pending, after resolve — the app resubscribes and shows the right thing from the snapshot / replay.
6. Two clients: two app instances (or app + a WS script) answer the same prompt; exactly one provider response; the loser sees `already_resolved` / `gate_mismatch` as a calm notice.
7. Unsupported shape (v1.70.0 only): a multi-select AskUserQuestion → card shows guidance, no rows, dismiss works, composer send disabled, Escape closes it.
8. Composer text while a prompt is open → `409 prompt_pending`, draft kept, no alert, conversation view jumps to the card (both versions).
9. Old-streamer control: on 1.69.6 no `prompt_*` frame ever arrives and every behaviour matches the Phase 1 baseline.

Deliverable: `tracks/C-opus5-medium/PROBE-REPORT.md` — the matrix with per-row evidence, then a one-paragraph verdict: Phase 2 exit criteria met / not met, with the failing rows if any.

## Orchestrator loop

1. Write the probe plan (how each streamer version is run, how a gate and a question are provoked, how WS frames are captured) and wait for approval.
2. Dispatch; review each row's evidence for the control it claims.
3. Any failing row → reproduce twice before reporting; file an issue in the right repo in the canonical format (`P<N>: …`, `## Verified state` with the probe row), never fix in place.
4. Hand the report to the user.
5. **Hand-off to the child session.** Group E is gated on your verdict. Only if `PROBE-REPORT.md` concludes "exit criteria met", send the Group E kick-off to the session named `sonnet5-low` with SendMessage — the paste section of `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/E-sonnet5-low/kickoff.md` (everything below the `---`), verbatim, followed by one line: `Sent by opus5-medium: PROBE-REPORT.md verdict is "exit criteria met" at <absolute path>; your gate is cleared.` On "not met", send nothing and tell the user. If `sonnet5-low` is not listed by ListAgents, tell the user instead of retrying.

## Deliverable for the first turn

The probe plan. Stop there and wait for approval.
