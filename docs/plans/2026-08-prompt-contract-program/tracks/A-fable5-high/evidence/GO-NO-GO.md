# Group A — Phase 3 Structured Feasibility Gate: GO / NO-GO (FINAL — accepted by owner session ai-investigation-claude-67, 2026-08-28)

Date 2026-08-28. Versions: Claude Code **2.1.247**, Codex **0.150.1**. Scorecards: `claude/SCORECARD.md`, `codex/SCORECARD.md`. Stop files: `claude/STOP-T2.md`, `codex/STOP-T7.md` (both with owner rulings appended). Every line below cites a scorecard row; tags are the doc's vocabulary.

## 1. Provider scorecard (codex-results D8 criteria)

| Criterion | Claude Code 2.1.247 | Codex 0.150.1 |
|---|---|---|
| **Stability** (harness runs, failure paths) | **pass** — C06: stdin-close ⇒ clean exit, no orphan; SIGKILL/provider-exit leave no stray process; no-pending resume usable. | **pass** — X04a/b/d/e: pending approval survives client disconnect/SIGKILL and is re-delivered on reconnect; X04c: provider SIGKILL ⇒ turn `interrupted`, zero bytes, thread usable. |
| **Identity** (exact transcript, append identity) | **pass** — C01: one `<sid>.jsonl`, every line `sessionId == system/init.session_id`, MUT wrong-path fails. **But** C07/T2: `--resume <live sid>` is accepted ⇒ two writers on one file, cross-linked DAG. | **pass** — X0.2 rollout id == `session_meta.id`; X0.3/X07: exact-id second writer refused (`-32600 active writer`, lock file), first writer intact, wrong id refused. |
| **Continuity** (terminal → control → terminal, D5/D6) | **fail for product** — C09: real pty terminal (sentinels A, C) and two structured `--resume` clients (B, D) all wrote the ONE transcript (`cli`×6 + `sdk-cli`×8 on one parentUuid chain); terminal stayed usable; classified **concurrent success with cross-linked DAG** — no clean exclusive handoff exists, not fork-corruption. Same conclusion as Codex, reached the opposite way: Codex refuses, Claude interleaves. | **refused-terminal-intact** — X01: attach on a live TUI rollout refused with zero bytes, terminal continues; X07: sequential handoff only after owner exits. ⇒ exclusive handoff after terminal exit, never concurrent (product-owner decision). |
| **Event completeness** (display corpus) | **pass** — C05: 27 frame kinds, 12/12 required categories, 0 gaps; MUT drops interrupt+error. Gap for design: no wire sequence number (stdout order only). C0: 3 types absent from the streamer manifest (`queue-operation`, `ai-title`, `atis-latch`). | **pass with gaps** — X03: 27 kinds; gaps: no sequence numbers (`emittedAtMs` + ids), no reasoning text deltas, no `outputDelta` for short commands, interrupted command has no `item/completed`, `thread/closed`/`turn/plan/updated` unobserved. |
| **Rollback / recovery after streamer failure** | **pass** — C06: control-client crash leaves the provider parked; a parked AskUserQuestion is persisted **unsettled** and `--resume` does not re-arm it ⇒ streamer must cancel the prompt on provider crash. | **pass** — X04e: new client resumes and continues; X04c: no replay after provider death (deterministic loss, not corruption). |
| **Client compatibility** (interactive controls, D15) | **fail (D15 not preserved)** — C08: Bash-tool child gets a CLOSED stdin (EOF instantly; no-stdin NC identical); no resize control frame in stream-json; turn interrupt does reach and kill the child (late side effect suppressed). | **fail** — X06: agent-spawned commands cannot take stdin/resize from the app-server (`-32600 no active command/exec`, ids server-created); interrupt works. |
| **Prompt capability (D3/D4)** | **partial** — C02 `can_use_tool` allow/deny proven with file effect; C03 AskUserQuestion arrives as `can_use_tool`, MCP forms as `elicitation`; **gap:** no live `request_user_dialog` frame in `-p` stream-json (−32602) — kinds are DOCUMENTED-TYPED from the binary only. Answers accepted verbatim, no shape validation, partial answer accepted as complete. Refusal ⇒ typed error, zero bytes. C04: expiry override `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`; settings `dialogExpiry` does not bound a stdio park. | **fail for production** — X02/STOP-T7: `requestUserInput` is `underDevelopment`, default-off, no documented mode switch, not advertised by stable negotiation. Flag-gated rows (X0.4–X0.6, X03/X04/X05-flagged) are mechanics-only: works when enabled; no server-side question-id validation; every question needs options (free text via `isOther`); `isSecret` model-chosen; refusal hands the model `{"answers":{}}` silently. |

## 2. Verdicts

