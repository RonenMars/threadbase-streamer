# Durable Session Runtime

**Date:** 2026-07-24
**Status:** Proposed
**Scope:** tb-streamer (PTY lifecycle, session persistence, recovery) — contract additions consumed by tb-mobile

---

## Problem

A managed agent PTY is owned by the streamer process and, indirectly, by whichever WebSocket clients happen to be subscribed to it. Agent work is therefore only as durable as a phone's socket and the streamer's uptime. Three distinct failure paths exist today.

### 1. The last subscriber leaving kills the agent

`handleWsClose` walks every session the closing socket subscribed to and, when the subscriber set empties, arms a grace timer (`src/server.ts:836-844`). The timer fires after `ptyGracePeriodMs` (default 270s, `src/server.ts:147`) and calls `putOnHold` (`src/server.ts:1008`).

`putOnHold` is a euphemism. It sends `SIGINT` to the agent process, disposes the render screen, and deletes the session from the manager's map (`src/pty-manager.ts:586-607`; the Codex runner mirrors it exactly at `src/codex-pty-runner.ts:560-576`). The session is then reported `idle` with `ptyAttached: false`. The agent is not paused, suspended, or detached — it is terminated.

There is one mitigation: if the session is still `running` when the timer fires, the hold defers and re-arms, up to `GRACE_MAX_DEFERS` = 4 (`src/server.ts:983-1000`). This protects a turn that is actively streaming, but only for a bounded number of grace periods, after which the log line reads `exceeded 4 defers, holding anyway` and the agent is killed mid-turn regardless.

The practical consequence: a phone that backgrounds, loses signal, or switches from Wi-Fi to cellular drops its socket. If no other client is subscribed, a long-running agent task is on a countdown to `SIGINT`.

### 2. Streamer restart kills every agent

`ThreadbaseServer.close()` calls `this.ptyManager.dispose()` (`src/server.ts:1450`), which iterates every live session and calls `session.process.kill()` with no argument (`src/pty-manager.ts:672-690`). node-pty's `UnixTerminal.kill` defaults that to **`SIGHUP`** (`node_modules/node-pty/lib/unixTerminal.js:226-231`) — a different signal from `putOnHold`'s `SIGINT`, and one that does not give the CLI the same chance to flush. `cli/index.ts:302-303` wires `close()` to `SIGINT`/`SIGTERM`, so any restart — an update, a crash-loop supervisor, a `launchctl kickstart`, a laptop reboot — takes every in-flight agent with it.

**But removing the explicit kill is not sufficient**, and this is the finding that shapes the whole task. node-pty 1.1.0 spawns with `POSIX_SPAWN_SETSID` (`node_modules/node-pty/src/unix/pty.cc:703-706`), so every agent is already a session leader in its own process group, with the PTY slave as its controlling terminal. That means no *process-group* signal from the streamer's exit reaches it. It is tempting to conclude the agents would survive on their own if we simply stopped killing them.

They do not. Measured directly, on this machine, with this node-pty build:

> A parent spawns a node-pty child running a 20-second heartbeat loop, then calls `process.exit(0)` after 1.5 s **without** killing the child. The heartbeat stops at 1.5 s — the child dies with the parent.
>
> Repeat the identical probe with `trap '' HUP` in the child, and it runs all 20 seconds to completion, ~10 s after the parent is gone.

The mechanism is the controlling terminal, not the process group: when the streamer exits, the last PTY **master** fd closes, and the kernel sends `SIGHUP` to the foreground process group of the terminal that just lost its master. `setsid` is precisely what makes the agent that foreground group. So the very call that detaches it from our process group is what puts it in line for the hangup.

This reframes Phase 3. Surviving a streamer restart is not "stop calling `kill()`" — it requires the PTY master fd to outlive the streamer process, or the child to not die on `SIGHUP`. Neither is free, and the honest consequence is recorded in *Known limits*: **clean-restart survival needs a holder for the master fd, and `SIGKILL`-of-the-streamer survival is not achievable in-process at all.** Phase 3 is scoped accordingly, and the durability that Phases 1 and 2 deliver — which covers the far more common disconnect case — does not depend on it.

