# Paint-time permission-gate detection

**Date:** 2026-08-08
**Status:** Approved design, pre-implementation
**Owner:** streamer core (pty-manager / services/questions)

## Problem

The mobile permission card (`permission` WS event) appears ~6 seconds after the gate is already
visible in the terminal view. Both surfaces ride the same WebSocket, so the gap is entirely
server-side trigger latency, and users watch a fully painted approval prompt with no card to tap.

## Measurement (prod log, session `47a62f94`, 2026-08-08)

Two gates, identical shape:

| Event | Gate 1 | Gate 2 |
|---|---|---|
| Gate box paint burst (`pty.chunk`, ~2.5 KB over 3 chunks) | 11:44:13.514 | 13:26:34.968 |
| ~40B blink chunks only (`⏺` pulse, ~2Hz) | 6.0 s | 5.9 s |
| OSC 777 notify chunk (54B, `]777;notify;…needs your permission`) | 11:44:19.509 | 13:26:40.867 |
| `ws.broadcast_permission` | 11:44:19.510 | 13:26:40.879 |

Detection + scrape + broadcast take **1 ms**. The ~6 s is Claude Code's own notification
debounce: it paints the gate immediately but emits the OSC 777 notify ~6 s later. The streamer
currently uses that OSC as the *only* trigger for gate detection (`hasPermissionOsc`,
`detectPermissionGate.ts`), so the card inherits the upstream delay. The paint burst itself
never triggers detection: the numbered options sit inside the box gutter (`│ ❯ 1. Yes`), which
defeats the chunk-level shell-prompt hint regex, and the TUI paints text as cursor-addressed
fragments, so no chunk-level phrase match is reliable either.

### Alternatives investigated and rejected

- **Upstream config knob:** `messageIdleNotifThresholdMs` exists in the installed binary
  (v2.1.223) but defaults to 60000 and gates only the `idle_prompt` ("waiting for your input")
  notify. No setting governs the ~6 s permission-notify debounce; it is hardcoded and
  undocumented (docs checked 2026-08-08).
- **`hooks.Notification` injection via `--settings`:** documented to run "when Claude Code
  sends notifications" — plausibly the same debounced moment, unverified. Even if it fires at
  gate-open it needs a new endpoint, auth that cannot ride the hook command line, and merge
  semantics with user hooks. Not pursued; may be probed later independently.

## Design

### A. Trigger & throttle (`pty-manager.ts`, `detectLivePrompts`)

Add one pass condition to the early-return: a per-session throttle. If ≥ `SCRAPE_THROTTLE_MS`
(300 ms) have passed since the last full detection run, a chunk's arrival alone is enough to
scrape the rendered screen. Rationale:

- No status dependence — the log shows `status=waiting_input` throughout active streaming, so
  the session status cannot gate this.
- No chunk-text phrase matching — paint fragments make it unreliable (see Measurement).
- Chunks flow constantly during a turn (spinner/blink ~2 Hz even while a gate waits), so the
  throttle tick is always available; the paint burst is itself a chunk, so the common case
  detects within ~10 ms of paint. Worst case is one throttle tick (~300 ms).
- Idle sessions produce no chunks and therefore no scrapes.
- 300 ms = half the observed blink cadence (~450–620 ms); caps scrape work at ~3/s per active
  session. A scrape is a write-queue flush plus regexes over ≤60 rendered lines (sub-ms).

The throttle timestamp records when a full detection pass actually ran (any trigger), so
explicit triggers (OSC, ask footer, hint) also reset it.

### B. OSC-less gate classifier (`detectPermissionGate.ts`, new pure function)

A gate may be claimed without the OSC only when **all three** hold on the rendered lines:

1. `scrapePermissionGate` finds ≥ 2 numbered options.
2. Some line matches the gate footer `/esc to cancel/i`, and **no** line matches the
   AskUserQuestion footer `/Enter to select/i` (that path keeps priority, unchanged).
3. At least one option label matches `/^(yes|no)\b/i` — the same Yes/No family test
   `detectQuestionFromScreen` already uses in reverse (its `PERMISSION_LABEL_RE`). This anchor
   is what rejects prose false-positives (Claude printing a numbered list mid-answer).

The screen-claimed branch runs in `detectLivePrompts` alongside the existing OSC branch —
after the AskUserQuestion priority check, before the shell-prompt fallback (which then skips
via `permissionOpen`, as it already does). On a hit the flow is identical to the OSC path: set
`permissionOpen`, call `onPermissionChange` with the scraped gate. Broadcast payload, content-key dedupe, close
logic, subscribe replay, and the mobile contract are untouched. The OSC remains a trigger
(it still covers a gate whose options never paint — the `{options: []}` provisional broadcast
stays for that case) and the OSC "waiting for your input" body remains the authoritative close
signal.

False-positive posture: a spurious card requires prose containing both a numbered Yes/No list
and a literal "esc to cancel" line during a streaming turn. If it happens the card is
recoverable (ignore or Cancel) and closes at end of turn via the waiting-for-input OSC —
consistent with the detector philosophy already documented in `detectShellPrompt.ts`
(spurious card recoverable; missed prompt strands a blocked PTY).

### C. Split-OSC tail-carry (same file, robustness)

Keep the last 128 raw bytes of the previous chunk per session and run both OSC regexes
(`hasPermissionOsc`, `hasWaitingForInputOsc`) against tail + current chunk. Closes a found
hole: the ~54-byte escape split across a node-pty chunk boundary matches neither chunk today,
and the shell-prompt fallback deliberately bails on Claude box chrome, so a split-OSC gate
never fires at all (and a split close-notify leaves a stuck card). The map is cleared on
session exit.

### D. Out of scope

No WS event shape changes, no mobile changes, no new endpoints, no hook injection, no
Codex-runner changes, no change to `QUIET_DETECT_MS`, the status machine, or grace/hold
semantics.

### E. Verification

- **Unit — the regression test for the feature:** write a synthetic gate paint into the
  headless terminal and assert the gate broadcasts with **no OSC anywhere in the stream**.
- **Unit — classifier anchors:** first make the classifier fire (positive control), then flip
  each anchor off independently (footer absent / Yes-No label absent / Ask footer present) and
  assert silence.
- **Unit — split OSC:** the escape split across two writes still fires (and the split
  waiting-notify still closes).
- **Unit — throttle:** two chunks inside one window cause one scrape.
- **Prod success criterion, measured the same way the bug was:** re-run the log query after
  deploy; the `pty.chunk` paint burst → `ws.broadcast_permission` gap must be ≤ 500 ms
  (baseline: ~6 s on both measured gates).
- **Docs:** update the `detectPermissionGate.ts` header (OSC is a trigger + fallback, no
  longer *the* deterministic trigger) and the CLAUDE.md gate-detection line.