**Claude Code 2.1.247 — CONDITIONAL GO for a one-provider internal structured pilot**, conditions:
1. Streamer owns single-writer enforcement (C07/T2) — one live control client per session id, reconnect = exclusive handoff; never attach to a session a terminal still owns (workspace CLAUDE.md §2 constraint stands).
2. Streamer owns prompt-shape validation and fail-closed refusal (C03) and expiry (C04); provider crash cancels the parked prompt (C06).
3. `request_user_dialog` is not a runtime contract until a live frame is captured (C03 gap) — pilot scope is `can_use_tool` (permission + AskUserQuestion) and `elicitation` only.
4. Content-free logging must not dump `result` frames — `permission_denials[].tool_input` carries full Write content (C02).
5. Fixture/manifest drift fixed first (C0): version pin 2.1.214 → 2.1.247, add the 3 missing envelope types.
6. External (terminal-origin) sessions: never attach a structured client to a live terminal session (C09) — support is exclusive handoff after the terminal exits, or none; product-owner sign-off on loss of terminal capabilities and on exclusive handoff instead of continuity (doc: Go/no-go ownership).
7. D15 not preserved (C08): agent-spawned interactive commands cannot take stdin/resize from the control client; interrupt works. Pilot is product-limited to non-interactive tool runs, same as Codex.
8. D12: the Phase 2 contract's secret tri-state maps every Claude-sourced prompt to `unknown` for the pilot — no secrecy field exists on `can_use_tool` / AskUserQuestion / elicitation frames as captured (C03); same as PTY-scraped and Codex.

**Product-owner decisions (escalated per the doc's Go/no-go ownership):** Claude condition 6 (exclusive handoff instead of continuity; loss of terminal capabilities) and the Codex external-session line below. All other conditions are engineering scope.

**Codex 0.150.1 — NO-GO for production; internal-experiment adapter only** (D4):
- Questions remain internal-experiment-only until `default_mode_request_user_input` is default-on and negotiable without hidden configuration (X02/T7).
- External sessions: exclusive handoff after terminal exit only, never concurrent (X01/X07) — **product-owner decision**.
- D15 not preserved: no stdin/resize to agent-spawned commands, no replay after provider death (X06, X04c) ⇒ product-limited.
- D12: `isSecret` untrustworthy ⇒ Phase 2 tri-state maps Codex prompts to `unknown`, same as PTY-scraped.
- Any Codex adapter owns the whole answer boundary: id validation (#700 registry) and user-visible refusal (X0.4-flagged, X05-flagged).

## 3. Recommendation — first production provider

**Claude Code**, after the conditions in §2. Codex remains the earlier *internal* adapter candidate for approvals only (X0.1, X04) — its question capability is not a contract. This matches D8's prior ("prefer Claude for production if it passes; Codex may be the earlier internal adapter") and is now backed by capture rather than expectation.

## 4. Display-view input (event corpus)
- Claude: `claude/P05-display-corpus/corpus.md` (27 kinds). Codex: `codex/X03-event-corpus/corpus.md` (+ `X03-question-flagged/corpus-addendum.md`).
- Both providers lack a wire sequence number ⇒ the structured activity view cannot detect gaps from the stream alone; the doc's confidence model must be revised (streamer-assigned sequence on ingest, snapshot+sequence on subscribe per D13).
- Codex: interrupted commands never complete ⇒ the view needs an explicit "interrupted" terminal state per item.

## 5. Cross-provider conclusions (D2/D5/D6/D15)
- **Single-writer is the streamer's job on both providers.** Codex enforces it (X0.3/X07 refuse); Claude does not (C07/C09 interleave). Neither offers concurrent terminal+structured use of one session. PTY stays default; one transport per session; no migration of active sessions — workspace CLAUDE.md §2 is now backed by capture on both sides.
- **Interactive agent-spawned commands are not controllable from either structured transport** (C08, X06); interrupt works on both. Structured sessions are product-limited until addressed.
- **Provider crash drops the pending prompt on both** (C06, X04c); the streamer cancels it and tells the user — no replay.
- **Answer validation and fail-closed refusal are streamer-side on both** (C03, X0.4/X05-flagged); neither provider validates shape or ids, and Codex hides refusals from the model.

## 6. Stop-work record
- T2 (Claude, C07) — halted, owner lifted for C08/C09 capture-only.
- T7 (Codex, X02) — continued per owner; flag-gated pass mechanics-only.
- No T1, T3–T6, T8, T9 on either track. Hygiene: all credential/auth copies deleted; Codex `shell_snapshots` (real API keys) and a leaked user email in Claude frames scrubbed from evidence; real stores unchanged before/after every probe.

## 7. Product-owner decisions (recorded 2026-08-28 18:25 IDT by the owner session, from the user)

**D-PO-1 — Terminal-origin sessions: watch read-only; take over by exclusive handoff.**
A session running in the user's terminal may be *watched* from mobile, read-only: the watcher is a non-writer (transcript tail only, never a `--resume` attach), with no composer and no prompt cards.
To *interact*, the terminal session is stopped and the same session id is resumed from mobile — one owner at a time, never concurrent (C07/C09 on Claude; X01/X07 on Codex).
Engineering constraints: a prompt open at handoff is lost, not re-armed (C06, X04c) — the takeover flow cancels it and says so; stopping the terminal session from the phone is a confirmed remote action executed by the streamer that owns the process.

**D-PO-2 — Structured sessions are product-limited to non-interactive commands.**
Accepted for the internal pilot (C08, X06): no stdin/resize into agent-spawned commands; interrupt supported.
The limitation is stated explicitly in the product (mode visible; interactive tools steer the user to PTY).
PTY remains available as a separate opt-in feature; for the pilot, structured is the opt-in and PTY the default (workspace rule); the default flips only after the pilot passes.