Two paths already exit without reaching `dispose()`, so orphaned agents are reachable today with no way to describe them: dev-takeover installs `SIGINT`/`SIGTERM`/`SIGHUP` handlers that `process.exit(0)` without calling `close()` (`src/lifecycle/dev-takeover.ts:152-171`), and the prod `uncaughtException`/`unhandledRejection` handlers `process.exit(1)` directly (`cli/index.ts:311-326`).

The current mitigation is avoidance rather than durability: the updater asks the running streamer how many sessions are mid-conversation and defers the update if any are (`src/updater/active-sessions.ts`). That is a scheduling workaround for a runtime that cannot survive restart, and it does nothing for a crash or a reboot.

### 3. Nothing about a managed session is persisted

There is no `sessions` table. The migrations directory holds projects, cache metadata, provider columns, and a scanner warm-up cache — nothing for session state (`src/db/migrations/`). `SessionsRepository` states the position explicitly in its own docstring: "Sessions live in-memory in SessionStore (Postgres-backed persistence was dropped per the SQLite-only direction)" (`src/db/repositories/sessions.repository.ts:3-7`). `SessionStore` is two `Map`s (`src/session-store.ts:15-16`).

So on restart the streamer loses `startedAt`, `promptCount`, `inputHistory`, `sessionName`, `projectId`, `resumedFromConversationId`, `boundConversationId`, `failureReason`, and the entire output ring buffer. Sessions do not come back as "recoverable" — they simply cease to exist as far as the API is concerned, and reappear (if at all) only as *external* discovered processes with `status: "idle"` and no managed metadata (`src/session-store.ts:236-260`).

### 4. The status vocabulary cannot express any of this

The managed status set is `running | waiting_input | idle`. `idle` is doing far too much work: it is the terminal state after a clean exit (`handleExit`, `src/pty-manager.ts:1004`), the state after a grace-timer kill (`putOnHold`, `src/pty-manager.ts:602`), and the state reported for any externally discovered process because the streamer cannot see its prompt state (`src/session-store.ts:243-246`). A client cannot distinguish "the agent finished", "we killed the agent to save resources", and "some other process exists that we know nothing about".

This is the state-confidence problem C3 owns in general; C1 owns the subset that concerns process liveness and attachment.

---

## Goals

- Agent work survives phone sleep, socket loss, network changes, and the last subscriber disconnecting. **Fully delivered.**
- Disconnecting the final client must never interrupt an active task. **Fully delivered.**
- Enough metadata is persisted to reattach to, or accurately describe, a session after streamer restart. **Delivered.**
- Attached / detached / orphaned / resumable / completed / failed are distinguishable and carry their evidence. **Delivered.**
- Survive streamer restart where the OS makes it possible; state plainly where it does not. **Partially delivered** — the measurement in *Problem* shows in-process restart survival is not achievable while the streamer owns the PTY master fd. Agents that *do* survive (crash and dev-takeover paths) become visible and correctly classified; deliberate-restart survival needs the daemon (alternative D) and is scoped out with a recorded reason.
- Claude Code and Codex resume semantics are preserved exactly. **Unchanged.**

### Non-goals

- Redesigning the whole status vocabulary. C3 owns semantic state (`running`/`waiting_input` confidence, prompt correlation). C1 adds only the lifecycle/attachment axis and must not silently reinterpret existing values.
- Multi-client input arbitration and replay cursors — C4.
- Changing pairing, auth, or capability scoping — C5.

---

## Alternatives considered

### A. Keep the in-process model, tune the timers

Raise `ptyGracePeriodMs`, raise `GRACE_MAX_DEFERS`, or set the grace period to `0` to disable auto-hold.

Rejected as a solution, though the knobs stay. It addresses none of the three failure paths: any finite grace period still kills a long task on a long disconnect, and restart still kills everything. Setting the period to `0` (already supported, `src/types.ts:357`) trades the disconnect kill for an unbounded PTY leak — every abandoned session holds a process, a 64 KiB ring buffer, and a headless xterm forever. This is a knob, not a runtime.

### B. tmux as the session host

Spawn each agent inside a `tmux new-session -d`, drive it with `send-keys`, read it with `pipe-pane`.

