# Live sessions persistence — architecture audit

**Date:** 2026-07-29
**Branch:** `plan/live-sessions-persistence` (from `integration/missing-prs-2026-07-23`, HEAD `90c1c07`)
**Scope:** what survives a streamer restart and a machine restart today, and what does not
**Companion:** [live-sessions-persistence-plan.md](./live-sessions-persistence-plan.md)

This is an audit of the code as it stands on the integration branch. It does not propose changes; the plan document does that.

---

## 0. Where this starts from

The C1 *durable session runtime* work ([docs/architecture/2026-07-24-durable-session-runtime.md](../architecture/2026-07-24-durable-session-runtime.md)) already landed Phases 1, 2 and 3a on this branch:

- **Phase 1** — a WebSocket disconnect no longer arms a kill timer (`handleWsClose`, `src/server.ts:998`). The only caller of `startGraceTimer` is an explicit `{ type: "hold_session" }` (`src/server.ts:991`). An idle reaper (`reapIdleSessions`, `src/server.ts:1378`) bounds PTY growth by measuring *agent* silence — `IDLE_REAP_AFTER_MS` = 6 h, swept every `IDLE_REAP_SWEEP_MS` = 5 min — and never touches a `running` session.
- **Phase 2** — `managed_sessions` (migration `010`) persists session identity and provenance. Written at spawn (`recordSessionSpawn`, `src/server.ts:1288`), on every status transition (`onStatusChange`, `src/server.ts:763`), and at shutdown (`recordShutdownState`, `src/server.ts:1340`).
- **Phase 3a** — a boot reconciler (`reconcilePreviousSessions`, `src/server.ts:1218` → `classifySession`, `src/services/sessions/reconcileSessions.ts:54`) classifies rows left by previous runs into `attached | detached | orphaned | resumable | completed | failed`.

So the *disconnect* failure — a phone backgrounding, losing signal, or handing off Wi-Fi → cellular — is solved. This audit is about the two failures that are not: **the streamer process restarting**, and **the machine rebooting**.

---

## 1. Current behaviour on server restart

### 1.1 The shutdown path

```
SIGINT / SIGTERM  (cli/index.ts:313-317, prod: :321-322)
  └─ StreamerServer.close()                         src/server.ts:1901
       ├─ clear grace timers, idle-reaper interval
       ├─ recordShutdownState()                     src/server.ts:1340
       │    └─ for each live session:
       │         recordStatus(id, "idle", "shutdown", { completedAt: now, … })
       ├─ await in-flight cache writes, close scanners, cache.close()
       └─ ptyManager.dispose()                      src/server.ts:1934
            └─ session.process.kill()   ← node-pty default: SIGHUP
```

Every agent dies. That is deliberate and correct given the current architecture — see §4.

### 1.2 The boot path

```
StreamerServer.listen()                             src/server.ts:1509
  ├─ bindWithRetry(port)
  ├─ start idle-reaper interval
  ├─ ConversationCache.open(cache.db)               → runs SQLite migrations
  ├─ managedSessionsRepo = new ManagedSessionsRepository(db)   src/server.ts:1577
  ├─ void reconcilePreviousSessions()               src/server.ts:1581  (fire-and-forget)
  │     └─ listNonTerminal()  →  WHERE completed_at IS NULL
  └─ warm-up scan
```

**And this is where a cleanly restarted session vanishes.** `recordShutdownState()` writes `completed_at = now`, so the row no longer satisfies `completed_at IS NULL` and `listNonTerminal()` (`src/db/repositories/managed-sessions.repository.ts:117`) excludes it. The reconciler produces **zero verdicts** for a clean restart. Nothing is added to `SessionStore`, which starts empty every boot (`src/session-store.ts:16-17`).

The net user-visible result of a clean restart: the session is gone from `GET /api/sessions`. It reappears only as a *historical conversation* through `/api/conversations` or `/project-chats`, mapped by `conversationToResumableSession` (`src/server.ts:4993`) to `status: "on_hold"` — indistinguishable from a conversation the user closed themselves weeks ago.

### 1.3 The crash / takeover path

Two paths exit without reaching `close()`, so no shutdown write runs:

- `src/lifecycle/dev-takeover.ts` installs `SIGINT`/`SIGTERM`/`SIGHUP` handlers that `process.exit(0)` directly.
- `cli/index.ts`'s prod `uncaughtException` / `unhandledRejection` handlers `process.exit(1)`.

Plus `SIGKILL`, `launchctl bootout`, OOM, and power loss.

