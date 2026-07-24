# Authoritative Session State: Source and Confidence

**Date:** 2026-07-24
**Status:** Proposed
**Scope:** tb-streamer (session status derivation) — additive contract consumed by tb-mobile
**Builds on:** [durable-session-runtime](2026-07-24-durable-session-runtime.md) (C1), which added the orthogonal `lifecycle` axis

---

## Problem

`SessionStatus` is `running | waiting_input | idle` (`src/types.ts:8`). Every one of those values is reported with the same authority, regardless of how it was derived — and the derivations are not equally trustworthy.

### The evidence exists and is thrown away

`PTYManager.markReady` already receives a `reason` describing *why* it believes the session is waiting for input (`src/pty-manager.ts:987`). Four callers supply four very different justifications:

| Call site | `reason` | What it actually means |
|---|---|---|
| `src/pty-manager.ts:749` | `marker:╭` / `marker:❯` | A real prompt marker appeared in the PTY stream. Strong evidence. |
| `src/pty-manager.ts:981` | `quiet:screen-marker:❯` | The marker was found by re-reading the rendered screen. Strong evidence. |
| `src/pty-manager.ts:757` | `fallback:timeout` | Output has flowed for 10s and **no marker ever appeared**. A guess. |
| `src/pty-manager.ts:944` | `quiet:timeout` | The PTY went silent during boot and we gave up waiting. A guess. |

That `reason` is written to a log line and then discarded. `toPublicSession` (`src/pty-manager.ts:1039`) carries no trace of it, so all four produce a byte-identical `status: "waiting_input"` on the wire.

The existing comment at `src/pty-manager.ts:989-990` states the problem outright: `reason=fallback:timeout` "would be the only signal that Claude's TUI introduced a new boot variant our markers miss". It is the only signal — and it goes to a log file nobody is watching.

`CodexPtyRunner.markReady` (`src/codex-pty-runner.ts:803-812`) does exactly the same thing, with its own comment noting that these reasons "in volume" would indicate a problem.

### Why this matters concretely

A `fallback:timeout` transition means: *the agent may be waiting for input, or it may be mid-task with a TUI we can no longer read.* The client is told, with full confidence, that the agent is waiting.

Downstream, that confident-but-guessed status drives real decisions:

- Mobile renders an input box and invites the user to type.
- The idle reaper (C1, `src/server.ts`) treats `waiting_input` as settled and eligible for release, where `running` is never reaped.
- The updater counts `running,waiting_input` to decide whether it is safe to restart (`src/updater/active-sessions.ts:23`).

A guess that is indistinguishable from an observation propagates into resource decisions and user-facing affordances.

### The timers that produce guesses

Three constants turn absence-of-evidence into a state transition: `PROMPT_MARKER_FALLBACK_MS` (10s, `src/pty-manager.ts:55`), `QUIET_DETECT_MS` (500ms, `:64`), and Codex's `CODEX_READY_FALLBACK_MS` (8s). Each is a reasonable heuristic. None is an observation, and nothing downstream can tell the difference.

---

## Goals

- Every status carries **how it was derived** and **how much to trust it**.
- A guess is never presented as an observation.
- Existing `status` values and their meanings are unchanged — this is additive.
- Both runners report through one seam, so a third provider inherits the model.

### Non-goals

- Changing when transitions fire. The heuristics stay as they are; C3 makes their provenance visible, it does not retune them.
- Adding new `SessionStatus` values. `lifecycle` (C1) already covers process-liveness; this covers derivation confidence.
- Action-required and notification status. Those belong to C7, which reacts to these transitions.
- Fixing detection fragility itself — that is C2's provider-compatibility surface.

---

## Design

### Two additive fields on the wire

