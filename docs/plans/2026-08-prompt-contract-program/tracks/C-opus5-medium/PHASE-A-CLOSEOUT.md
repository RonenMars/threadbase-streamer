# Phase A close-out — streamer 1.69.6 (legacy path)

Source material for `PROBE-REPORT.md`. Written by `cross-version-verifier`; the report itself is the orchestrator's.

- **App under test:** threadbase-mobile `40ac02ace616b1a5e07b6350a1319b80eb32addc`
- **Streamer:** `@threadbase-sh/streamer@1.69.6`, reporting `1.69.6+source` from a live `GET /api/info`, port **8769**
- **Device:** iPhone 17 Pro, **iOS 26.5**, UDID `6FE5C67C-F90B-4D4F-8287-2C49E4579F62`
- **Scratchpad root (`$SCRATCH`):** `/private/tmp/claude-501/-Users-ronenmars-dev-ai-tools-ai-investigation-claude/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad`
- **Date:** 2026-08-28

---

## 1. Verdict table

| # | Row | Verdict | One-line basis |
|---|---|---|---|
| 1 | Gate opens → card renders | **PASS** | Card built from legacy `permission`; `subscriberCount: 2` proves session scoping server-side |
| 2 | Tap an option | **PASS** | `POST /permission/answer → 200` from the app's UA; `contentKey`+`gateId` proven via the handler's own rejection ladder; one `tool_use`, one artefact, one mtime |
| 4 | Terminal state | **PASS** | `permission_cancelled` clears the card; zero bytes written |
| 5(a) | Reconnect, card open | **PASS** | Holds under soft backgrounding (×2) **and** a hard process kill; replay staged 68/68/68/**71** |
| 5(b) | Reconnect, answer pending | **NOT RUN** | No such state exists on 1.69.6 — see §4.1 |
| 5(c) | Reconnect, after resolve | **PASS** | Re-run clean; original run superseded — see §5.2 |
| 6 | Two clients race | **PASS on the server half; UI-loser half NOT RUN** | One 200, one 409, one execution — see §4.2 |
| 8 | Composer text while a prompt is open | **PASS on intent, mechanism divergent** | App refuses client-side; `409 prompt_pending` never fires — see §3.8 |
| 8b | Server guard, direct POST (server-only) | **PASS** | `409 prompt_pending`, `promptKind: "permission"`, zero bytes |
| 9 | Old-streamer control | **PASS** | Zero `prompt_*` frames on a socket proven to carry `permission` |
| — | Falsifiability battery | **PASS** | 4 refusals + a positive control — see §6 |

Phase-2 exit criterion for this half — *"new mobile / old streamer degrades"* — **is met**: the app at 40ac02ac drives the legacy `permission` path end to end with no contract frame present, and never renders or requests anything the old server cannot answer.

---

## 2. Rig, and why its configuration is load-bearing

### 2.1 Isolation

`HOME=$SCRATCH/home-169`, `THREADBASE_CONFIG_DIR=$SCRATCH/cfg-169`, `--port 8769`, `--default-permission-mode acceptEdits`, `--no-pair-qr`. Node pinned by absolute path (`node` is a shell function on this box).

`lsof` on the running rig lists only scratchpad SQLite handles and **zero** under `/Users/ronenmars/.threadbase`:

```
$SCRATCH/cfg-169/runtime.db{,-shm,-wal}
$SCRATCH/home-169/.threadbase/cache/cache.db{,-shm,-wal}
$SCRATCH/home-169/.config/threadbase-scanner/index.db{,-shm,-wal}
```

**`THREADBASE_CONFIG_DIR` alone is not sufficient isolation.** It moves `server.yaml`, `keys/` and `runtime.db`, but `cacheDir` defaults to `homedir()/.threadbase/cache` and 1.69.6 exposes no `--cache-dir` flag. Overriding `HOME` is the only way. See §5.1.

### 2.2 The CLAUDE profile is a condition of every row, not a setup detail

`$SCRATCH/home-169/.claude/settings.json`, sha256 **`6ec0209d91f9fa23de6ed92b5e6df8585e9a3a3e64816c3dad4fc1730aefbc88`** (unchanged from creation through close-out, re-verified after the outage):

```json
{ "includeCoAuthoredBy": false,
  "permissions": { "allow": [], "deny": [], "ask": [] },
  "theme": "dark", "autoUpdates": false,
  "agentPushNotifEnabled": true, "inputNeededNotifEnabled": true }
```

There is **no `defaultMode` key at all**, so Claude Code's built-in default applies and the streamer's `--permission-mode acceptEdits` is the only mode source reaching the spawn.

**Every row above ran under this profile, and none of them would have gated under the user's own.** The real `~/.claude/settings.json` carries **114 `Bash(...)` allow rules** including `Bash(ls:*)` and `Bash(ls *)`, `permissions.defaultMode: "auto"`, an `autoMode` soft-deny block, plus personal agents, hooks and plugins. Under it, Claude Code v2.1.247 ran `ls -la` and `uname -a` with **no gate at all** — in `acceptEdits` *and* in `manual` mode — and dispatched the commands into subagents (`[List directory contents]`, `[System information]`) so nothing ever painted for the streamer's screen detector to find.

*A reader must not read "gates under the production default" as "gates under the user's profile".*

### 2.3 Provocation

Fixed string, recorded verbatim, used in every row:

```
Run the shell command: curl -sS https://example.com -o ./probe-example.html
```

Chosen over the plan's `ls` for the reason in §2.2. It gates under `acceptEdits`, so "default permission mode" is preserved.

### 2.4 Method deviations (both approved)

- **No Expo MCP.** `expo-local` was not exposed to the session; `ToolSearch` returned no match (search shape confirmed working by retrieving other tools). Substitutes: `xcrun simctl io … screenshot`, `.expo/dev/logs/start.log`, Maestro **2.8.0**. iOS 26.5 → `hideKeyboard` avoided per tb-mobile's note; taps by text selector or point.
- **Provocation** as §2.3.

### 2.5 Bundle provenance method

Verified per phase off the **served bundle** (27,424,807 bytes), never from the worktree HEAD, using three discriminators from 40ac02ac's own diff — two that must be present, one that must be absent:

| discriminator | expected | observed (both verifications) |
|---|---|---|
| `prompt_snapshot` | > 0 | 5 |
| `unsupported_prompt_shape` | > 0 | 3 |
| `RawKeyBar` (deleted by 40ac02ac) | 0 | 0 |

The binary was additionally tied to the pinned worktree by DerivedData `info.plist` → `WorkspacePath` = `…/tb-mobile-worktrees/probe-40ac02ac/ios/Threadbase.xcworkspace`. **Carry this method to phase B and re-verify there rather than assuming.**

### 2.6 Log-gap discipline

`$SCRATCH/evidence/streamer-169.log` is one continuous file, appended across a restart, with **no coverage between `2026-08-28T06:07:37.702Z` and ~`11:21` local** (session-limit outage; the rig and Metro died, the simulator survived). **Any count spanning that window must be quoted as a before/after delta, never as a whole-file total.** All counts below observe this.

---

## 3. Row records

Common to every row: app `40ac02ac` (served-bundle verified), streamer `1.69.6+source` on 8769, isolated profile per §2.2, content-free logging checked with a positive control on the same file (`grep -c 'example.com'` → **0** every time, against a live non-zero control such as `ws.broadcast_permission`). No stop-work trigger fired at any point.

### Row 1 — gate opens → card renders. **PASS**

- **Session:** `b200a95a-432a-454a-8af4-a50c06cd2555`
- **Sent:** the §2.3 string, typed into the app's own composer and sent with the send button (not the HTTP API). Screenshot of the composer holding the exact text: `evidence/shots/row1-11-typed.png`.
- **Frame** — one, at `2026-08-28T05:31:19.251Z`:
  - `type: "permission"` · `gateId: 7e4c08e7-2844-45f9-98ab-0ee2b1d55441` · `cursor: 1`
  - `prompt: "Do you want to proceed?"`
  - `detail:` `"Bash command\nTip: auto mode handles these prompts for you…\ncurl -sS https://example.com -o ./probe-example.html\nDownload example.com to probe-example.html\nThis command requires approval"`
  - `options:` `[(1,"Yes"), (2,"Yes, and don't ask again for: curl *"), (3,"Yes, and switch to auto mode · …"), (4,"No")]`
  - `contentKey:` prompt + detail + option list joined by `::`
  - **No `revision` key** (checked explicitly: `'revision' in frame` → `False`) — the pre-contract shape.
- **Card:** `evidence/shots/row1-12-card.png` — heading "Do you want to proceed?", the four options as radio rows in frame order, Cancel at the foot, `detail` reproduced above.
- **Composer:** cleared after send, enabled, no alert.
- **Scoping, from the server:** `{"event":"ws.broadcast_permission","sessionId":"b200a95a-…","subscriberCount":2}` at `05:31:19.247Z` — 4 ms before arrival on the tap. Two subscribers = app + tap, nothing else. Contrast: the three earlier dry-run gates logged `subscriberCount:1`.

### Row 2 — tap an option. **PASS**

- **Session:** `b200a95a-…`, continuing row 1's gate `7e4c08e7-…`
- **Sent:** a tap on the **plain "Yes"** row (`^Yes$`), anchored by `assertVisible: "Do you want to proceed?"` immediately before it. Neither "don't ask again" nor "auto mode" was ever selected in any row.
- **Route:** `POST /api/sessions/b200a95a-…/permission/answer → 200, 5ms` at `05:36:07.835Z`, `ua: Threadbase/1 CFNetwork/3860.600.12 Darwin/25.5.0` — the app's own request. (The only other `permission/answer` line at that point was my `Python-urllib/3.14` 409 dry run.)
- **That the body carried `contentKey` + `gateId`, without a proxy.** 1.69.6's `handlePermissionAnswer` rejects on each field independently before 200 is reachable: missing/non-string `contentKey` → 400; `contentKey ≠ permissionGateKey(gate)` → 409 `gate_mismatch`; `gateId` present but ≠ `gate.gateId` → 409 `gate_mismatch`; **`gateId` absent → logs `permission.answer_legacy_identity`**. `grep -c 'permission.answer_legacy_identity'` is **0** before and after the tap. So the 200 proves a matching `contentKey`, and the absent log line proves a `gateId` was sent and matched. *Keep this technique — it beats standing up a proxy.*
- **Exactly one PTY write, read provider-side.** Transcript `$SCRATCH/home-169/.claude/projects/…-scratchpad-proj-169/b200a95a-….jsonl`: exactly **one** `Bash` `tool_use` (`toolu_01TMJPBfDMTrADW2KZoCc4DG`, the exact curl) and **one** `tool_result`. Pre-tap state was 1 `tool_use` / **0** results. Artefact: `probe-example.html`, 559 bytes, single mtime `08:36:08` — one second after the 200; a `find` across the whole scratchpad returns that one path.
- **Card:** cleared. `evidence/shots/row2-20-after-tap.png` — the executed call rendered inline, `Done — saved to ./probe-example.html`.
- **Composer:** returned to the enabled placeholder.

### Row 4 — terminal state. **PASS**

- **Session:** `b200a95a-…`, fresh gate `26d16ff0-612f-44d6-b945-4519e3164fa8` at `05:37:47.559Z`
- **Sent:** the cancel was **not** an answer and **not** a card tap — `POST /api/sessions/…/input` with body `{"keys": ""}`, a bare Escape, which is what the gate screen itself advertises ("Esc to cancel · Tab to amend · ctrl+e to explain"). Response `200 {"ok":true}`. Nothing went to `/permission/answer` in this row.
- **Frames:** since the mark at line 76 the tap carries **exactly two gate frames, and no others of any prompt or permission type** (the file also carries 41 non-gate frames in that span — 22 `terminal_output`, 6 `session_update`, 6 `conversation_event`, etc.):
  - `05:37:47.559Z` `permission` `26d16ff0-…` — keys: `contentKey, cursor, detail, gateId, options, prompt, sessionId, type`
  - `05:38:13.405Z` `permission_cancelled` — keys: **`sessionId, type` only**
- **Card:** rendered (`evidence/shots/row4-40-card-open.png`), then cleared on `permission_cancelled` (`row4-41-after-cancel.png`). The turn closes out as `Interrupted · What should Claude do instead?`.
- **Zero bytes, with a positive control.** `ls probe-example.html` errors with No such file; the same `ls` shape against `README.md` in that directory returns a row. Provider side: 2 `tool_use` / 2 `tool_result` — the cancelled call produced a *result*, never an execution.

**Two structural facts for the phase-B comparison:**
1. **1.69.6's terminal frame is identity-free.** `permission_cancelled` carries only `sessionId` and `type` — a client holding two gates on one session could not tell which closed. That is precisely the gap `prompt_event`/`resolved` with a `promptId` exists to close.
2. **Gate identity is minted per gate, not per content.** The re-provocation produced a byte-identical gate shape under a *new* `gateId`.

### Row 5 — reconnect at three states

Disconnects were driven from the **app** side, because that is the socket death mobile actually experiences.

**5(a) — card open. PASS, under two different mechanisms.**

- *Soft (backgrounding).* Gate `b0426151-45ca-4f9d-b395-a15550825982` open; `ws.replay_permission` fired at `05:41:30.328/.329Z` (×3) and again at `05:42:15.648Z` (×3). That event fires only inside `subscribe_session` when `pendingPermission` holds a gate — i.e. the server saying "a client resubscribed and I replayed the open gate". Card returned complete: `evidence/shots/row5-51-after-reconnect-card-open.png`, all four options, `History · 11 messages`.
- *Hard (process kill).* Session `ad61a332-8873-4261-8c35-2342fee1f44a`, gate `a277074d-7c0d-4c2f-a338-f15d7083b9b4` at `08:49:46.235Z`, `subscriberCount: 2`. `xcrun simctl terminate` — the process dies, so there is no ambiguity about the socket. `ws.replay_permission` measured at **four** points:

  | moment | count |
  |---|---|
  | before the kill | 68 |
  | 10 s into downtime, app dead | 68 |
  | after relaunch, app on the **session list** | 68 |
  | after navigating into the **session screen** | **71** |

  **Finding: relaunching alone replays nothing**, because the session list does not `subscribe_session`. The replay fires only on the session-screen subscribe. This is why endpoint-only measurement is misleading, and it tells phase B exactly where to measure. Card fully restored: `evidence/shots/row5a-132-card-restored.png`.

**5(b) — answer pending (ghost). NOT RUN.** See §4.1.

**5(c) — after resolve. PASS** (re-run; §5.2 records the superseded original).

- Session `2585ec51-e3c3-4450-8dec-fa00785db75b`; gate `274c7033-832d-43f5-9ddb-03642898df07` resolved by the **patched** client B with plain "Yes" (`optionIndex: 0`) → 200.
- Pre-state proven server-side: `POST /permission/answer` with a bogus `contentKey` → **409 `gate_closed`** (the "nothing pending" branch, distinct from `gate_mismatch`). **Attribution:** that reason string comes from the **response body observed client-side**; the streamer does not log 409 reasons — `gate_closed` and `gate_mismatch` both grep **0** in `streamer-169.log`.
- Hard drop (`simctl terminate`) → relaunch → **navigated into the session screen**, because a card-absence on the list screen would be worthless. `ws.replay_permission` **57 → 57 → 57** across the relaunch and the session subscribe: nothing replayed, correctly, because nothing was pending.
- No card: `evidence/shots/row5c-81-session-open-no-card.png` — `History · 4 messages` and the resolved turn only.

### Row 6 — two clients race. **PASS on the server half; UI-loser half NOT RUN**

- **Session:** `f14ad344-70ad-48c8-9aaf-852d6df66dc0`; gate `0d81631a-7e41-4830-ac8d-f4b4fc683140` at `08:31:00.756Z`, `subscriberCount: 2`.
- **Client B was armed off the app's request *reaching the server***, not off tap latency: it parked at the end of `streamer-169.log` watching for a `permission/answer` line on this session with a `Threadbase/` UA, then waited 300 ms. That makes the offset a measurement.

  | | request | response |
  |---|---|---|
  | **App (winner)** | `08:31:39.324Z`, `ua: Threadbase/1 CFNetwork/…` | **200** |
  | **Client B (loser)** | `08:31:39.691Z`, `ua: Python-urllib/3.14`, body `{"gateId":"1d9bc6e5-…","contentKey":"…","optionIndex":0,"label":"Yes"}` | **409 `gate_closed`** |

  Client B's own record: `ms_after_app_answer: 301`.
- **Exactly one provider response:** one `Bash` `tool_use` (`toolu_01CKGUY9eojf4wmGx4pxM7Fh`), one `tool_result`; `probe-example.html` once, 559 bytes, single mtime `11:31:39`.
- **Winner's UI:** `evidence/shots/row6-91-winner-ui.png` — card cleared, turn resolved, composer enabled.
- **Loser's UI notice: NOT RUN.** The app won, so there was no notice to read. The inverted configuration that would produce one is also not runnable — §4.2.

**Two findings from this row (not asides):**
1. **A second client can aim an answer at a gate identity that lived 79 ms.** Client B did not answer the gate the app answered — it addressed `1d9bc6e5-…`, a teardown transient born 13 ms *after* the app's answer and already cancelled 349 ms before B fired. Full ordering:
   ```
   08:31:00.756Z  permission            0d81631a-…
   08:31:39.329Z  permission_cancelled                ← app's 200 lands (.324)
   08:31:39.342Z  permission            1d9bc6e5-…    ← transient, +13 ms
   08:31:39.421Z  permission_cancelled                ← transient dies, 79 ms old
   08:31:39.690Z  permission_cancelled                ← at client B's request
   ```
2. **`gate_closed`, not `gate_mismatch`.** On 1.69.6 a losing client cannot distinguish "someone else answered this gate" from "the gate vanished" — one string covers both.

### Row 8 — composer text while a prompt is open. **PASS on intent, mechanism divergent**

- **Session:** `64d2841b-ad74-4c04-a341-9f8ddc5e9fec`; gate `6c05939a-6f9e-433d-8ee0-70072666fe23` at `08:40:13.777Z`, `subscriberCount: 2`.
- **Expected:** `409 prompt_pending`, draft kept, no alert, view jumps to the card.
- **Observed:** three of four hold. **The fourth cannot, because the app never issues the request.**
  - `/input` requests for the session: **unchanged** after the send tap. `input.prompt_pending` events: **0 → 0**. The server guard — which exists, at `dist/cli.cjs:148602` — was **never reached**.
  - **Draft kept** verbatim: `PROBE-ROW8-DRAFT-KEEP-ME` still in the composer with the cursor after it (`evidence/shots/row8-111-after-send.png`).
  - **No alert**, no toast, no destructive clearing.
  - **View on the card:** the card is pinned at the top of the conversation area, options visible.
- **Positive control, in the row body because it is what makes "no request" a finding rather than a suspected mis-tap.** I resolved the gate, then ran the **identical** flow at the **identical** coordinates `91%,58%` with no prompt open: `POST /input → 200` at `08:42:32.013Z`, `ua: Threadbase/1 CFNetwork/…`, request count **1 → 2**. Same button, same point, same app: sends with no prompt open, sends nothing with one.
- **Reproduced.** Second run on a fresh gate, `PROBE-ROW8-REPRO-TWO`: `/input` **3 → 3**, `input.prompt_pending` **0 → 0**. Identical.
- **Reading:** the app gates the send locally on an open prompt (send button renders dimmed). Against the row's purpose this is *stronger* than expected — no request, so no text can reach the PTY and the draft is never at risk from a failed round-trip. But the documented `409 prompt_pending` is unreachable from this client, and the report must not imply the server guard was exercised.

### Row 8b — server guard, direct POST. **PASS** *(server-only sub-row — not app behaviour)*

- **Session:** `b0c7c8e0-8dc6-4df0-9f0b-363a7ad189c9`; gate `d1dddb99-ad6b-432f-8900-a7aab27c6dd7` at `08:52:47.838Z`.
- **Sent** (from the script, bypassing the app entirely): `POST /api/sessions/b0c7c8e0-…/input` with body `{"input": "PROBE-ROW8B-SERVER-GUARD-TEXT"}`.
- **Response:** **409**
  ```json
  {"ok":false,"reason":"prompt_pending","promptKind":"permission",
   "error":"A prompt is waiting for an answer; answer or dismiss it before sending text"}
  ```
- **Server log:** `input.prompt_pending` **0 → 1**, carrying `sessionId` and `promptKind:"permission"` — and **not** the text.
- **Zero bytes, four independent checks.** The first attempt at this needed correcting: a plain `grep` over the raw terminal dump returned 0 for the marker *and* 0 for the control, proving only that the grep could not match through ANSI escapes. Redone de-escaped, with the controls working:

  | search | expected | observed |
  |---|---|---|
  | marker in de-escaped PTY screen | 0 | **0** |
  | control `Doyouwanttoproceed` in same | > 0 | 1 |
  | control `example.com` in same | > 0 | 5 |
  | marker in provider transcript | 0 | **0** |
  | control `probe-example.html` in transcript | > 0 | 2 |
  | marker on the tap (never broadcast) | 0 | **0** |
  | marker in streamer log | 0 | **0** |
  | control `input.prompt_pending` in log | > 0 | 1 |

  Transcript for the session: **0** `Bash` `tool_use`, **0** `tool_result`; no artefact created.
- **Non-destructive:** the gate survived — the tap shows one `permission` frame and no `permission_cancelled`.

### Row 9 — old-streamer control. **PASS**

- **Dedicated fresh session `31c22332-f799-4da1-8e75-3e3d2038369d` and a dedicated fresh socket.** Row 1's census is not relied on anywhere.
- **Positive control first, on this socket:** gate `2fb4dbbf-bb0c-451b-9769-b988c6570388` at `08:45:41.267Z`, `subscriberCount: 2`, card rendered (`evidence/shots/row9-120-card.png`).
- **The whole lifecycle was then driven across that one socket**, because a `prompt_*` frame could plausibly appear in any of these states: gate open → answered **from the app** → teardown transient → second gate opened → cancelled with Escape → **hard drop and reconnect**.
  ```
  08:45:41.267Z  permission            2fb4dbbf-…
  08:46:10.062Z  permission_cancelled              ← answered from the app
  08:46:10.062Z  permission            d3f5a982-…  ← transient (0 ms)
  08:46:10.092Z  permission_cancelled              ← transient dies, 30 ms old
  08:46:36.404Z  permission            654fd7fe-…
  08:46:36.789Z  permission_cancelled              ← Escape
  ```
- **Census — every frame type that arrived, 128 lines:** `terminal_output` 69, `conversation_event` 25, `session_update` 11, `conversation_events` 8, `permission` 3, `permission_cancelled` 3, `user_message` 2, and one each of `subscribe_session`, `session_list`, `cache_ready`, `host_pressure`, `terminal_replay`. **No frame of any `prompt_*` type: 0.**
- **Substring sweep** (stricter than a type check — catches a contract field nested anywhere), with controls through the identical grep shape on the identical file:
  ```
  prompt_snapshot   0        "type":"permission"   3
  prompt_event      0        permission_cancelled  3
  prompt_resolved   0        gateId                3
  revision          0        contentKey            3
  idempotencyKey    0
  ```
- **Provider side:** 2 `Bash` `tool_use` / 2 `tool_result` — one answered, one cancelled; `probe-example.html` once, 559 bytes, mtime `11:46:10`, matching the single answer.

---

## 4. Cells reported NOT RUN, with reasons

### 4.1 Row 5(b) — reconnect with an answer pending (ghost)

**No such state exists on 1.69.6.** `handlePermissionAnswer` is synchronous end to end — it validates, calls `ptyManager.sendKeys`, and returns `200 {"ok":true}` in the same handler. Nothing is recorded as pending and no frame announces an in-flight answer, so there is nothing to reconnect *into*. The ghost is a v1.70.0 construct; phase B is where it gets tested. This is an architectural fact about the legacy path, not a gap in the harness.

*Recorded honestly:* an attempt to approximate it — background the app, answer from client B while away, foreground — **failed as an approximation**. The log shows `ws.replay_permission` at `05:42:15.648Z`, six seconds *before* the answer POST at `05:42:21.828Z`: the app had already resubscribed, so it was connected the whole time. `simctl launch com.apple.springboard` does not reliably keep this app's socket down on iOS 26.5. That run is counted as a **second instance of 5(a)**, not as 5(b).

### 4.2 Row 6 — the losing client's UI notice

**Unreachable on 1.69.6, because the app withdraws the card before a loser can submit.** Design: client B answers the live gate, then the app taps into an already-resolved gate. Client B answered gate `86035142-…` → 200 at `08:34:49.893Z`. The subsequent Maestro flow **failed its assertion** — `Assertion is false: "Do you want to proceed?" is visible`. The card was already gone (`evidence/shots/inv-100-app-loser.png` shows the resolved turn, no card).

The `permission_cancelled` broadcast reaches the app before a human could tap, so there is no stale affordance to fire a doomed answer from. The plan presumed the loser can still submit; on this version it cannot. Reaching that path needs a client holding a card the server has already closed — a v1.70.0 question, carried into sub-row 3b.

---

## 5. Incidents and corrections

### 5.1 Isolation incident

**What happened.** The first two rig boots ran against the user's real `/Users/ronenmars/.threadbase/cache/cache.db`, proven by `lsof` on the rig PID.

**Window** — from the rig's own log, two short-lived boots:

| boot | `registry.pruned` | `cache.prune_ghosts` | shutdown |
|---|---|---|---|
| 1 | 24 rows, `2026-08-28T04:54:47.207Z` | **removed 0**, `04:54:51.357Z` | `04:54:52.444Z` |
| 2 | 24 rows, `04:55:54.915Z` | **removed 0**, `04:55:57.419Z` | `04:56:06.519Z` |

So **`04:54:47Z – 04:56:06Z`, 79 seconds wall clock**, not "roughly two minutes of continuous overlap". (A third launch attempt around 04:52 died before writing a single log line and never demonstrably opened the file; it is not counted.) The first genuinely isolated boot is `05:01:13.057Z`.

**What the rig did.** `cache.prune_ghosts` removed **0** rows on both boots. The 24 pruned registry rows landed in the isolated `cfg-169/runtime.db` — the documented one-time non-destructive copy of the legacy `managed_sessions` table out of `cache.db`, read-only on the cache side. No deletion and no schema change observed.

**What cannot be excluded.** The launchd prod streamer (PID 58199, port 8766) holds the same file and writes to it continuously, so file mtimes are not attributable. **Non-attributable cache writes during the window cannot be excluded.**

**Prod health after.** Prod PID 58199 alive and serving.

**Integrity check** *(run by the orchestrator; recorded here, not repeated)*: prod `cache.db` plus `-wal`/`-shm` copied to `$SCRATCH/cachecheck.db` and `PRAGMA integrity_check` run **on the copy** → **ok**. Nothing was run against the live file and the prod streamer was not restarted. Because the copy was taken from a live file, a torn copy was possible — so **ok** is positive evidence, not proof of a clean shutdown.

**Second-order effect.** While `.claude` was symlinked, the rig indexed the user's real 415-conversation corpus, and the app rendered a "414 of 415 conversation histories are missing" panel listing real conversation titles. **Not a stop-work trigger**: the app is the user's own device, not an unrelated client, and conversation titles are not prompt or answer content. Cleared by wiping the rig's own cache and scanner index — both isolated and rebuildable. **Nothing under `/Users/ronenmars/.threadbase` or `/Users/ronenmars/.claude` was written to clear it.**

**Fix.** `HOME=$SCRATCH/home-169` with a scratch `.threadbase`, and `.claude` replaced by an isolated profile (§2.2). Credentials still resolve via Keychain through a symlinked `Library` — verified with a headless `claude -p "say OK"` under that HOME, which answered `OK`. Phase B inherits the fix from its first boot: **v1.70.0 never boots against the real home.**

**Footprint in the real Claude store** — closed, finite, and nothing deleted:

```
/Users/ronenmars/.claude/projects/-private-tmp-claude-501--Users-ronenmars-dev-ai-tools-
  ai-investigation-claude-5a89c66b-099c-4812-a0d1-8d11845903b3-scratchpad-proj-169/
    37d0506a-2522-4863-928a-c8ae5e591ad0.jsonl
    7095fd64-ddc3-4a07-9877-e36eb8019a66.jsonl
    memory/            (empty)
```

One folder, mtime `08:10`, holding **two dry-run session transcripts from the pre-fix window, left in place deliberately**. Verified with a positive control: the same glob shape lists 64 folders in that directory. The 13 pre-existing `tbprobe-*` folders from 22 Aug (another track) were counted only, never opened, never touched. After the fix all probe sessions write to `$SCRATCH/home-169/.claude/projects/` (14 transcripts at close-out); the real store received nothing further.

*Note on the `tbprobe-C-` naming condition:* it was ruled unnecessary (option (a)) because the isolated profile closed the real store to further writes and the footprint is enumerated above. No rename was performed.

### 5.2 Harness defect — my client B took a profile-mutating option

**Found by a positive control, which is the point.** Row 6's gate would not open. The first reading was provider flakiness — **that reading is struck**. A positive control with a command *never approved in this session* (`curl -sS https://example.org …`) also failed to gate, which meant gating was disabled, not flaky.

**Root cause — in my script, not in either product.** `handlePermissionAnswer` resolves the choice as `gate.options[optionIndex]`, an **array position**. Each option object in the frame carries its own **1-based `index`**. My `answer.py` looked the option up by `index == 1` for the label, then sent `optionIndex: 1` — the displayed number. The server read position 1, the **second** element: **"Yes, and don't ask again for: curl \*"**.

**Proof it was mine and not the app's.** Claude Code persisted the choice to `$SCRATCH/proj-169/.claude/settings.local.json` as `{"permissions":{"allow":["Bash(curl *)"]}}`, mtime `08:42:21` local = `05:42:21Z`. Against every answer the rig ever received:

```
05:14:00.825Z  409  Python-urllib/3.14   (dry-run trust gate)
05:36:07.835Z  200  Threadbase/1 …       ← ROW 2, the app — no rule written
05:42:21.828Z  200  Python-urllib/3.14   ← ROW 5, my script — rule born here
05:43:20.513Z  409  Python-urllib/3.14   (deliberate bogus-key probe)
```

The app's 200 at `05:36:07` wrote **no** rule; the file did not exist until `05:42:21`. **So the app's option mapping is correct and mine was wrong** — an incidental cross-check in the app's favour.

**Causal control, which is what retires the flakiness reading.** Run as its own item:

| condition | result |
|---|---|
| rule present, fresh session, never-approved command | **no gate** |
| rule deleted, but session started *before* the deletion | **no gate** (Claude Code reads settings at process start) |
| rule deleted, session started *after* | **gate** (`07b5cd31-…` at `05:58:32.217Z`) |

Rule present → no gate; rule gone + fresh process → gate.

**Remediation, all inside the scratchpad.** The rule file and its now-empty `.claude/` directory deleted; `answer.py` and `racer.py` patched to select by **array position**, each with a hard assertion that **refuses to send** any option whose label contains "don" or "auto mode" — the standing rule is now enforced by the harness rather than by attention; `probe-*.html` artefacts removed. `home-169/.claude/settings.json` re-verified at `6ec0209d…aefbc88`, `.claude.json` `projects[proj-169].allowedTools` `[]`, no `settings.local.json` anywhere under `home-169`.

**The `settings.local.json` artefact was deleted during remediation**, so its content and birth timestamp are cited from this record rather than from a file still on disk. Reproduction is one API call.

**Row impact.** Rows 1, 2, 4 and 5(a) unaffected (no answer sent, or the app's own answer). **Row 5(c) superseded** — its gate was resolved by option 2 rather than option 1; the claim held but the resolution path was not as reported, so it was **re-run clean** (§3, row 5(c)) and the original is recorded as superseded with this reason rather than deleted.

### 5.3 Retraction — "inversion B" tested nothing

I nearly reported a defect: live `gateId` with a *stale* `contentKey` returning **200**. It is not a defect. **All four gates in that session share a byte-identical `contentKey`** (sha1 `4163828dfffa42d7…` for each; `gs[0].contentKey == gs[-1].contentKey` is `True`). The "stale" key was the same key and the 200 was correct.

The structural point survives and is a real finding — see §7.

### 5.4 Restart after the session-limit outage

The rig and Metro died; **the simulator survived** (same UDID, still Booted). Rig relaunched with identical isolation and re-verified (`1.69.6+source`, `lsof` clean, pairing survived — same single device `Simulator iOS`). Metro restarted from the pinned worktree (banner `Starting project at …/probe-40ac02ac`, no `Skipping dev server`, so port 8081 was ours). Bundle **re-verified** off the served bundle rather than trusted (§2.5). App relaunched via the `127.0.0.1:8081` deep link — deliberately not the stale LAN target. No reinstall needed or performed.

*Earlier, related:* the `192.168.68.125:8081` load error at ~08:12 was **both** documented causes at once. `expo run:ios --no-bundler` chose the LAN URL itself (its own log line: `Opening exp+threadbase-mobile://expo-development-client/?url=http%3A%2F%2F192.168.68.125%3A8081`) and the app linked at **08:11:00**, while our Metro did not start until **08:19:03** (`root:init`, epoch 1787894343699). Resolved by uninstall + reinstall + deep link to `127.0.0.1:8081` at 08:23 — not the Reload button — closing the stale-target trap for the phase.

---

## 6. Falsifiability battery — reconciled

**Correction first:** my earlier prose said "all four refusals ran inside 6 ms against one gate". **That was wrong.** The refusals came from two clusters. Per-row reconciliation, with the gate each was aimed at:

| # | what was sent | time | status | reason string | aimed at | live gate then | valid? |
|---|---|---|---|---|---|---|---|
| **A** | **stale `gateId`** + live `contentKey` | `08:36:35.357Z` | **409** | `gate_mismatch` | `86035142-…` (stale) | `50904d06-…` | **yes** — ran before the accidental 200 |
| ~~B~~ | live `gateId` + "stale" `contentKey` | `08:36:35.360Z` | 200 | — | `50904d06-…` | `50904d06-…` | **retracted** (§5.3); it consumed the gate |
| **C** | `optionIndex: 99` | `08:37:26.949Z` | **409** | `unknown_option` | `8c43bc63-…` | `8c43bc63-…` | **yes** |
| **D** | `optionIndex: -1` | `08:37:26.951Z` | **400** | `Expected { contentKey: string, optionIndex: number }` | `8c43bc63-…` | `8c43bc63-…` | **yes** |
| **E** | `contentKey` omitted | `08:37:26.952Z` | **400** | same | `8c43bc63-…` | `8c43bc63-…` | **yes** |
| **control** | fully correct, `optionIndex: 0` | `08:37:26.955Z` | **200** | — | `8c43bc63-…` | `8c43bc63-…` | **yes** |

The two calls at `08:36:35.363Z` and `.365Z` were my first attempts at C and the control; both ran *after* B's accidental 200 had consumed the gate, both returned `gate_mismatch` against a transient, and both are **discarded**. C, D, E and the control in the table are the clean re-run. **A came from the earlier cluster** and is valid on its own terms.

**409 reason strings are client-sourced** — the streamer does not log them (§3, row 5(c)).

**What this establishes.** (1) The harness can produce a failing row: four distinct refusals, three reason strings, no false 200. (2) **Refusals are non-destructive** — the control succeeded on the *same gate* after three rejected attempts. (3) **Zero bytes through the refusals**: the session's transcript holds exactly **3** `Bash` `tool_use` and **3** `tool_result`, matching exactly the three `200`s across the whole session (`08:34:49.893`, `08:36:35.360`, `08:37:26.955`) and not one more; `probe-example.html` once, 559 bytes, mtime `11:37:27`, matching the last accepted answer.

---

## 7. Findings

### 7.1 Legacy identity-free answer shape — **streamer #709** (two facets, one root)

Filed by the track owner as one issue on the grounds that both facets share a root: the legacy identity-free answer shape. The stated fix for both is refusing that shape once the client floor (#704) carries `gateId`.

**Facet 1 — `optionIndex` is an array position, not the option's `index`.** The `permission` frame hands clients **1-based `index`** values; the answer route consumes **0-based array positions**, unvalidated. `gate.options[1]` is a perfectly valid option, so an off-by-one returns **200** and silently executes a *different, more permissive* answer than the user chose. On this gate shape "Yes" becomes "Yes, and don't ask again"; one position further becomes "switch to auto mode". Evidence: §5.2, plus `streamer-169.log` lines 946 (app 200, no rule) and 1085 (script 200, rule born), the 409s at 639 and 1128 as controls, and `row1-169.jsonl` for the 1-based `index` fields.

**Facet 2 — `contentKey` is content-addressed, not identity-addressed.** It is derived from prompt + detail + option list, so two successive gates for the same command are **indistinguishable** by it (§5.3: four gates, one sha1). Only `gateId` separates them. A client answering by `contentKey` alone — the pre-`gateId` legacy shape the server still accepts, logging `permission.answer_legacy_identity` — can answer the **wrong instance** of a repeated gate and get a **200**.

### 7.2 Teardown transient on the legacy detector — 4 independent sightings

Answering one gate can emit a short-lived second gate identity as the screen tears down:

| row | session | new gateId | born after the winning answer | lifetime |
|---|---|---|---|---|
| 2 | `b200a95a-…` | `a0f98b40-…` | 13 ms | 51 ms |
| 5 | `b200a95a-…` | `fe005864-…` | 29 ms | 29 ms |
| 6 | `f14ad344-…` | `1d9bc6e5-…` | 4 ms | 79 ms |
| 9 | `31c22332-…` | `d3f5a982-…` | 0 ms | 30 ms |

Four sightings across four different sessions makes this a property of the detector, not an incident. **The app rode it correctly every time** — no card flashed, no card reopened — because this build does not reopen on every `permission` frame. But in row 6 a second client **aimed an answer at one** (§3, row 6). This is what turns phase-B sub-row 3b from a curiosity into a required check.

### 7.3 `grep promptId` is not a test for contract frames

`promptId` appears **9 times** on a pre-contract wire (row 9). All nine sit inside `conversation_event` / `conversation_events` frames, whose `lines` array relays **Claude Code's own JSONL transcript lines verbatim** — and the provider's transcript has a `promptId` field of its own, e.g. `{"parentUuid":null,"isSidechain":false,"promptId":"0c711427-…","type":"user",…}`. Zero occurrences in any streamer-authored frame. **Phase B must key off the frame `type` or a top-level field**, or every conversation relay will read as a false positive.

### 7.4 Baseline facts to re-verify on v1.70.0 (not defects)

- **`keys` vs `input` asymmetry — the #692 design, not a defect and not filed.** A body carrying `keys` reaches `sendKeys` **before** the open-prompt check and is never refused; only `input` is guarded. Gate navigation needs raw keys to reach the PTY. So on the legacy route "a prompt is open" is a barrier on **text**, not a general write barrier. **The one thing that would change this:** if phase B shows *text* can ride inside a `keys` body and reach the PTY while a prompt is open, that is a different claim and goes straight to the orchestrator.
- **The app's local send gate** (row 8) suppresses the request client-side, making `409 prompt_pending` unreachable from the UI.
- **`permission_cancelled` is identity-free**; `gate_closed` covers both "someone else answered" and "the gate vanished".
- **Relaunch alone replays nothing** — only a session-screen `subscribe_session` triggers replay.

---

## 8. Phase-B carry-list

**Required sub-rows**

- **2b** — `/prompt/answer` must reject an unknown or shifted option id with **400 `unknown_option`** and **zero bytes written**, proven the way row 4 and 8b proved zero bytes: artefact absence with a positive control, plus the provider-side transcript. The contract answering by opaque `optionId` is *supposed* to remove the §7.1 class; 2b turns "supposed to" into evidence. If it does not reject: failing row → reproduce twice → bring to the orchestrator → file nothing.
- **3b** — after the answering tap, capture every `prompt_event` in the following **200 ms** and record which case it is: **(a)** transient absorbed — no new `promptId`, or one cancelled before any client could render it; **(b)** a fresh `promptId` in state `open` that the app's reducer would accept. Record exact inter-frame timings as in §7.2. The app at 40ac02ac keys its suppression on `promptId`, so **(b)** would flash a card the legacy client did not — a streamer finding (detector transient on gate teardown), not an app fix. Extended per row 6: also determine whether **a second client can aim an answer at the transient**, and whether the loser gets **`already_resolved` distinctly from `prompt_cancelled`** — 1.69.6 collapses both into `gate_closed`, so phase B is where the contract either earns the separation or does not.

**Questions**

- Does a **resolved `prompt_event` withdraw the card** the same way `permission_cancelled` does (§4.2)? If a client answers anyway, does it get `already_resolved` distinctly?
- Is the app's **local send gate** still engaged on the contract path — same Maestro flow, same positive control — so `409 prompt_pending` stays unreachable from the UI? A version where it becomes reachable is a visible behaviour change for the same user action.
- Does the app's local suppression key off the contract's prompt state as reliably as off the legacy `permission` frame?

**Method to carry**

- **Served-bundle provenance** (§2.5) re-verified against the v1.70.0 rig, not assumed.
- **Isolated CLAUDE profile** (§2.2) — a condition of every row; state it per row.
- **Provocation-after-cancel property:** re-sending the same string into a just-cancelled turn **continues the turn instead of re-gating** (Claude replied "Okay, I'll hold off. Let me know how you'd like to proceed."; `session_update`/`terminal_output` only, zero `permission`). Use a **fresh session or a differently-worded provocation**.
- **Log-gap discipline** (§2.6): before/after deltas, never whole-file totals, for anything counted across the outage window.
- **Never select** "don't ask again" or "switch to auto mode" — now enforced by assertions in `answer.py` and `racer.py`.
- **Client-B pre-flight before any race:** prove the script lands on plain "Yes" (no `settings.local.json` born, command executed) as a separate step; a race with an unproven client B is two variables.
- **Arm client B off the app's request reaching the server**, not off tap latency.
- **Navigate into the session screen** before asserting card presence or absence; measure replay at every stage, not just endpoints.

---

## 9. Evidence index

All paths relative to `$SCRATCH`.

| file | contents |
|---|---|
| `evidence/streamer-169.log` | rig stdout+stderr, continuous, **gap `06:07:37Z` → ~`11:21` local** |
| `evidence/row1-169.jsonl` | rows 1, 2, 4, 5 tap (marks in `row4-mark.txt`, `row5-mark.txt`) |
| `evidence/row5c-169.jsonl` | 5(c) re-run + client-B pre-flight |
| `evidence/row5a-hard-169.jsonl` | 5(a) hard-drop variant |
| `evidence/row6-race-169.jsonl` | row 6 race tap |
| `evidence/row6-clientB.jsonl` | client B's own request/response record incl. `ms_after_app_answer` |
| `evidence/inverted-169.jsonl` | inverted race + falsifiability battery |
| `evidence/row8-169.jsonl`, `row8b-169.jsonl` | rows 8 and 8b |
| `evidence/row9-169.jsonl` | row 9, dedicated socket |
| `evidence/dryrun*-169.jsonl` | rig bring-up, provocation selection, folder-trust gate |
| `evidence/shots/*.png` | 20 screenshots, named by row |
| `tap.mjs` | WS tap — appends every frame verbatim with a host timestamp |
| `answer.py`, `racer.py` | client B, patched (array-position select + refusal assertions) |
| `flows/*.yaml` | Maestro flows |
| `start-169.sh`, `apikey-169.txt` | rig launcher and rig-local key |