Rejected. tmux genuinely solves detachment and restart survival, and it is battle-tested. But it makes a third-party binary a hard runtime dependency on every platform we support — including Windows, where it does not exist natively at all (we ship `deploy.ps1` and a Windows ABI check in `scripts/check-native-abi.mjs`, so Windows is a supported target, not a nice-to-have). It also puts a full terminal multiplexer between us and the byte stream that our prompt detection depends on. That detection is delicate and hard-won: OSC 777 permission gates, the `Enter to select` footer, bracketed-paste submit timing tuned against real inter-chunk gap percentiles (`src/pty-manager.ts:64-102`, `784-925`). Re-qualifying all of it through tmux's own rendering, escape handling, and status line is a large risk for a benefit we can get without it.

### C. Provider-native server protocols

Use Claude Code's and Codex's own headless/server modes instead of driving a TUI through a PTY.

Rejected for C1, and worth revisiting later. It is the architecturally cleanest end state — no screen scraping, no marker heuristics. But it is provider-controlled, differs per provider, and would rewrite prompt detection, input submission, and resume simultaneously. C2 (provider compatibility framework) is where that abstraction belongs; C1 must not block on it. Recorded here so the option is not lost.

### D. Dedicated PTY daemon (separate supervised process)

Move PTY ownership into a small long-lived daemon; the streamer becomes a client of it over a local socket.

Rejected as the first step, and — given the SIGHUP measurement — now clearly the eventual destination. It is the only option on this list that actually delivers restart survival, because it is the only one where the process holding the PTY master fd is not the process being restarted.

It is still not the right *first* move. It introduces a second process to install, supervise, version, upgrade, and diagnose, plus an IPC protocol and its own compatibility surface. Doing that alongside the persistence work and the lifecycle model in one task produces an unreviewable diff and violates the one-task-per-branch rule. It also buys nothing for the disconnect case, which is the failure users actually hit.

So: Phases 1 and 2 solve the common failure completely and stand on their own; Phase 3a makes surviving agents visible; the daemon becomes a well-scoped follow-up whose value is now measured rather than assumed. Recorded here as the intended successor, not a discarded option.

### E. Detach the PTY from the streamer's lifecycle + persist a session registry — **chosen**

Three separable changes, in dependency order:

1. **Stop killing on disconnect.** Decouple subscriber count from process lifetime.
2. **Persist a session registry** to SQLite so identity and metadata outlive the process.
3. **Stop killing on shutdown**, and reconcile surviving agents against the registry on boot.

Each is independently valuable and independently testable. Together they deliver C1's required result without a new daemon, a new binary dependency, or a rewrite of prompt detection.

The reason this is achievable so cheaply is the `POSIX_SPAWN_SETSID` finding above: the hard part of durability — genuinely detaching a child from its parent's fate — is already done by node-pty. What remains is that the streamer kills its children on the way out and cannot recognise them afterwards. Both are our code, and both are removable.

---

## Design

### Phase 1 — Detach lifetime from subscribers

The subscriber set stops being an ownership signal and becomes what it actually is: a delivery list.

`handleWsClose` no longer arms a kill timer. Explicit `hold_session` from a client remains — a user asking to release a session is a real intent and stays honoured — but an involuntary socket close is no longer treated as that intent. `ptyGracePeriodMs` keeps its meaning for the explicit path only.

Unbounded PTY growth is the obvious objection, and it is answered by an **idle reaper** rather than a disconnect timer. The distinction matters: the current timer measures *how long nobody was watching*, which is unrelated to whether the agent is doing anything. The reaper measures *how long the agent itself has been inactive* — no PTY chunk and no user input — and only ever considers sessions in a settled state (`waiting_input`/`idle`, never mid-turn). A long agent task with no subscribers is exactly the case C1 exists to protect, and the reaper leaves it alone because it is producing output.

`putOnHold` gets renamed to what it does. It is a kill; calling it "hold" is how the current behaviour reads as intentional pausing in every log line and every mobile status. The rename is mechanical, confined to the runner seam, and carries no behaviour change — but it is the difference between a reviewer seeing `putOnHold` and a reviewer seeing `terminateSession`.

### Phase 2 — Persist a session registry