Here the row *does* stay in the probe set, so the reconciler runs. It probes the recorded pid via `isPidAlive` (`src/lifecycle/process-liveness.ts`) and — because the agent died of `SIGHUP` when the master fd closed — finds it dead. `probe.endedCleanly` is not supplied at the call site (`src/server.ts:1227` passes only `{ isPidAlive, getProcessArgs }`), so `classifySession`'s `?? false` fallback makes the verdict `resumable` for **every** dead process. The verdict is stored in the in-memory `sessionLifecycles` map — and then, in practice, never surfaces (see G2 below).

---

## 2. Current behaviour on machine restart

### 2.1 The server comes back; nothing else does

- **macOS** — the LaunchAgent plist sets `RunAtLoad` and `KeepAlive` (`scripts/deploy.sh:418-420`), so the streamer restarts at login. Homebrew's `homebrew.mxcl.tb-streamer` label behaves the same.
- **Windows** — the scheduled task triggers `-AtLogOn` (`scripts/deploy.ps1:227`).
- **Agents** — all gone. No user-space mechanism survives a reboot.

### 2.2 What the reconciler does with pre-reboot rows

`managed_sessions` lives in `~/.threadbase/cache/cache.db`, so rows survive the reboot intact — **including `pid` values recorded under the previous boot**. Pid assignment restarts at boot, so those numbers no longer identify anything: a row that recorded `pid = 45231` for an agent yesterday still says `45231` today, and today that number belongs to whatever the OS has since handed it to. The reconciler has no notion of "which boot was this recorded in", so it probes them anyway:

| Row state after reboot | `classifySession` outcome | Correct outcome |
|---|---|---|
| pid not reused | `resumable` ✅ | `resumable` |
| pid reused, argv lacks the token | **`orphaned`** ❌ | `resumable` |
| pid reused, argv happens to contain the token | **`detached`** ❌ (claims a live process that is not ours) | `resumable` |

The third row is not purely theoretical. For a *fresh Codex* session the recorded token is the **project path** (`spawnArgvToken`, `src/server.ts:1272-1275`), because a fresh `codex --cd <path> --no-alt-screen` spawn carries no session id in argv. Any process whose command line contains that path satisfies the guard.

`orphaned` is additionally a dead end: it is never re-evaluated into `resumable`, and it is never actionable — the architecture doc is explicit that `orphaned` is "a report, not a cleanup trigger".

---

## 3. State inventory

### 3.1 Durable today

| Store | Contents | Location |
|---|---|---|
| `managed_sessions` (migration `010`) | `session_id`, `provider`, `pid`, `cmdline`, project path/name/branch, `status` + `status_source` + `status_updated_at`, `started_at`/`completed_at`/`last_activity_at`, `prompt_count`, `session_name`, `project_id`, `bound_conversation_id`, `resumed_from_conversation_id`, `failure_reason`, `streamer_instance_id` | `~/.threadbase/cache/cache.db` |
| Provider JSONL | The authoritative transcript. Claude appends to the same `<uuid>.jsonl` on `--resume`; Codex writes date-partitioned rollouts | `~/.claude/projects/`, `~/.codex/sessions/` |
| Conversation cache | `conversation_meta`, message tails, offset index, `cache_metadata` | `cache.db` |
| Projects, devices, push tokens | migrations `001`, `011`, `012`, `013` | `cache.db` |
| Server config | api key, `claude_flags`, `feature_flags`, `pty_grace_period_ms`, … | `~/.threadbase/server.yaml` |

### 3.2 In-memory only — lost on every restart

| What | Where | Consequence of loss |
|---|---|---|
| Both `SessionStore` maps | `src/session-store.ts:16-17` | The entire live session list. This is the headline loss. |
| `outputBuffer` (64 KiB ring), xterm `screen`, `inputHistory` | `src/pty-manager.ts:136-147`, `src/codex-pty-runner.ts:163-174` | No `terminal_replay` after restart. Deliberate (see the 010 migration header) — the JSONL is authoritative — but it means replay is conversation-accurate, never byte-accurate. |
| `pendingQuestions`, `pendingQuestionKey`, `pendingPermission`, `pendingPermissionKey` | `src/server.ts` | An in-flight AskUserQuestion or permission gate is silently dropped. |
| `sessionSubscribers`, `clientIdToWs`, `wsToClientId`, `terminalSeq` | `src/server.ts` | Rebuilt on reconnect; harmless. |
| `lastAgentChunkAt` | `src/server.ts` | Idle-reaper clock resets; harmless (falls back to `startedAt`). |
| `idempotency` (`src/services/sessions/idempotency.ts`) | per session | A retried `POST /input` after restart can double-submit. |
| `selfPtyEndedAt` | `src/server.ts:1094` | A resume right after a restart can be misread as a *foreign* collision by `conversationBusy`, yielding a spurious `409 CONVERSATION_BUSY`. |
| `sessionFileMap`, `externalTails`, `discoveryCache`, `contendedSessions` | `src/server.ts` | Re-derived lazily; harmless. |
| `sessionLifecycles` | `src/server.ts` | Rebuilt by the reconciler each boot — but only from rows still in the probe set. |
| `ptyGraceTimers`, `ptyGraceDeferCounts` | `src/server.ts` | Harmless. |