```ts
statusSource:
  | "prompt-marker"    // a provider prompt marker was observed
  | "screen-marker"    // marker found by re-reading the rendered screen
  | "process-exit"     // the process exited; status follows from that
  | "user-input"       // we just wrote input, so it is running by construction
  | "spawn"            // initial state at spawn
  | "timeout-fallback" // NO marker; a timer elapsed and we assumed
  | "quiet-fallback"   // PTY fell silent during boot; we assumed
  | "shutdown"         // the streamer terminated it

statusConfidence: "observed" | "inferred"
```

`observed` means something in the stream or the process told us. `inferred` means a timer expired and we chose the most likely state.

The mapping is mechanical, derived from the `reason` strings the runners *already* produce:

| Existing reason | `statusSource` | `statusConfidence` |
|---|---|---|
| `marker:*` | `prompt-marker` | `observed` |
| `quiet:screen-marker:*` | `screen-marker` | `observed` |
| `fallback:timeout` | `timeout-fallback` | **`inferred`** |
| `quiet:timeout` | `quiet-fallback` | **`inferred`** |
| process exit | `process-exit` | `observed` |
| `sendInput`/`sendKeys` → running | `user-input` | `observed` |

No new detection logic. The information is already computed at every transition; C3 stops discarding it.

### Where it threads

Both runners already funnel every transition through the `onStatusChange` callback, and C1 established that as the single mirror point for durable state. `markReady` gains a typed source parameter instead of a free-text `reason`, and `toPublicSession` carries it onto `ManagedSession` → `SessionResponse`.

One seam, both providers, no per-runner divergence.

### What clients do with it

Mobile (U4) can render an inferred `waiting_input` differently from an observed one — "the agent appears idle" rather than an unqualified prompt. Diagnostics (C6) can report a rising `inferred` rate as the early warning that a provider TUI changed, which is exactly what the existing code comments wish for and cannot currently deliver.

Nothing is *required* to consume it. A client that ignores both fields behaves precisely as it does today.

---

## Contract additions

```ts
statusSource?: StatusSource      // how the status was derived
statusConfidence?: "observed" | "inferred"
statusUpdatedAt?: string         // ISO 8601, when it last changed
```

Additive and optional. `status` keeps its exact current meaning and value set, so no existing consumer changes behaviour. Requires the API-contract lock before `contracts/*.schema.json` is touched.

---

## Migration and rollback

No schema migration. C1's `managed_sessions` table already stores `status_source`; C3 populates it with the typed value instead of the coarse spawn/transition/exit distinction, which is a widening of an existing column's vocabulary rather than a shape change.

Rollback is a single revert: the fields are additive and nothing branches on them server-side.

---

## Known limits

- **Confidence is binary, not graded.** `observed`/`inferred` is a deliberate simplification. A numeric score would imply a calibration we have no data to support; two honest buckets are better than a fabricated percentile.
- **`observed` means we saw a marker, not that the agent is truly idle.** A provider could paint a prompt marker while still working. This reports the quality of our evidence, not ground truth.
- **The heuristics are unchanged.** A session that would have been wrongly marked `waiting_input` before still is — it is now labelled `inferred` while being wrong. That is strictly more information, not a fix for the underlying fragility (C2 owns that).
- **Reason strings are the source of truth for the mapping.** They are internal and typed after this change, so a new call site must pick a source explicitly rather than defaulting to a confident one.

---

## Test plan

| Requirement | Test |
|---|---|
| Marker transition | `marker:╭` → `prompt-marker` / `observed` |
| Screen recheck | `quiet:screen-marker` → `screen-marker` / `observed` |
| Timeout fallback | 10s with no marker → `timeout-fallback` / **`inferred`** |
| Quiet fallback | boot silence → `quiet-fallback` / **`inferred`** |
| User input | input while `waiting_input` → `running` / `user-input` / `observed` |
| Process exit | exit → `process-exit` / `observed` |
| No silent confidence | every transition sets a source; none defaults to `observed` implicitly |
| Both providers | Claude and Codex report the same vocabulary |
| Additive | a response omitting the fields still validates; `status` unchanged |