A new `managed_sessions` table (migration `010`), written on spawn, on status transition, and on exit. It stores identity and provenance, not the byte stream:

| Column | Why |
|---|---|
| `session_id` (PK) | JSONL UUID for Claude; rollout id for Codex |
| `provider` | Drives which runner reattaches and which resume flags apply |
| `pid`, `pgid` | Liveness probing and reattachment on boot |
| `project_path`, `project_name`, `branch` | Restore managed metadata rather than degrading to `external` |
| `status`, `status_source`, `status_updated_at` | Feeds the lifecycle axis below; `status_source` keeps C3's confidence requirement honest |
| `started_at`, `completed_at`, `last_activity_at` | Currently lost entirely on restart |
| `prompt_count` | Currently lost entirely on restart |
| `session_name`, `project_id`, `bound_conversation_id`, `resumed_from_conversation_id` | User-visible identity that today silently disappears |
| `failure_reason` | Survives so a crashed session can explain itself after restart |
| `streamer_instance_id` | Distinguishes "this instance started it" from "a previous instance did" — the orphan test |

Explicitly **not** persisted: `outputBuffer`, the xterm screen, `inputHistory`. The ring buffer is 64 KiB per session of raw ANSI, rewritten on every chunk; persisting it would turn every PTY chunk into a DB write for data whose authoritative copy is already the provider's JSONL. Terminal replay after restart is served from provider history, not from a resurrected ring buffer. This is a deliberate corner, and it means post-restart replay is conversation-accurate but not byte-accurate — recorded in *Known limits* below.

Writes are debounced on the hot path. `status` transitions and spawn/exit are synchronous; `last_activity_at` is debounced (the existing `src/utils/debounce.ts` already backs the quiet-checker) so a chatty PTY does not become a write storm.

### Phase 3 — Boot reconciliation, and an honest restart story

The SIGHUP finding means Phase 3 cannot promise restart survival by deleting code. It splits into what is achievable now and what is deferred with a reason.

**3a — Boot reconciliation (ships in this task).** Whatever the cause of an agent outliving or predeceasing the streamer, on startup the reconciler reads every non-terminal registry row and establishes ground truth. This is valuable *regardless* of whether Phase 3b ever ships, because agents already survive today on the dev-takeover and crash paths — they are simply invisible when they do.

The reconciler probes each recorded `pid` via `process.kill(pid, 0)` (portable; `src/lifecycle/process-liveness.ts` already exists for this) and classifies:

- **Alive, cmdline matches provider + project** → `detached`. Listed as managed with persisted metadata intact.
- **Alive, cmdline does not match** → `orphaned`. The PID was recycled. Never signalled — that is how a durability feature becomes a kill-an-unrelated-process bug.
- **Dead, provider history shows a clean end** → `completed`.
- **Dead, no clean end** → `failed`, carrying the persisted `failure_reason`.
- **Dead, provider supports resume from the stored id** → `resumable`.

The cmdline match is what makes this safe: liveness alone is never treated as identity.

This also fixes a real gap the reconciler inherits for free. Orphan discovery today regexes `--resume`/`-r` out of `ps` argv (`src/process-discovery.ts:349-356`), but every *fresh* session is spawned with `--session-id`, not `--resume` (`src/pty-manager.ts:361-362`) — so orphaned fresh sessions have no recoverable conversation id and are skipped entirely (`src/session-store.ts:72`). Reading the id from our own registry instead of re-deriving it from argv makes them visible.

**3b — Master-fd survival across clean restart (deferred, not attempted here).** Keeping an agent alive through a deliberate streamer restart requires the PTY master fd to outlive the streamer process. The options are to pass the fd to a supervising process over a unix socket (`SCM_RIGHTS`), or to move PTY ownership out of the streamer entirely — which is alternative D, the dedicated daemon.

Deferring is the right call and the measurement is why: the work is a second supervised process, not a flag, and it buys the *restart* case only. The disconnect case — a phone backgrounding, losing signal, or switching networks, which is what users actually hit and what the grace timer actually kills — is fully solved by Phase 1 with none of that machinery. Shipping 3b inside C1 would also merge the runtime relocation into a task already carrying a schema change and a lifecycle model.

