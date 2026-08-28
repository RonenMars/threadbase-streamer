# STOP — T2: two writers land on one transcript (Claude Code 2.1.247)

Fired by probe **C07 / concurrent** (`P07-two-clients/`). Per PROTOCOL §6, T2 halts the track. This file is written; the track is halted; rows C08–C09 were not run.

## What happened
- Client A: `claude -p --input-format stream-json --output-format stream-json --verbose --model claude-haiku-4-5-20251001` — established session `6092c3bd-9f90-4c3a-a484-59625a65f110`, wrote sentinel `TB-SENT-A`.
- Client B (separate process): same flags **plus `--resume 6092c3bd-...`**, launched while A's process was still alive.
- Result: **both accepted, both exit 0**, and **both appended to the one transcript file** `claude-home/projects/<slug>/6092c3bd-....jsonl`. No second file was forked.

## Proof (from P07-two-clients/effect.txt + frames-A/B.jsonl + the transcript)
- Exactly one `.jsonl` for the project dir; its name is the shared sid.
- `frames-A.jsonl`: A's 2nd `result` (`TB-SENT-A2`) at 05:25:13.995, exit 0.
- `frames-B.jsonl`: B's `result` (`TB-SENT-B`) at 05:25:14.202, exit 0, `system/init.session_id` == the same sid.
- Transcript interleave (wall-clock): A2-user 12.276 → B-user 12.338 → A2-assistant 13.995 → B-assistant 14.202 — two live writers, one file.

## Why this is T2 (not a benign fork)
`--resume` is **not** an exclusive attach: it does not lock the session file and does not refuse a second client on a live session id. Two independent provider processes therefore hold the same transcript open and append concurrently. This run did not tear a line (file still parses; per-line uuids unique), but the conversation DAG is now cross-linked across two unrelated turns, and nothing prevents an interleaved-write byte tear under load.

## Bearing on the refactor (workspace CLAUDE.md §2, §6)
- Directly supports the constraint **"Never combine a PTY and structured control client for the same session; do not migrate active sessions between transports"** — the CLI itself provides no exclusivity, so the *streamer* must own single-writer enforcement (one live client per session id). The provider will not reject the second writer for you.
- The reconnect model must be **exclusive handoff** (kill/quiesce the old client before attaching a new one), never "attach a second client to a live id."

## NC (control that proves it isn't spurious)
`--resume <non-existent-uuid>` → exit 1 `No conversation found with session ID`. So the resume path CAN refuse; it simply does not refuse a *live duplicate*.

## Credential note
Credential copies under evidence/claude were deleted at track halt (see final report).

## Owner ruling (ai-investigation-claude-67, 2026-08-28 08:35 IDT)

T2 recorded as the Claude gate's decisive D2 finding. Halt lifted for C08 and C09 under conditions:
1. C08 runs — independent of multi-writer.
2. C09 runs — the D5 experiment; classify exactly as concurrent-success / clean-exclusive-handoff / fork-corruption-cannot-return. If it reproduces C07, record "concurrent success with cross-linked DAG" and treat as **fail for product purposes** (no clean handoff exists), not a pass.
3. Separate dirs; scratch CLAUDE_CONFIG_DIR only; halt on anything NEW (second file, byte tear, content in a log) — a repeat of the C07 interleave is not new. No mitigation or "make it exclusive" experiments; capture only.
4. This file stays on disk as the record.
