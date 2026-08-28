# Group C — Phase 2 live cross-version probe: PLAN (awaiting approval)

App under test: threadbase-mobile `main@40ac02ac` ("feat(session): consume the provider-neutral prompt contract", squash of #872; `origin/main` is 3 commits ahead — the probe pins 40ac02ac, not `main`).
Streamers: `@threadbase-sh/streamer@1.70.0` (contract) and `@1.69.6` (legacy). Both published on npm — no build from the checkout needed.

## 1. Rigs

### Streamers — scratch installs only
Root: `$SCRATCH = /private/tmp/claude-501/-Users-ronenmars-dev-ai-tools-ai-investigation-claude/5a89c66b-.../scratchpad`.

| | contract rig | legacy rig |
|---|---|---|
| install | `npm i @threadbase-sh/streamer@1.70.0` in `$SCRATCH/str-170/` | same, `@1.69.6` in `$SCRATCH/str-169/` |
| binary | `$SCRATCH/str-170/node_modules/.bin/tb-streamer` | `$SCRATCH/str-169/node_modules/.bin/tb-streamer` |
| port | `--port 8770` | `--port 8769` |
| isolation | `THREADBASE_CONFIG_DIR=$SCRATCH/cfg-170` (+ `THREADBASE_CONVERSATIONS_DIR`, `THREADBASE_BROWSE_ROOT=$SCRATCH/proj-170`) | `cfg-169`, `proj-169` |
| logs | `$SCRATCH/evidence/streamer-170.log` | `streamer-169.log` |

`THREADBASE_CONFIG_DIR` is the documented override (`src/auth.ts`, `src/server-identity.ts`), so neither rig touches the user's real `~/.threadbase/server.yaml`, keys, or sessions. The `tb-streamer` checkout is never run and never modified. Each rig's version is confirmed from `GET /api/info` and recorded in every row. Only one rig runs at a time; a session is never carried between rigs (workspace constraint: no transport migration).

### App — pinned worktree
`git worktree add --detach ../tb-mobile-worktrees/probe-40ac02ac 40ac02ac` (sibling of the repo, per tb-mobile CLAUDE.md; the current checkout is dirty on `fix/rtl-directional-layout` and is left untouched). `npm ci`, `bundle exec pod install` from `ios/`, dev-client build onto a booted iOS 26.x simulator (none booted right now — one gets booted first). Metro at `127.0.0.1:8081`; screenshots and device logs via the `expo-local` Expo MCP.
Two known traps are handled up front: the dev client serves a **disk-cached bundle** → uninstall + reinstall the app before the first probe (this wipes AsyncStorage, so the rig is re-paired afterwards); no shell-exported `EXPO_PUBLIC_*` flags are relied on. The commit actually running is re-confirmed per phase from the built bundle, not from the worktree HEAD alone.

### Evidence capture — three streams per row
1. **WS tap** (`$SCRATCH/tap.mjs`): a second WS subscriber to the same session, authenticated with the rig's API key, appending every frame verbatim + timestamp to `$SCRATCH/evidence/<row>-<version>.jsonl`. It is the frame record, the second subscriber for scoping, and client B for row 6.
2. **Streamer log**: rig stdout/stderr to file — also the check that Phase 1 content-free logging holds (no prompt/answer text).
3. **App side**: Expo MCP screenshots of the card and composer + `.expo/dev/logs/start.log`.
Which HTTP route the app calls is taken from the streamer request log; if that log does not carry method+path, a thin logging reverse proxy in front of the rig is used instead, and if neither works the row's route claim is reported **not run** rather than inferred.
"Exactly one write reaches the PTY" is read off the provider side — one tool execution / one response in the session transcript — not off the client.

### Provocations (fixed strings, recorded verbatim per row)
- **Permission gate**: session in the rig's disposable project, prompt asking for a Bash `ls` under default permission mode.
- **Single-select question**: prompt asking the provider to use AskUserQuestion with two options.
- **Unsupported shape** (row 7): AskUserQuestion asked for explicitly with `multiSelect: true` and two questions; after 3 declined attempts the row is "not run" with the transcript.
- **Cursor-only repaint** (row 3): `POST /api/sessions/:id/input { keys: "[B" }` against an open gate.
Provocations are retried on provider flakiness; the retry count is recorded.

## 2. Probe matrix

Rows run **1.69.6 first** (legacy baseline = the positive control), then v1.70.0.

| # | Row | 1.69.6 expectation | v1.70.0 expectation |
|---|---|---|---|
| 1 | Gate opens → card renders | card from `permission` | card from `prompt_snapshot` on subscribe; legacy `permission` also on the wire and **ignored** |
| 2 | Tap an option | `POST /permission/answer` with `contentKey` + `gateId` | `POST /prompt/answer` with promptId, revision, `idempotencyKey`; exactly one PTY write either way |
| 3 | Revision bump | n/a | cursor-only repaint (`POST /api/sessions/:id/input {keys:"[B"}` — Down arrow — re-emits the gate with a new cursor, same `promptId`, `revision` stays) does **not** bump; a content change (answer, let the agent run, next tool call = a different gate) does; selection survives the repaint, card updates on the bump. Both frames recorded. |
| 4 | Terminal state | `permission_cancelled` clears the card | accept → ghost → `prompt_event` `resolved` clears it |
| 5 | Reconnect at card open / ghost pending / after resolve | correct state from replay | correct state from snapshot (terminal records present in the snapshot must **not** reopen a card) |
| 6 | Two clients: client B (the script) answers ~300 ms after the app's tap — `POST /permission/answer` with the same `gateId` / `POST /prompt/answer` | one provider response; loser's reply code read off the script, calm notice read off the UI | same, loser gets `already_resolved`; no duplicate PTY write |
| 7 | Multi-select AskUserQuestion | n/a | guidance, no rows, dismiss works, composer send disabled, Escape closes, **zero bytes written** (D10); the streamer's own answer route refused with `unsupported_prompt_shape` if it can be driven directly |
| 8 | Composer text while a prompt is open | `409 prompt_pending`, draft kept, no alert, view jumps to the card | same |
| 9 | Old-streamer control | **no `prompt_*` frame ever** on the tap; behaviour matches the Phase 1 baseline | n/a |

Per-row record: app commit, streamer version, session id, what was sent, frame (type, `promptId`/`gateId`, `revision`, `state`), what the card did, what the composer did, evidence file paths.

## 3. Controls
- **Positive control first**: row 1 on 1.69.6 (gate opens, answers once) runs before anything else and before any negative claim; row 9's "no `prompt_*` frame" is only asserted on a tap that has just been shown to carry `permission` frames on that same socket.
- **Negative control**: on v1.70.0 the legacy frame must be *visible on the tap and ignored by the app* — an absent legacy frame is a different (weaker) result and is recorded as such.
- **Falsifiability**: at least one row per version is re-run with the expectation deliberately inverted (e.g. answering with a stale revision, tapping after resolve) to prove the harness can produce a failing row at all.

## 4. Execution
One named sub-agent, `cross-version-verifier`, runs the rows: phase A = 1.69.6 (rows 1,2,4,5,6,8,9), phase B = v1.70.0 (rows 1–8). I review each row's evidence against the control it claims before accepting it.
- A failing row is **reproduced twice**, then filed as an issue in the owning repo in the canonical format (`P<N>: …`, `## Verified state` quoting the probe row). Never fixed in place; no source changes anywhere.
- A row that cannot be run is reported **not run**, with the reason.
- Stop-work triggers (session identity forks, content leaks into logs or unrelated clients, undocumented capability flags) pause the probe and come to you.

Output: `tracks/C-opus5-medium/PROBE-REPORT.md` — matrix with per-row evidence + one-paragraph verdict against the Phase 2 exit criteria ("new mobile/new streamer works; new mobile/old streamer degrades"; D13 reconnect-at-every-state and two-client race).

## 5. Known feasibility risks (candidates for "not run")
- **Row 6, client B**: the WS/HTTP script, not a second app instance (accepted; a second simulator is not required).
- **Row 7**: depends on the Claude CLI emitting a multi-select AskUserQuestion through the PTY detector; 3 attempts, then "not run" with the transcript.
(Row 3 is no longer a risk — the arrow-key input route drives the cursor-only repaint directly.)
- **Route-level evidence for row 2** if the streamer request log lacks method+path and the proxy is refused.
- iOS build + `pod install` time, and simulator availability (no device booted at plan time).

**Approve to dispatch phase A.**

---

## 6. Phase-B method notes and carry-list (added from phase A)

**Contract-frame detection.** Key on the top-level frame `type` (`prompt_snapshot` / `prompt_event`) and on top-level fields only. A bare `grep promptId` is **invalid**: `conversation_event.lines` relays the provider's own JSONL transcript verbatim and that transcript has its own `promptId` field — nine such hits appeared on a pre-contract wire in row 9. Every negative claim still needs a positive control run through the identical command on the identical file.

**Required sub-rows on v1.70.0**
- **2b** — `/prompt/answer` must reject an unknown or shifted option id with `400 unknown_option` and **zero bytes written** (artefact absence with a positive control, plus the provider transcript). This is what turns "opaque optionIds close the class" (streamer #709) into evidence.
- **3b** — capture every `prompt_event` in the 200 ms after the answering tap: is the teardown transient absorbed (no new promptId, or one cancelled before any client could render it), or does it mint a fresh promptId in state `open` that the app's reducer would accept? Record exact inter-frame timings, and whether a second client can aim an answer at it. Legacy tally, four sightings across four sessions: 13 / 29 / 4 / 0 ms after the winning answer. Also: does a resolved `prompt_event` withdraw the card the way `permission_cancelled` does, and does a late answer get `already_resolved` **distinctly from** `prompt_cancelled`? 1.69.6 collapses both into `gate_closed`.
- **8b baseline** — the legacy server guard measured directly (server-only `POST /input` against an open gate), so the contract path's refusal has something to compare against.

**Carry-list**
- Is the app's local send gate still engaged on the contract path, so `409 prompt_pending` stays unreachable from the UI? Same Maestro flow, same positive control. A version where it becomes reachable is a visible behaviour change for the same user action.
- `keys` bodies reach `sendKeys` **before** the open-prompt check (the #692 design — gate navigation needs it), so on the legacy route "a prompt is open" bars *text*, not writes. Re-verify on v1.70.0; escalate only if text can ride inside a `keys` body.
- Provocation-after-cancel: re-sending the same string into a just-cancelled turn continues the turn instead of re-gating. Use a fresh session or a differently-worded provocation.
- The v1.70.0 rig boots under a scratch `HOME` from its **first** boot (`THREADBASE_CONFIG_DIR` alone does not move `cacheDir`).
- Served-bundle provenance is re-verified against the v1.70.0 rig, not inherited from phase A.
- `streamer-169.log` has no coverage between 06:07:37Z and the ~11:21 restart; use before/after deltas, never whole-file totals, for anything counted across it.
- **Where replay is measured.** On 1.69.6, `ws.replay_permission` fires only on a `subscribe_session` from the **session screen**, never on relaunch alone — the session list does not subscribe, so a pending gate is correctly not pushed to a client that has not asked for that session (measured 68 / 68 / 68 / 71 across: before kill, app dead, after relaunch on the list, after navigating in). Phase B measures `prompt_snapshot` at those same four points; a before/after pair alone cannot tell the two subscribes apart.