What this task does instead is make 3b cheap later: once PTY ownership sits behind the runner seam with a persisted registry and a reconciler, relocating that seam into a daemon is contained work rather than a rewrite.

Consequently **no `detachedSessions` flag ships**. There is no behaviour to gate: `dispose()` keeps killing on clean shutdown (the alternative is a guaranteed `SIGHUP` death seconds later, with a stale registry row claiming otherwise — worse than an honest kill). What changes is that shutdown now *records* terminal state before killing, so the next boot can explain what happened instead of silently forgetting.

Windows is qualified separately regardless: `SETSID` and controlling-terminal semantics are POSIX, and the ConPTY teardown path differs. The cross-platform test asserts observed behaviour rather than assuming parity.

On startup the reconciler reads every non-terminal row and probes each `pid`:

- **PID alive, cmdline matches the expected provider and project** → `detached`. The agent survived; the session is listed as managed with its persisted metadata intact. Reattaching to the *byte stream* of a PTY we no longer own is not possible — the fd died with the old process — so reattachment is at the conversation level: the client follows provider history, and taking live control means an explicit `--resume` respawn.
- **PID alive, cmdline does not match** → `orphaned`. The PID was recycled. Never signal it; that is how a durability feature becomes a kill-the-user's-unrelated-process bug. Mark and surface it.
- **PID dead, provider history shows a clean end** → `completed`.
- **PID dead, no clean end** → `failed`, with the persisted `failure_reason` when one exists.
- **PID dead, provider supports resume from the stored id** → `resumable`.

`existsSync(/proc/<pid>)` is not portable; `process.kill(pid, 0)` is, and `src/lifecycle/process-liveness.ts` already exists for exactly this. The cmdline match is what makes the probe safe against PID reuse — liveness alone is not evidence of identity.

### The lifecycle axis

C1 adds an axis orthogonal to the existing semantic status, rather than overloading `idle` further:

```
lifecycle: "attached" | "detached" | "orphaned" | "resumable" | "completed" | "failed"
```

- `attached` — this streamer instance owns the PTY and is streaming its bytes.
- `detached` — the process is alive but this instance does not own its fd (survived a restart).
- `orphaned` — a PID is recorded and something is alive at it, but identity does not match. Never signalled.
- `resumable` — no live process; provider history supports `--resume`.
- `completed` / `failed` — terminal, with evidence.

`status` keeps its current meaning and values. Additive, so an old client that ignores `lifecycle` behaves exactly as it does today — which is the compatibility rule the coordination protocol requires while both integration branches are in flight.

Resume semantics are untouched: Claude Code resumes via `--resume <jsonl-uuid>` (`src/pty-manager.ts:288-290`) and Codex via `codex resume <id>` (`src/codex-pty-runner.ts:256`). The registry stores the identifier each provider needs; it does not invent a new one.

---

## Contract additions

Additive only, per the coordination protocol. Consumed by mobile in U4.

`SessionResponse` gains:

```ts
lifecycle: "attached" | "detached" | "orphaned" | "resumable" | "completed" | "failed"
lifecycleSource: "spawn" | "exit" | "probe" | "reconcile"
lifecycleUpdatedAt: string   // ISO 8601
```

No field is removed or repurposed. `ptyAttached` stays and keeps its meaning (`lifecycle === "attached"`), so existing clients are unaffected. The contract lock is required before these land in `contracts/*.schema.json`, and old fields stay until both integration branches carry the new implementation.

---

## Migration and rollback

**Migration.** `010_create_managed_sessions.sql` is additive — a new table, no existing table altered, no data backfilled (there is no prior session state to backfill). A streamer starting against a pre-010 database creates the table and finds it empty, which is indistinguishable from a first run.

**Rollback.** Each phase is independently revertible:

- Phase 1 — restoring the `handleWsClose` timer is a revert of one commit. No schema involvement.
- Phase 2 — the table is write-mostly and read only by the reconciler. Reverting leaves an unused table; no migration-down required, and an older streamer ignores it entirely.
- Phase 3a — the reconciler is read-only with respect to processes: it probes and classifies, and never signals anything. Reverting it degrades reporting back to today's (absent) behaviour without touching any running agent.

