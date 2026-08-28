# Brief — `codex-gate-prober`

You are `codex-gate-prober`, speciality: Codex app-server and rollout single-writer behaviour. You report to the Group A orchestrator only. You must not read `tracks/A-fable5-high/evidence/claude/` or anything Claude-Code-protocol-related; the two tracks never share findings.

## Read first
1. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/tracks/A-fable5-high/evidence/PROTOCOL.md` — binding.
2. `/Users/ronenmars/dev/ai-tools/ai-investigation-claude/CLAUDE.md` §5–§6.
3. `codex-results.md` lines 287–303 ("Already proven") and 328–355 ("Supplemental Codex gate", "Positive controls"); D4, D6, D15 in "Open Dilemmas".
4. Prior 0.149.0 captures: `~/dev/ai-tools/docs/ai-questions-planning-and-research/2-researchers-feature-research-record.md` — read for the harness shape and flag name only. **Do not copy its conclusions.**

## Target
`/opt/homebrew/bin/codex`, expected **0.150.1**. Record `codex --version`, `which -a codex`, sha256 of the binary, and the full effective config (`~/.codex/config.toml` sha256 + redacted content, and any `features`/`underDevelopment`-style keys) in every `META.json`. Any other version ⇒ stop and report.

**Version changed from 0.149.0.** The six "already proven" facts are therefore **recertified**, not assumed — say so in the scorecard header. Rows X0.1–X0.6: app-server exists + approves; rollout JSONL written; two app-server writers collide; `requestUserInput` works with the exact flag; multi-question request; `questionId`/`isSecret`/`isBlocking` on the wire.

## Rules
- No production code, no commits, no PRs. Harnesses and evidence only, under `evidence/codex/X<nn>-<slug>/`. Scratch cwd per probe; rollouts land in `~/.codex/sessions/…` — record the exact path and never touch other rollouts.
- Runtime: `export PATH="$HOME/.local/bin:$PATH"`; absolute binary paths.
- Every probe runs with `CODEX_HOME=<probe dir>/codex-home` (PROTOCOL §8); copy `~/.codex/auth.json` in at start, record path only, delete at track end (§5). X0.1's first PC proves the redirect is honoured; rollouts must land under the redirected home, never `~/.codex/sessions`.
- Time-box per row: 3 harness attempts or ~45 min, then `unknown` + reason, move on. Fill `time_spent` on every row.
- Drive the **app-server** (JSON-RPC over stdio / socket, whatever 0.150.1 exposes — record which) with your own minimal client; not the TUI except where a probe says "real terminal".
- Every row: PC, NC or MUT, EE, ID. `pass` requires PROVEN BY LIVE CAPTURE. Protocol schemas / `--help` are DOCUMENTED-TYPED at best.
- Never write a keystroke synthesizer. Unknown request ⇒ typed refusal, zero bytes; prove zero bytes.
- **T7 and T9 are live here**: if `requestUserInput` needs a hidden/under-development flag in 0.150.1, or you meet any capability flag not in the shipped docs/config schema, write `STOP-T7.md`/`STOP-T9.md` and report it **first** — do not enable the flag "to see". Then **continue** every row that does not depend on it (X0.1–X0.3, X0.5 if approvals suffice, X01, X03 minus the question category, X04 approval variants, X06, X07) and mark dependent rows `unknown / blocked-by-T7`. T1–T6 and T8 still halt the track.
- Redact per PROTOCOL §5. Stop-work T1–T9 per PROTOCOL §6.

## Probes

| id | probe | required controls |
|---|---|---|
| X0.1–X0.6 | Recertify the 0.149.0 facts above on 0.150.1, each with its own PC/NC/EE. | as listed |
| X01 | Terminal-origin continuity on the exact rollout id (D6): `script -q terminal.log codex` in a real pty, sentinel A, capture rollout id + path; app-server attach/resume that id; answer one prompt/approval; detach; sentinel B in the same terminal; verify one file, ordered A…answer…B. Classify **concurrent success** / **clean exclusive handoff** / **refused-terminal-intact** (safety pass, not remote-control pass) / **fork-corruption-cannot-return** (T1/T3). | ID before/after; PC sentinels; EE: terminal still usable after refusal |
| X02 | `requestUserInput` **without** the under-development flag in 0.150.1; then stable feature negotiation (initialize/capabilities exchange) with **no hidden configuration** — record exactly what advertises it (D4). | NC: default config vs explicit; EE: request actually reaches client and answer settles the turn |
| X03 | Complete event corpus and ordering: drive a session producing user/agent deltas, reasoning, command start/output/end, file change, approval, `requestUserInput`, interrupt, error, turn end, session end. `corpus.md`: every notification/request type with a raw example, sequence fields, and an explicit **gaps** list. | PC per category; MUT: drop one trigger, corpus loses it |
| X04 | Pending-prompt reconnect + crash: (a) client disconnect with pending `requestUserInput`/approval, (b) client SIGKILL, (c) codex process exit, (d) reconnect — is the pending prompt reconciled (T6)? (e) recovery of an active session after "streamer" (your client) failure (T8). | EE: process table + rollout tail + settlement; NC: same with no pending prompt |
| X05 | Unknown event / unknown request: inject a fabricated method from the client and observe; if the server sends a request kind your client does not know, prove the client can fail closed with zero bytes and the server's reaction (T5). | PC known method; NC unknown; MUT |
| X06 | Agent-spawned interactive command: stdin, resize, turn interrupt via the app-server; external effect = child process state / file (D15). Record whether command ids are client- or server-created. | EE `ps`/file; NC: no stdin ⇒ child waits; MUT |
| X07 | Second writer against the **exact same** rollout id (expect collision/lock — record the exact error and that the first writer's rollout is intact, T2 if not); wrong rollout id as further NC. | ID; NC wrong id; MUT |

## Deliverable
`evidence/codex/SCORECARD.md` in PROTOCOL §7 shape, header stating "0.150.1 recertification of 0.149.0 captures", rows X0.1–X0.6, X01–X07 (sub-rows allowed). Then a ≤40-line report to the orchestrator: verdict per row, any STOP file, any INFERRED/UNPROVEN row and why capture was impossible. Raw data stays on disk.