---

## 4. Why true PTY continuity is not available today

This is measured, not assumed, and the measurement is pinned by a regression test (`__tests__/pty-parent-exit-hangup.test.ts`).

node-pty 1.1.0 spawns with `POSIX_SPAWN_SETSID`, so every agent is already a session leader in its own process group with the PTY slave as its controlling terminal. No *process-group* signal from the streamer reaches it. It is tempting to conclude the agents would survive if the streamer simply stopped calling `kill()`.

They do not. When the streamer exits, the last PTY **master** fd closes, and the kernel sends `SIGHUP` to the foreground process group of the terminal that just lost its master. `setsid` is precisely what elects the agent to be that foreground group. The same call that detaches it from our process group is what puts it in line for the hangup.

Consequences, stated plainly:

| Scenario | Process continuity | Byte-accurate replay | Conversation continuity |
|---|---|---|---|
| Server restart, current architecture | ✗ — `SIGHUP` on master-fd close | ✗ | ✓ via `--resume` / `codex resume` |
| Server restart, master fd held out-of-process | ✓ | ✓ (holder owns the ring buffer) | ✓ |
| `SIGKILL` of the streamer | ✗ | ✗ | ✓ |
| **Machine restart** | ✗ **impossible in user space** | ✗ | ✓ via `--resume` / `codex resume` |

So: the *only* durability primitive that works across both restart kinds is **provider-native resume**, and the *only* way to get process continuity across a server restart is to move ownership of the master fd out of the streamer process.

---

## 5. Gaps

Each is symptom → cause → code site. These are what the plan document addresses.

### G1 — A cleanly-restarted session is forgotten, not recoverable

`recordShutdownState()` writes `completed_at = now` (`src/server.ts:1348`), which removes the row from `listNonTerminal()`'s probe set. The one signal that distinguishes "the streamer stopped it" from "the agent finished" — `status_source = 'shutdown'` — is written but never read back by anything.

### G2 — Reconciler verdicts are computed and then unobservable

`withReconciledLifecycle` (`src/server.ts:1136`) overlays a verdict onto a `SessionResponse` **that already exists**. A dead previous-run session is in neither the `managed` map nor the `discovered` map, so `SessionStore.list()` emits no row for it and there is nothing to overlay onto. `handleGetSession`'s cache fallback (`src/server.ts:3645-3648`) returns `conversationToResumableSession(...)` without consulting `sessionLifecycles` either.

In practice a verdict is only ever visible when process discovery *independently* surfaces the same conversation id — i.e. for genuinely surviving processes, which is the rarest case.

### G3 — `completed` is unreachable for a dead process

`classifySession` takes an optional `endedCleanly` probe (`src/services/sessions/reconcileSessions.ts:41-45`) to tell `completed` from `resumable`. The call site (`src/server.ts:1227`) never supplies it, so the `?? false` branch always wins and every dead session is `resumable`, including ones that finished perfectly.

### G4 — The probe set grows without bound

Only `completed` and `failed` verdicts get a terminal write (`src/server.ts:1236-1240`). `resumable`, `detached` and `orphaned` rows keep `completed_at IS NULL` forever, so every boot re-probes the entire accumulated history — each non-terminal row costing an `isPidAlive` call plus, when alive, an async `ps` (`getProcessArgs`, `src/process-discovery.ts:219`). There is no retention policy and no cap.

### G5 — Post-reboot pid probing is unsound

`managed_sessions` has no notion of which machine boot a `pid` was recorded in. See §2.2 for the two wrong verdicts this produces.

### G6 — Codex fresh sessions record an unresumable id

A fresh Codex session gets `id = randomUUID()` (`src/codex-pty-runner.ts:309`) — a **local placeholder**, because Codex has no `--session-id` equivalent and assigns its own rollout id only once it writes its JSONL. `watchForCodexRollout` (`src/server.ts:4711`) discovers that id later and sets `boundConversationId`.

The registry stores the placeholder as `session_id` (the primary key) and the real one as `bound_conversation_id`. Nothing in the reconcile or resume path prefers the latter, so:

- a verdict of `resumable` keyed on the placeholder is not actionable — `codex resume <placeholder>` fails;
- `handleResume` resolves a project path via `findJsonlPath` / `findConversationByUuid` on the requested id, which finds nothing for a placeholder;
- a fresh Codex session that ends before the 120 s binding window closes has *no* resumable identity at all, yet is still classified `resumable`.

### G7 — The pid-reuse guard is weak for fresh Codex