Ordering constraint: Phase 3a must not ship before Phase 2 — it reads the registry Phase 2 writes, and without it has nothing to reconcile against.

The riskiest thing the reconciler could do is act on a misidentified PID, so it does not act at all: classification never signals, and `orphaned` is a report, not a cleanup trigger.

---

## Known limits

Stated plainly, per C1's requirement to document where true survival is impossible.

- **An agent cannot outlive the streamer while the streamer owns its PTY master fd.** Measured, not assumed (see *Problem*): closing the last master fd makes the kernel `SIGHUP` the agent, and `setsid` is what elects it to receive that hangup. Surviving a deliberate restart requires relocating fd ownership — the daemon in alternative D. Until then, a clean restart ends managed sessions, and the registry records that it did so rather than losing them silently.
- **Byte-stream reattachment across restart is impossible regardless.** A master fd cannot be resurrected. Even with the daemon, an agent adopted after restart is observed through provider history and controlled by an explicit resume respawn; its pre-restart terminal bytes are gone. Replay after restart is conversation-accurate, not byte-accurate.
- **Machine reboot ends everything.** No user-space design survives it. Post-reboot the reconciler's job is accurate reporting (`resumable` / `failed`), not resurrection.
- **`SIGKILL` on the streamer skips persistence.** Exit-time writes never run, so the reconciler infers state from PID probe plus provider history rather than a recorded exit. This is exactly why `status_source` exists and why the reconciler never trusts a stored `status` over a live probe.
- **Windows is qualified separately.** `SETSID` and controlling-terminal hangup are POSIX semantics; ConPTY teardown differs. The cross-platform test asserts observed behaviour rather than assuming parity, and any divergence is documented rather than silently absorbed.
- **PID reuse is real.** Liveness alone is never treated as identity; the cmdline match gates every reattachment claim, and a mismatch yields `orphaned` rather than a guess.

---

## Test plan

Mapped to C1's required coverage.

| Requirement | Test |
|---|---|
| Disconnect/reconnect | Last subscriber closes mid-turn; agent keeps producing output; resubscribe receives it |
| Disconnect (long) | No subscriber for > former grace period; PTY alive; no `SIGINT` issued |
| Explicit hold | `hold_session` still terminates — the user's intent is preserved |
| Idle reaper | Settled + inactive past threshold → reaped; mid-turn session never reaped regardless of age |
| Restart | Spawn, `close()`, restart → registry has a recorded terminal state for every session; nothing is silently forgotten |
| PTY hangup semantics | The measurement in *Problem*, as a regression test: a node-pty child dies when its parent exits, and survives if it ignores `SIGHUP`. Pins the assumption the whole restart story rests on, so a node-pty upgrade that changes it fails loudly |
| Crash | `SIGKILL` the streamer → reconciler recovers from PID probe alone, with no persisted exit |
| Surviving agent | An agent alive after a `dispose()`-less exit (dev-takeover path) is found, classified `detached`, and keeps its metadata |
| Orphan/PID reuse | Registry row whose PID now belongs to an unrelated process → `orphaned`, never signalled |
| Multi-client | Two subscribers, one leaves → no timer armed, other keeps streaming |
| Long-running | Agent task outliving the former grace period completes intact |
| Graceful shutdown | Clean `stop()` persists terminal state for every session |
| Cross-platform | Reconciler probe on macOS/Linux; Windows behaviour asserted explicitly, whichever way it resolves |
| Resume semantics | Claude `--resume <uuid>` and Codex `resume <id>` unchanged before and after |

---

## Implementation order

1. Phase 1 — decouple subscriber count from lifetime; idle reaper; rename the kill.
2. Phase 2 — migration `010`, registry writes, terminal-state recording on shutdown.
3. Phase 3a — boot reconciliation, PID+cmdline classification, `lifecycle` field.
4. Contract publication for U4 once Phase 3a is green on both integration branches.

Each phase is its own commit within this task's branch, so a bisect lands on a single change and any phase can be reverted without disturbing the ones before it.

Deferred to a follow-up task, with the measurement above as its justification: master-fd relocation (Phase 3b / alternative D) for deliberate-restart survival.
