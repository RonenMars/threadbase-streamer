# Phase B close-out — streamer v1.70.0 (prompt contract)

Source material for `PROBE-REPORT.md`. Written by `cross-version-verifier`; the report is the orchestrator's.

> **Evidence paths in this file point at `evidence-scrubbed/`, not `evidence/`.**
> Both rig API keys appear in the originals — every tap file records its own argv including `--key`, and the streamer prints the key unmasked into its own log at boot (**#723**, §7.4). `evidence-scrubbed/` is a complete **112-file** mirror with every `tb_`/`pt_` token redacted. Cite it, not `evidence/`.
>
> **Durable location: `tracks/C-opus5-medium/evidence-scrubbed/`** — copied out of the scratchpad, which lives under `/private/tmp` and does not survive. The unscrubbed originals were copied nowhere and are expected to evaporate with the session. Verified at the destination: 0 rig keys, 0 `tb_`/`pt_` tokens of any kind, 112/112 files, against a control of 34 leaking files in the originals.

- **App under test:** threadbase-mobile `40ac02ace616b1a5e07b6350a1319b80eb32addc` (same build as phase A)
- **Streamer:** `@threadbase-sh/streamer@1.70.0`, reporting **`1.70.0+source`** live from `GET /api/info`, port **8770**
- **Device:** iPhone 17 Pro, **iOS 26.5**, UDID `6FE5C67C-F90B-4D4F-8287-2C49E4579F62`
- **Date:** 2026-08-28

---

## 1. Verdict table

| # | Row | Verdict | One-line basis |
|---|---|---|---|
| 1 | Gate opens → card renders | **PASS** | Card built from `prompt_snapshot`/`prompt_event`; legacy `permission` **present on the tap and ignored** — the strong control |
| 2 | Tap an option | **FAIL — #720** | `/prompt/answer` returns `409 prompt_cancelled` **while the write lands**. 3 calls, 3×409, **zero 200s** |
| 2b | Unknown / shifted `optionId` | **PASS** | Four malformed answers refused 400, zero bytes, gate non-destructively survives — the **#709 closure evidence** |
| 3 | Cursor-only repaint | **PASS (cursor half)** | Contract emits **1** event across 4 cursor moves; legacy emits **7**. No `cursor` field exists in the contract |
| 3 | Content-change bump | **BLOCKED — #720** | Needs the turn to advance past a successful answer |
| 3b | Teardown transient | **case (b), 5/5 — #724** | Fresh `promptId` in `state: open` minted after every answer; **one never terminated**. Split out of #720 into its own P1 |
| 4 | Terminal state / ghost → resolved | **BLOCKED — #720** | Needs a successful answer |
| 5(a) | Reconnect, card open | **PASS** | Restored from `prompt_snapshot` across a hard process kill; same `promptId`, `revision` unchanged |
| 5(c) | Reconnect after resolve | **BLOCKED — #720** | Needs a successful answer to reach a genuine resolved state |
| 6 | Two clients race | **BLOCKED — #720** | Needs a winner that actually wins |
| 7 | Multi-select fail-closed | **FAIL — #721 (+#720)** | Multi-select misclassified as single; answer **accepted 200 `resolved`**, bytes written, form still open. **D10 violated** |
| 8 | Composer text while prompt open | **PASS on intent, mechanism divergent** | App refuses client-side; `409 prompt_pending` unreachable from the UI — **unchanged from 1.69.6** |
| 8b | Server guard, direct POST | **PASS** | `409 prompt_pending`, `promptKind: "permission"`, zero bytes; body byte-identical to 1.69.6 |
| — | Same-key idempotency replay | **BLOCKED — #720** | Would replay a recorded **409**; see §4.5 |

**Phase-2 exit criterion — "new mobile / new streamer works" — is NOT met on 1.70.0.** The app is correct throughout; the contract server is not. Two independent server defects (#720, #721) break the primary path: a user who approves a command is told their approval did not take, and a form the client cannot answer is accepted as answered.

The other half of the criterion, *"new mobile / old streamer degrades"*, **was met** in phase A.

---

## 2. Rig

### 2.1 Isolation — scratch HOME from the **first** boot

`HOME=$SCRATCH/home-170`, `THREADBASE_CONFIG_DIR=$SCRATCH/cfg-170`, `--port 8770`, `--default-permission-mode acceptEdits`, `--no-pair-qr`, node pinned by absolute path. **`home-170` — including `.threadbase/cache`, the `.claude` profile and the seeded `.claude.json` — was built before the launcher ever ran**, so this rig never had phase A's two-boot window. `lsof` on the first and only PID:

```
<SCRATCH>/cfg-170/runtime.db{,-shm,-wal}
<SCRATCH>/home-170/.threadbase/cache/cache.db{,-shm,-wal}
<SCRATCH>/home-170/.config/threadbase-scanner/index.db{,-shm,-wal}
```
and `lsof … | grep -c "/Users/ronenmars/.threadbase"` → **0**.

Only one rig ran at a time: the 1.69.6 rig was stopped (port 8769 confirmed empty) before pairing. No session crossed between rigs.

### 2.2 Version pin — a two-minute near miss

`npm i @threadbase-sh/streamer@1.70.0` wrote **`^1.70.0`**, a caret range, not a pin. Timeline:

```
1.70.0 published   2026-08-27T07:04:34.679Z
this install       2026-08-28T08:59:31Z
1.70.1 published   2026-08-28T09:01:30.651Z   ← ~2 minutes later
```

Installing three minutes later would have resolved to **1.70.1** silently. The spec was hardened to an exact `"1.70.0"`; the on-disk artefact was not reinstalled and remains the one whose lockfile integrity is `sha512-TUscp1gJQsSrawa9Zt4yipOSJtOfvdQ7fEOLzlZ3e9fltd2Mfl4+tfVg/OL4yeKEhTil88VRgE5TERbnyxr8lg==`. Verified four ways: dependency spec, `node_modules` package.json, lockfile resolution, and live `/api/info`.

**Consequence for the report's conclusion:** this phase's verdict is a statement about **1.70.0**, not about what a user installing today receives.

### 2.3 The 1.70.1 delta — not on this rig

1.70.1 is #703 (PR #718, squash `81067096`). Its only wire change: the `/input` 409 `prompt_pending` body gains `promptState: "answered" | "open"`. No change to prompt frames, routes, ids or bytes.

Therefore **every row here holds for 1.70.1 by construction except 8b's body shape**, which is recorded as *not on this rig* (§3, row 8b).

**`promptState` was used as a per-row install tripwire** — greps **0** on every phase-B tap, against a positive control of a top-level `promptId` inside a `prompt_event` on the same file, and checked directly on 8b's response body (`'promptState' in body` → `False`). The rig is 1.70.0 on the wire, not merely by version string.

### 2.4 Carried unchanged from phase A

- **Isolated `.claude` profile**, byte-identical: `$SCRATCH/home-170/.claude/settings.json` sha256 **`6ec0209d91f9fa23de6ed92b5e6df8585e9a3a3e64816c3dad4fc1730aefbc88`**, empty `allow`/`deny`/`ask`, **no `defaultMode` key** — so `--permission-mode acceptEdits` is the only mode source. Every row ran under it. The user's own profile (114 Bash allow rules, `defaultMode: auto`) does not gate these commands at all; see PHASE-A-CLOSEOUT §2.2.
- **Provocation**, verbatim: `Run the shell command: curl -sS https://example.com -o ./probe-example.html`
- **Never** the "don't ask again" or "switch to auto mode" options — enforced by assertions in `answer.py` / `racer.py` / `answer170.py`, not by attention. `proj-170` holds no `settings.local.json` at close-out.
- Fresh session or differently-worded provocation after any cancel (the provocation-after-cancel property, PHASE-A-CLOSEOUT §8).
- **No Expo MCP** (unavailable to the session): `simctl` screenshots, `.expo/dev/logs/start.log`, Maestro 2.8.0. iOS 26.5 → no `hideKeyboard`.

### 2.5 Bundle provenance — re-verified against **this** rig, not inherited

Same three discriminators from 40ac02ac's own diff, same 27,424,807-byte entry bundle, both directions agreeing:

| discriminator | expected | observed |
|---|---|---|
| `prompt_snapshot` | > 0 | 5 |
| `unsupported_prompt_shape` | > 0 | 3 |
| `RawKeyBar` (deleted by 40ac02ac) | 0 | 0 |

### 2.6 Contract-frame detection discipline

Frames are classified by **top-level `type`**; prompt fields read from **top-level `prompt.*`** keys. A bare `grep promptId` is **invalid** — `conversation_event.lines` relays Claude Code's own transcript, which carries its own `promptId` (PHASE-A-CLOSEOUT §7.3). Every negative in this file has a positive control through the identical command on the identical file.

`streamer-170.log` is a **new file with no gap**, so whole-file counts are valid here (unlike phase A's log).

**How the counts in this file were taken — read this before re-running any grep.**
- Every number below is a **line count** (`grep -c PATTERN FILE`), not an occurrence count.
- This distinction is not cosmetic: a single streamer log line contains `input.prompt_pending` **twice** — once as `"event":"input.prompt_pending"` and once inside `"msg":"[input.prompt_pending] …"` — so `grep -c` returns **1** where `grep -o … | wc -l` returns **2**. An earlier draft of this file quoted the occurrence count for that control; it has been corrected to the line count throughout.
- **The TARGET zeros are unaffected by the choice** — zero lines and zero occurrences are the same claim — and the targets are what the rows actually assert. The CONTROLs only need to be non-zero.
- **CONTROL counts against the transcript and the streamer log were sampled at row time, in files that keep growing.** Re-running them later yields larger numbers (the row-5(a)/8/8b transcript control read 2 at row time and reads 3 lines / 4 occurrences after the row-8 positive control appended to it). That is expected; the assertion is *non-zero*, never a specific value. Counts against tap files and PTY screen captures are stable, because those files are closed when the row ends.

---

## 3. Row records

Common to every row: app `40ac02ac`, streamer version **re-read live per row** from `/api/info`, isolated profile per §2.4, `promptState` tripwire 0, content-free logging checked with a positive control on the same file. No stop-work trigger fired.

### Row 1 — snapshot on subscribe, legacy ignored. **PASS**

Session `a71c39bd-4466-41f2-aabc-c25016cc291b`.

**The negative control is the STRONG one — legacy frame present and ignored, not absent:**
```
09:06:06.835Z  prompt_event  sequence=1  promptId 84d65488-cd2d-4b62-aeea-af89e508a5e9  revision=1  state=open
09:06:06.836Z  permission                gateId   84d65488-cd2d-4b62-aeea-af89e508a5e9
```

**Card provenance proven by a field the other shape lacks** — the technique to reuse:
- legacy `permission` keys: `contentKey, cursor, detail, gateId, options, prompt, sessionId, type`. **No `title`**, and `'Approval' in json.dumps(frame)` → **False**.
- contract prompt: `title: "Approval"`, `intent: "approval"`, `message: "Do you want to proceed?"`.
- the rendered card is headed **APPROVAL** (`shots/B-row1-11-card.png`) — a header phase A's card, on the identical provocation, did not have.

The app cannot have obtained that header from the legacy frame. One card, no second card, no flicker.

**Snapshot on subscribe, both states:**

| subscribe | snapshot |
|---|---|
| no prompt open | `schemaVersion=1, sequence=0, **prompts=0**` |
| gate open (second socket, mid-gate) | `sequence=1, **prompts=1**` → `84d65488`, `state open`, `revision 1`, **no terminal records** |

Full prompt shape at that point: `title 'Approval'`, `answerRequirement 'unknown'`, `provenance {source:'screen', confidence:'inferred'}`, one question `inputMode 'single'` with four **opaque `optionId` UUIDs**.

### Row 2 — answer with ids, revision, idempotency key. **FAIL (#720)**

See §4.1. Summary: 3 calls, **3×409, zero 200s**, write lands every time.

### Row 2b — unknown / shifted `optionId`. **PASS** *(server-only)*

Session `a1642c22-0ab0-4baf-bc9f-cb4c5b09cf37`; live prompt `d67e62a0…`, `rev 1`, `open`.

| probe | response |
|---|---|
| unknown `optionId` (well-formed UUID, not in the prompt) | **400 `unknown_option`** |
| **shifted `optionId`** — a **real** id belonging to a *different, earlier* prompt (`06c45a55…`) | **400 `unknown_option`** |
| unknown `questionId` | **400 `unknown_question`** |
| empty `optionIds: []` | **400 `invalid_prompt_answer`** (schema layer) |

**This is the #709 closure evidence.** On the legacy route the equivalent mistake — a positional off-by-one — returned **200** and executed a *more permissive* answer. Opaque ids **remove the class rather than mitigate it**: the id space is unordered so there is no neighbouring value to land on, and membership is checked against that prompt's own option set (`new Set(question.options.map(o => o.optionId))`). Phase A could only reason about this; 2b measures it.

**Zero bytes — de-escaped table, every control non-zero:**

| check | expect | observed |
|---|---|---|
| **TARGET** artefact on disk | absent | **absent** |
| CONTROL `README.md` in same dir | present | present |
| **TARGET** `Bash` `tool_use` in transcript | 0 | **0** |
| CONTROL `probe-example.html` string in transcript | >0 | 2 |
| **TARGET** `Done—savedto` in de-escaped terminal | 0 | **0** |
| **TARGET** `Donesaved` (whitespace-tolerant) | 0 | **0** |
| CONTROL `Doyouwanttoproceed` in de-escaped terminal | >0 | 1 |
| CONTROL `example.com` in de-escaped terminal | >0 | 6 |

Terminal counts are occurrence counts over the **whitespace-stripped, de-escaped** screen (the TUI splits words with cursor moves, so a line count is meaningless there); transcript and artefact counts follow §2.6. The transcript CONTROL was sampled at row time in a growing file — see §2.6.

**Non-destructive, and this is the structural contrast with row 2** (both live in `performAnswer`): after four refusals the tap shows **exactly one** `prompt_event` — `seq 1, rev 1, open`. No cancel, no bump. Every refusal is rejected **before** `entry.adapter(...)`, so no byte can reach the PTY; row 2's *valid* answer fails **after** it. **Same function, opposite sides of the one call that writes** — a #720 fix must not move a check across that boundary in the wrong direction.

### Row 3 — cursor-only repaint. **PASS (cursor half)**; content half **BLOCKED**

Session `5a71157f-d937-4c09-a516-2e590283965e`; prompt `c06fab36…`, `rev 1`, `open`, cursor initially on option 1. Four cursor moves as raw keys (`{"keys":"[B"}` ×3, `{"keys":"[A"}` to restore), each `200`, cursor demonstrably moving on screen.

| | frames for the whole row |
|---|---|
| **contract** `prompt_event` | **1** |
| **legacy** `permission` | **7** — same `gateId`, `cursor` cycling 1 → 2 → … → 1 |

`promptId` unchanged, `revision` **1 throughout**, `state open` throughout.

**The structural reason is the finding, not the count.** The contract prompt has **no `cursor` field at all** (`'cursor' in prompt` → `False`); the legacy frame carries `cursor` first-class. A cursor-only repaint is **invisible to the contract by construction**, not filtered by a heuristic that could leak — a property, not a measurement.

Card unchanged across all four moves: APPROVAL header, four options in order, **none selected**, Cancel present.

**Method near-miss, recorded deliberately:** the first post-arrow screenshot appeared to show *no card*, which would have been a serious false finding. It was **below the fold**; scrolling showed it intact. **An unscrolled screenshot is not evidence of absence** — same class as the ANSI-grep false negative in phase A's 8b.

**Safety:** the arrows walked the terminal cursor onto "don't ask again". Enter was never pressed and the cursor was explicitly restored to option 1, verified on screen.

**Identity rule assembled on this build**, with its one gap named:
- new gate → **new `promptId`** (row 2: `06c45a55` cancelled, then `cde10c17` opened at `rev 1`)
- same gate changing state → **revision bump** (`rev 1 open → rev 2 cancelled`, row 2; `rev 1 open → rev 2 resolved`, row 7)
- same gate repainting its cursor → **nothing**
- same `promptId` with changed **content** → **unmeasured**; that is what the blocked half would have supplied.

### Row 3b — teardown transient. **Case (b), 5/5**

See §4.4. Summary: a fresh `promptId` in `state: open` is minted after every answer; four died in 19–74 ms, **one never terminated**. The app's reducer **accepted** it and rendered a card.

### Row 5(a) — reconnect with the card open. **PASS**

Session `97ff17e1-412f-43bf-9167-3ab9e9291349`; prompt `4746e5cb-a25e-4baf-b6c4-141ce23c55f1`, `rev 1`, `open`. Disconnect was a **hard process kill** (`simctl terminate`).

| subscribe | `prompt_snapshot` |
|---|---|
| before any prompt existed | `sequence 0`, **`prompts 0`** |
| **during the app's downtime**, independent socket | `sequence 1`, **`prompts 1`** → `4746e5cb`, `open`, `rev 1` |

The second is load-bearing: while the app was dead a *new* subscriber received the open prompt, so pending state is held by the server and handed to whoever subscribes — not replayed from a client cache, not dependent on the disconnecting client returning.

**Survived unchanged:** exactly **one** distinct `promptId` across both taps spanning the kill, `open`, `revision 1`. No new identity, no bump — reconnection is not itself a state change. (Contrast 3b: identity churn comes from *answer teardown*, not reconnection.)

**Card restored, provably from the contract:** APPROVAL header, four options in order, none selected, Cancel, `History · 1 message` (`shots/B-row5a-71-card-restored.png`). Dual emission still holds here — 4 `ws.replay_permission` events for this session alongside the contract snapshots, ignored by the app: row 1's strong control repeating across a reconnect.

**Cross-version observability improvement:** phase A proved the same outcome by *counting* `ws.replay_permission` (68/68/68/**71**). On 1.70.0 the evidence is the **snapshot content** — id, state, revision — which says *what* is pending rather than merely that something was replayed.

### Row 7 — multi-select fail-closed. **FAIL (#721, compounded by #720)**

See §4.2.

### Row 8 — composer text while a prompt is open. **PASS on intent, mechanism divergent**

Session `97ff17e1…`, reusing row 5(a)'s still-open prompt (no answer needed, so #720 does not touch this row).

- `/input` requests: **1 → 1**. `input.prompt_pending`: **0 → 0**. The app issued **nothing**; the server guard was never reached.
- **Draft kept** verbatim (`PROBE-B-ROW8-DRAFT-KEEP-ME`), **no alert**, APPROVAL card still pinned above the composer.

**Positive control — built differently here, because phase A's method is unavailable under #720.** Answering the gate to clear it is impossible, so the prompt was cleared with **Escape** (a `keys` write, not an answer), then the **identical point** tapped with the **same draft**: `POST /input → 200` at `09:52:37.362Z`, `ua: Threadbase/1 CFNetwork/…`, count **3 → 4**. Same button, same coordinates: sends with no prompt open, sends nothing with one. **This is what makes "no request" a finding rather than a suspected mis-tap.**

**Carry-list question answered: the app's local send gate is still engaged on the contract path.** `409 prompt_pending` remains unreachable from the UI on v1.70.0 exactly as on 1.69.6 — **no visible behaviour change for the same user action across versions.**

### Row 8b — server guard, direct POST. **PASS** *(server-only — not app behaviour)*

`POST /input {"input":"PROBE-B-ROW8B-SERVER-GUARD-TEXT"}` against the open prompt:
```
409 {"ok":false,"reason":"prompt_pending","promptKind":"permission",
     "error":"A prompt is waiting for an answer; answer or dismiss it before sending text"}
```
**Byte-identical to the 1.69.6 body.** `input.prompt_pending` logged with `sessionId` and `promptKind`, **not** the text.

**`promptState` absent**, checked on the response body itself — the 1.70.1 delta (#703/#718) is **not on this rig**, recorded rather than tested.

**Zero bytes — de-escaped table, every control non-zero:**

| check | expect | observed |
|---|---|---|
| **TARGET** marker in de-escaped PTY screen | 0 | **0** |
| **TARGET** marker, whitespace-tolerant | 0 | **0** |
| CONTROL `Doyouwanttoproceed` in same | 1+ | 1 |
| CONTROL `example.com` in same | 1+ | 6 |
| **TARGET** marker in provider transcript | 0 | **0** |
| CONTROL `probe-example.html` in transcript | 1+ | 2 |
| **TARGET** marker in streamer log | 0 | **0** |
| CONTROL `input.prompt_pending` in log | 1+ | **1** line |
| **TARGET** marker on the tap | 0 | **0** |
| CONTROL `prompt_snapshot` on the tap | 1+ | 1 |
| **TARGET** `Bash` `tool_use` in transcript | 0 | **0** |
| **TARGET** artefact on disk | absent | **absent** |
| CONTROL `README.md` present | present | present |

All line counts (`grep -c`) per §2.6. `input.prompt_pending` is **1 line / 2 occurrences** — the line carries the string in both its `event` and `msg` fields; the line count is quoted here so a reader re-running `grep -c` reproduces it.

---

## 4. The two defects

They are **two independent defects that compound**, not one with two symptoms. Each would remain wrong if the other were fixed, and the #720 fix will not touch the mapper.

### 4.1 #720 — outcome inference: the answer succeeds, the client is told it failed

`POST /prompt/answer` with a **fully valid** body returns **`409 {"ok":false,"code":"prompt_cancelled"}`** while the answer **has already been written to the PTY and executed**.

Every `/prompt/answer` call on this rig for the permission-gate case:
```
1. 09:10:45.597Z  409  Threadbase/1 CFNetwork/…   (app)
2. 09:13:05.846Z  409  Python-urllib/3.14         (script, full body visibility)
3. 09:16:04.821Z  409  Threadbase/1 CFNetwork/…   (app)
```
**Zero 200s on that route** for a permission gate. **The write landed every time:** 1 `Bash` `tool_use`, 1 `tool_result`, and `probe-example.html` written at `12:10:45`, `12:13:06`, `12:16:05` — matching each 409 to the second.

Reproduction 2's request, with nothing stale or malformed about it (`PromptAnswerSchema` would have returned 400 otherwise):
```
{"promptId":"06c45a55-2e88-4cea-a3e5-72fcce17c8b3","revision":1,
 "idempotencyKey":"fc23cdfc-0423-47d9-9d5c-c02a9b66d49f",
 "responses":[{"questionId":"b57c3f8a-ced4-4d9e-81ee-473d85df606e",
               "optionIds":["e7825ae8-9274-4069-b558-537236f63988"]}]}
→ 409 {"ok":false,"code":"prompt_cancelled"}
```

**Root cause, read from the source.** `PromptRegistry.performAnswer`:
1. state is `open`/`updated` — passes
2. expiry — passes (`expiresAt` is `null`)
3. `prompt.revision === answer.revision` — passes
4. `validateResponses` — passes
5. **`await entry.adapter({prompt, answer})`** ← *the call that writes to the PTY*
6. **re-checks** `entry.prompt.state` → terminal ⇒ `terminalError(state)` ⇒ 409

Step 5 answers the gate; the gate leaves the screen; the detector transitions the record to `cancelled`; step 6 reports failure **after its own write succeeded**. The check cannot distinguish *"it moved on because of my write"* from *"someone else closed it"*, and on a screen-scraped gate the former is the normal case — hence 3/3, not intermittent.

**User-visible, in one frame** (`shots/B-row2-20-after-409.png`): the conversation shows `Done — saved to ./probe-example.html · Crunched for 4s` and, below the composer, **"That question isn't open anymore."** The app is behaving correctly for what the server told it; the server told it the wrong thing. Four independent sightings of that notice across the phase.

40ac02ac does **not** retry on a closed-state code, so today this is a misleading notice rather than a double execution — but a client that reasonably treated 409 as retryable, minting a fresh key per attempt, would write again.

### 4.2 #721 — screen→contract mapping: a multi-select form reported as single-select

The provider rendered a genuine **two-question multi-select form** (gated on **attempt 1** of a budgeted three):
```
←  ☐ Languages   ☐ Environments   ✔ Submit  →
Which languages should be used?
❯ 1. [ ] Python          Use Python
  2. [ ] JavaScript      Use JavaScript
  3. [ ] Type something  Next
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```
Tabs, checkboxes, an explicit Submit, "Enter to **select**" not "confirm". The contract described it as:
```
questions = 1   inputMode = "single"   multiSelect = None   answerRequirement = "unknown"
```
The second question (`Environments`) is **absent from the payload entirely**. Checkbox glyphs leak into labels as literal text (`'[ ] Python'`).

**D10 is violated.** `POST /prompt/answer` did **not** refuse with `unsupported_prompt_shape`:
```
→ 200 {"ok":true,"prompt":{…,"revision":2,"state":"resolved","terminalReason":"answered"}}
```
Bytes were written (`bytes changed on screen: YES`) but the form is still there — `Submit` 1→1, `Entertoselect` 1→1, `Esctocancel` 1→1 — and the session is still `waiting_input`. A single keystroke toggled a checkbox without submitting, while the registry marked the prompt **answered**. Reproduced identically on a second session.

**The app is not at fault.** 40ac02ac fails closed on multi-question, multi-select and free-text shapes; it was handed `questions: 1, inputMode: "single", multiSelect: None` — precisely the shape it is built to answer, so it rendered four tappable radio rows. **The D10 sub-checks (dismiss works, composer send disabled, Escape closes) are NOT ASSESSABLE as fail-closed behaviours, because the card never entered that state** — reported not-assessed, not as app failures.

### 4.3 The cross-finding that identifies #720's trigger

Row 7 produced the **first `200`** `/prompt/answer` had ever returned on this rig, and that is not a coincidence:

- **permission gate** → vanishes when answered → detector cancels the record → post-adapter check sees terminal → **409 despite the write succeeding**
- **question menu** → stays on screen → check still sees `open` → **200 `resolved` despite the answer being incomplete**

**The outcome is decided by whether the prompt happens to vanish from the screen when answered, not by whether the answer actually took.** One heuristic yields a false negative on the commonest case and a false positive on the unsupported one.

### 4.4 #724 — teardown minting a prompt that outlives the answer

After the answering tap a fresh `promptId` in `state: open`, `revision 1` is minted — **case (b)**, 5/5:

| run | born after terminal | lifetime |
|---|---|---|
| row 2 (app) `ec57bfe5` | +6 ms | 74 ms |
| repro 1 (script) `cde10c17` | +3 ms | 23 ms |
| repro 2 (app) `847bf5e7` | +0 ms | 30 ms |
| 3b (app) `12f18e8c` | +1 ms | 19 ms |
| **row 7 (script) `9c2efaa6`** | **+13 ms** | **never terminated** |

3b's own window:
```
09:34:12.082Z  seq=2  59f19e7b  rev2  cancelled       ← the answering tap
09:34:12.083Z  seq=3  12f18e8c  rev1  open     +0ms   ← FRESH promptId
09:34:12.102Z  seq=4  12f18e8c  rev2  cancelled  +18ms
```

**The durable case.** Row 7's `9c2efaa6` was still `open` on a fresh subscribe **~12 minutes later** (`prompt_snapshot sequence=3, prompts=1, rev 1, open, terminalReason=None`), with the session still `waiting_input`. It is **durable state, not a race**: any client subscribing receives an `open` prompt that exists only as an artefact of answer teardown.

**Direct observation: the app's reducer ACCEPTED it and rendered a card** (`shots/B-3b-63-durable-prompt-card.png`) — heading "Which languages should be used?", four radio rows, Cancel; server confirming `9c2efaa6 rev 1 open` at the same moment.

**Severity, calibrated.** The card shown is not itself misleading — the menu genuinely is still open and still needs answering. **The defect is identity and bookkeeping, not this pixel: one on-screen question is now two registry records, one `resolved/answered` that was not answered and one `open` that nobody asked, and the `resolved` record is the one any "did the user approve this?" audit would consult.**

**Why row 7 is the outlier:** the four short-lived cases were permission gates, which vanish when answered so the detector cancels the minted prompt almost at once; row 7's question menu **stayed on screen**, so the minted prompt kept matching a live screen and was never cancelled. The same screen-presence heuristic behind #720 decides this too — which is why 3b began as a **third consequence of #720**. It has since been **split out into its own #724 (P1)**; it shares #720's root cause but is separately fixable and separately testable, and #724 also carries the `provider_closed` discriminator (§7.5).

**Row 7's durable phantom sits at the intersection of #720 and #721:** the mapper defect left an answerable-looking menu on screen for a prompt that should never have been answerable, and the outcome-inference defect minted the replacement identity and then never cancelled it.

**What is settled and what is not.** The reducer's acceptance of a fresh `open` `promptId` is **proven** by every row where a new gate renders a card, and a teardown-minted prompt is indistinguishable from a real one at the reducer — same `type`, same `state`, same `revision`, an unseen `promptId`. So **the app is protected from the short-lived cases only by their brevity, not by suppression, and in the durable case it is not protected at all.** Whether a 19 ms frame actually paints is **unsettled** — my sampling floor is ~250 ms and the app logs no `promptId`s — and this file says unsettled, not "no flash".

**Fix ownership (ruled):** the fix is the **server's** — a teardown re-detection of the prompt just answered must not mint a new `open` record, and a post-answer snapshot must hold **zero** teardown-minted open prompts. **The mobile client keeps `promptId` keying.** The observation below is an explanation of *why the exposure differs between versions*; it is **not** a recommendation to reintroduce content keying, which would recreate the #871 class.

### 4.5 Why the same-key idempotency replay check was not run

Answers are keyed by `promptId` + `idempotencyKey` with recorded outcomes replayed for a window — real server-side machinery. But under #720 every permission-gate answer records a **409**, so sending the identical answer twice with one key would replay a recorded *failure*. That produces a green-looking result meaning the opposite of what the check intends, so it was **not run** and is listed BLOCKED. It becomes runnable the moment #720 is fixed.

---

## 5. The cross-version regression (the phase's headline)

**On identical detector behaviour, the contract path is *structurally more exposed* to teardown transients than the legacy path it replaces.**

| | legacy (1.69.6) | contract (1.70.0) |
|---|---|---|
| teardown mints a fresh identity | yes — new `gateId` | yes — new `promptId` |
| sightings | 4 — **13 / 29 / 4 / 0 ms** | 5 — **19 / 74 / 23 / 30 ms + one never terminated** |
| client keys its card on | **gate content** | **`promptId`** |
| result | content identical ⇒ **no rebuild, no flicker** | id new by construction ⇒ **accepted as a new prompt** |

The legacy client rode the transient because content keying made the new identity invisible to it. The contract client cannot: a new `promptId` is, correctly and by design, a different prompt. This is a genuine regression claim about the migration itself — and it is exactly what a cross-version probe exists to surface.

Again: this explains the difference in exposure. **It is not an argument for reverting to content keying** (#871). The fix belongs on the server, which should not mint the record at all.

---

## 6. Design confirmed on a live wire (not discovered)

All shipped design, verified rather than assumed — *"a design nobody verified on a live wire is a claim; now it is a measurement."*

1. **`gateId` ≡ `promptId`** — #700's occurrence-identity design: one id per gate instance across both shapes. Observed byte-identical in rows 1, 3, 5(a). Makes cross-shape audit tractable and means a client straddling both routes cannot be caught by mismatched ids.
2. **The snapshot is unconditional** — subscribing to a quiet session yields `prompts: 0`, so *"nothing pending"* is an **assertion on the wire** rather than an inference from silence. This is the thing 1.69.6 could not say.
3. **Opaque `optionId` UUIDs** — the structural answer to #709, measured in 2b (§3).
4. **`provenance: {source: "screen", confidence: "inferred"}`** and **`answerRequirement: "unknown"`** — the contract's stated tri-state mapping for scraped gates, being honest that a screen-scraped gate is inferred rather than structurally reported. This is the field that lets a client tell the two apart.
5. **`promptContract: {schemaVersion: 1, atomicAnswer: true}`** on `GET /api/info` — a clean capability discriminator; phase A's rig has no such object, so it identifies a contract rig without reading the version string.

---

## 7. Findings not tied to a single row

### 7.1 #720 — outcome inference (§4.1, §4.3)
### 7.2 #721 — screen→contract mapping (§4.2)
### 7.3 #724 — teardown-minted prompt outliving the answer (§4.4, §5)
### 7.3a Cross-version teardown exposure (§5) — the evidence behind #724's severity

### 7.4 #723 — the streamer logs its own API key unmasked at boot

Filed as **#723 (P2, security)**. From the **scrubbed** copy, so this file carries no secret:
```
component     : cli
apiKeyMasked  : 'tb_c99…'                          ← deliberately masked
msg           : 'API key: tb_<REDACTED-RIG-KEY>'   ← the same secret, unmasked, on the same line
```
Both fields are on **one log line**: something takes the trouble to mask the key into `apiKeyMasked` while the adjacent `msg` prints it in full.

**Not new in 1.70.0 and not contract-related:** `grep -c '"msg":"API key: tb_'` returns **1** in `streamer-170.log` and **9** in `streamer-169.log` — once per boot, on both versions.

**Why it is more than hygiene:** that key is the server's authentication boundary, and the streamer log is precisely the artefact attached to bug reports — as this track was about to do, with logs already being copied into GitHub issues. The 30-file scrub exists because of this line as much as because of tap argv.

### 7.5 `provider_closed` — the discriminator the registry already has

Captured in the **final snapshot**, after the rows were complete, and now cited in **#724**.

The prompt cleared with Escape during row 8's positive control reached:
```
4746e5cb-…   revision 2   state cancelled   terminalReason: "provider_closed"
```

That completes the observed terminal-reason vocabulary on this build, and the three values discriminate the paths cleanly:

| how the prompt ended | state | `terminalReason` |
|---|---|---|
| Escape / provider-side dismissal | `cancelled` | **`provider_closed`** |
| an answer to a **permission gate** | `cancelled` | *(none — #720's false negative)* |
| an answer to a **question menu** | `resolved` | `answered` *(#721's false positive)* |

**Why this matters to the fix rather than merely to the record:** the registry can *already* distinguish "the provider closed this" from "this was answered". The distinction exists and is populated on the Escape path. It is simply **not consulted** on the path #720 breaks, where the outcome is inferred from screen presence instead. A fix has a discriminator available to it without inventing one.

---

## 8. Method notes worth carrying

- **Prove provenance by a field the other shape lacks** (row 1's `title`/APPROVAL), not by timing or by absence.
- **An unscrolled screenshot is not evidence of absence** (row 3's near-miss) — same class as a grep that cannot match through ANSI escapes (phase A's 8b).
- **Every zero-bytes claim gets the full de-escaped table** with controls returning non-zero; ANSI stripped *before* the search.
- **Don't run a check whose green result would mean the opposite** (§4.5).
- **Choose the instrument the phenomenon permits**: the 19 ms transients are below any screenshot floor, so the durable case answered 3b's question instead.
- **When a sampling method cannot settle a question, say unsettled** rather than reporting the negative.
- **Positive controls must be rebuilt when a defect removes the usual one** — row 8's control used Escape because answering was impossible.
- `promptState` as a **per-row version tripwire**, checked on the wire and on a response body, beats trusting the version string.

---

## 9. Evidence index

All paths under `$SCRATCH = /private/tmp/claude-501/-Users-ronenmars-dev-ai-tools-ai-investigation-claude/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad`.

**Cite `evidence-scrubbed/` — a complete 105-file mirror of `evidence/` with every `tb_`/`pt_` token redacted.** Verified: 0 files in the mirror contain either rig key, no `tb_`/`pt_` token of any kind remains, against a control of 33 leaking files in the originals; file counts match 105/105.

| file | contents |
|---|---|
| `evidence-scrubbed/B-row1-tapA.jsonl` | row 1 — subscribe-before, gate open, dual emission |
| `evidence-scrubbed/B-row1-tapB.jsonl` | row 1 — subscribe-during (snapshot with the open prompt) |
| `evidence-scrubbed/B-row2-tap.jsonl`, `B-repro1-tap.jsonl`, `B-repro2-tap.jsonl` | #720, three reproductions (repro 1 has full request/response) |
| `evidence-scrubbed/B-row2b-tap.jsonl` | 2b refusals |
| `evidence-scrubbed/B-row3-tap.jsonl` | row 3 — 1 contract event vs 7 legacy frames |
| `evidence-scrubbed/B-row3b-tap.jsonl` | 3b — the 200 ms window with inter-frame deltas |
| `evidence-scrubbed/B-row7-tap.jsonl`, `B-row7b-tap.jsonl` | #721, two reproductions |
| `evidence-scrubbed/B-row7-recheck.jsonl`, `B-row7-recheck2.jsonl` | the durable phantom, still `open` |
| `evidence-scrubbed/B-row5a-tap.jsonl`, `B-row5a-midkill.jsonl` | row 5(a), incl. the snapshot served during downtime |
| `evidence-scrubbed/B-row8-tap.jsonl` | rows 8 / 8b |
| `evidence-scrubbed/streamer-170.log` | rig log, continuous, **no gap** — cited by both issues |
| `evidence/screens/*.json` | raw PTY captures for the before/after screen diffs |
| `evidence/shots/B-*.png` | screenshots, named by row |
| `$SCRATCH/answer170.py` | contract answerer — selects by **label**, refuses profile-mutating options |
| `$SCRATCH/tap.mjs`, `answer.py`, `racer.py` | phase-A harness, reused |

**Sessions:** row 1 `a71c39bd`, #720 repros `f0c39f54` / `dc7a8510`, 2b `a1642c22`, row 3 `5a71157f`, 3b `abb506c5`, #721 `082ad71c` / `b2d2e29d`, rows 5(a)/8/8b `97ff17e1`.

---

## 10. Appendix — phase C, as fixed by the owner

> **Phase C has since executed.** Its result is recorded in **`PHASE-C-CLOSEOUT.md`**, not here. This section is the *plan* as agreed beforehand and is retained for provenance — do not read it as the outcome. Headline: **#720 verified fixed on v1.70.2**; #721 and #724 are not in that release and both still reproduce, as expected.

Forward-looking; recorded here so nothing is decided under time pressure when the trigger fires. Everything above this section is a record of what happened, this section is not.

**Trigger:** #720 **releasing** — a release tag from the owner. Not a merge, not an approved diff, not a branch build. Do not start without it.

### 10.1 Order, and why

1. **Row 3's content-change half** and **the same-key idempotency replay.**
   These are the two cells that actually exercise the fix. Neither has *ever* had a successful answer to work with on any build measured: row 3's content bump needs the turn to advance past an answer, and the replay check needs a recorded **success** to replay rather than the recorded 409 that #720 produces (§4.5). If the fix is wrong, these fail first and most informatively.
2. **Rows 4, 5(c), 6** — regression coverage. Each needs a successful answer but tests behaviour already understood: terminal state, post-resolve snapshot, and the two-client race.
3. **Live re-provocation of the row-7 phantom** — see §10.2, which is the one with a counter-intuitive expectation.

### 10.2 The phantom row is **expected-still-present**, not a regression

**#724 and #721 are not in the #720 release.** The teardown-minted prompt (§4.4) and the multi-select misclassification (§4.2) are therefore expected to **still reproduce**.

Record that row as **expected-still-present**, in those words, and state the reason inline. A reader must not mistake a known-unfixed defect for the fix having failed — that misreading is easy to make and expensive to unmake.

**The surprise case is the phantom *not* reproducing.** If it does not, that goes to the orchestrator before anything else is run: it would mean either the release contains more than #720, or the phantom's trigger is more fragile than five sightings suggested.

### 10.3 The version tripwire must be re-derived — `promptState` is dead as a discriminator

`promptState` was the 1.70.0 tripwire because it lands in **1.70.1**, so its *absence* proved the rig was 1.70.0. **On any build past 1.70.0 it will be present**, so its presence proves nothing and reusing it blindly would be a tripwire that cannot fire.

**Derive a replacement at rig-up, before the first row**, by this method rather than by guessing a field now:

1. Install the released version under an **exact pin** and record the four-way check used in §2.2 — dependency spec, `node_modules` package.json, lockfile resolution + integrity hash, and live `GET /api/info`.
2. Diff the new dist against the **preserved 1.70.0 baseline**, which is durable and identified by hash — not by location:

   | | |
   |---|---|
   | path | `tracks/C-opus5-medium/evidence-scrubbed/build-1.70.0/cli.cjs` |
   | size | 7,729,493 bytes |
   | **sha256** | **`06d6e2e4f226f9d8537060e99ef18b6a1295035daab1c31c09375e6b8953a0ad`** |

   **Check the hash before diffing.** It is what makes a future comparison provably against the build *this phase measured*, rather than against whatever happens to be lying in a scratchpad — and the scratchpad copy will be gone. Independently verified: byte-identical to `$SCRATCH/str-170/…/dist/cli.cjs`, `promptState` count **0** (confirming it is 1.70.0 and not 1.70.1), `prompt_snapshot` present, and no key token of any kind in it.

   Diff for **strings that exist in exactly one of the two**. Prefer a field or reason-code the *fix itself* introduces.
3. Require it to be **wire-observable** — visible on a tap frame or an HTTP response body — not merely present in the bundle, so it can be checked per row the way `promptState` was.
4. **It must not be the fix's own success condition.** "`/prompt/answer` returns 200 on a permission gate" identifies the build but is exactly what row 2 is measuring; using it as the tripwire makes the check circular. Pick something adjacent.
5. Record both directions per row: the new marker **present**, and 1.70.0's absence-marker where one still applies.

If no such discriminator exists in the release, say so and fall back to the version string plus the lockfile integrity hash, **stating explicitly that the wire could not confirm the build** — that is a weaker claim and the report should carry it as one.

### 10.4 Method carried unchanged (non-negotiable)

- **Exact pin, never a range.** §2.2 records why: 1.70.1 published ~2 minutes after the 1.70.0 install, and `^1.70.0` would have taken it silently.
- **Live version string per row**, re-read from `/api/info`, never quoted from a checkpoint.
- **Served-bundle provenance re-verified against the new rig** by the present-and-absent discriminators (§2.5) — not inherited from phase A or B.
- **Isolated `.claude` profile**, sha256 `6ec0209d…aefbc88`, scratch `HOME` built **before** the first boot.
- **Never** the "don't ask again" / "switch to auto mode" options — enforced by harness assertions.
- **Fresh session or a differently-worded provocation after any cancel** (PHASE-A-CLOSEOUT §8).
- **Every zero-bytes claim** gets the full de-escaped table with non-zero controls; ANSI stripped before searching.
- **Counts are line counts** and controls are asserted non-zero, never as values (§2.6).
- **Scrub before hand-off**; cite `evidence-scrubbed/`.

### 10.5 A check the fix gets for free

Row 8's positive control had to be built with **Escape** in phase B, because answering a gate to clear it was impossible under #720 (§3, row 8). Once #720 is fixed, that control can **return to the phase-A method** — answer the gate, then send.

Being able to build it the original way is itself a small, independent confirmation that the fix works, obtained without spending a row on it. If it still cannot be built that way, #720 is not fixed regardless of what row 2 reports.