`spawnArgvToken` falls back to `projectPath` for unbound Codex sessions (`src/server.ts:1272-1275`). Two sessions in one project share a token, and any unrelated process with that path in its argv satisfies the identity check. The comment acknowledges this; §2.2 shows why it matters more after a reboot.

### G8 — No rehydration

`SessionStore` starts empty and nothing seeds it. Continuity is entirely a client-side concern: mobile has to notice the session is gone and fall back to the conversations list.

### G9 — No post-restart replay substitute

`terminal_replay` is served from the live PTY's rendered screen (`getOutputLines`). After a restart there is no screen, and the ring buffer is deliberately not persisted. Nothing currently synthesises a conversation-level replay in its place.

### G10 — `attached` is unreachable across restarts by construction

`streamerInstanceId = randomUUID()` per process (`src/server.ts:440`), so `row.streamer_instance_id === currentInstanceId` is false for every pre-restart row. That is semantically right — a new run genuinely does not own the old fd — but it means `detached` is the only live-survivor branch, and after a reboot that branch is always wrong (G5).

### G11 — Mid-turn interruption is unsignalled

A session killed while `running` loses its unflushed answer. `status_source='shutdown'` records that *we* stopped it, but that never reaches a client, so the user cannot distinguish "interrupted mid-answer, worth resuming" from "finished normally".

Restart deferral exists only in the updater path — `countActiveSessions` (`src/updater/active-sessions.ts`) asks the running streamer for `?status=running,waiting_input` and defers the update if any exist. Nothing equivalent guards `tb-streamer prod restart`, a `launchctl kickstart`, or a reboot.

### G12 — In-flight gates are lost

`pendingQuestions` / `pendingPermission` are in-memory. A session resumed after a restart re-enters an unknown gate state; the client's last-known question card refers to a `toolUseId` the new process has never heard of.

---

## 6. Mobile compatibility constraints

From [docs/compatibility/tb-mobile.md](../compatibility/tb-mobile.md). These bound every option in the plan.

**Do not add a new `SessionStatus` value.** This is the sharpest constraint and it is easy to get wrong, because the compatibility doc says *"adding a new session status value is safe — mobile displays it as-is"*. That is true of rendering, and false of filtering:

- `VALID_STATUSES` (`src/server.ts:5074`) is `["running", "waiting_input", "idle"]` and rejects anything else in `?status=`;
- `SessionStore.paginate` (`src/session-store.ts:101-103`) drops any session whose status is outside the requested set.

So a session carrying a brand-new status string would **disappear** from any already-shipped client that filters — which includes the updater's own active-session probe. Recovery state must travel on the additive `lifecycle` / `statusSource` / `statusConfidence` axes instead, all of which already exist on `SessionResponse` (`src/types.ts:315-327`).

**Other frozen surface:**

- Endpoint paths — `/api/sessions`, `/api/sessions/{id}`, `/api/sessions/resume`, `/api/sessions/start`, `/api/sessions/{id}/input|cancel|output|files`.
- Field names and casing on `SessionResponse`: `id`, `status`, `projectPath`, `projectName`, `branch`, `lastOutput`, `elapsedMs`, `promptCount`, `conversationId`, `startedAt`, `completedAt`, `lastActivityAt`, `failureReason`, `ptyAttached`.
- **`conversationId === id` for the lifetime of a live session**, regardless of provider. It is never rekeyed once a client has navigated to it. This is what forbids "just rehydrate the Codex session under its bound id".
- `boundConversationId` is the additive field for a discovered-after-the-fact rollout, distinct from both `conversationId` and `resumedFromConversationId`.
- WS event type strings; `conversation_event` must keep being emitted alongside `conversation_events`.
- `Authorization: Bearer <token>` **and** `/ws?key=<token>`; api key format `tb_<32-hex>`.
- Status codes: `401` → re-auth UI, `404` → not-found (suppressed for `/output`), `429` → shown during pairing.

**Safe:** new optional response fields, new endpoints, new optional query params with defaults, new WS event types.

---

## 7. Summary

| Question | Answer today |
|---|---|
| Does an agent survive a streamer restart? | No — `SIGHUP` when the master fd closes. |
| Does an agent survive a machine restart? | No, and it cannot. |
| Does the *server* come back after a reboot? | Yes — launchd `RunAtLoad`/`KeepAlive`, Windows `-AtLogOn`. |
| Is session identity persisted? | Yes — `managed_sessions`, since migration `010`. |
| Is it *used* after a clean restart? | **No.** `completed_at` removes the row from the only read path. |
| Can the user get back to their work? | Only by finding the conversation in the history list. |
| Is the transcript safe? | Yes — the provider JSONL is authoritative and untouched. |

The transcript was never at risk. What is missing is that the streamer forgets a session was ever live, so the shortest path back to a 3-hour conversation is a search through history rather than a tap on the session that was open a minute ago.
