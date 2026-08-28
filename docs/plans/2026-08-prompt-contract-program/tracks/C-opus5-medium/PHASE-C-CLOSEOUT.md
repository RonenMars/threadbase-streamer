# Phase C close-out — streamer v1.70.2 (#720 fix verification)

Source material for `PROBE-REPORT.md`. Written by `cross-version-verifier`; the report is the orchestrator's.

> **Evidence paths point at `evidence-scrubbed/`, not `evidence/`.** Three rig API keys appear in the originals — every tap records its own argv including `--key`, and the streamer prints its key unmasked at boot (**#723**). The mirror is complete and verified: **0** files contain any rig key, against a control of **46** leaking originals.
> **Durable location: `tracks/C-opus5-medium/evidence-scrubbed/` — 134 files**, including both build baselines (`build-1.70.0/`, `build-1.70.2/`). The scratchpad lives under `/private/tmp` and does not survive.

- **App:** threadbase-mobile `40ac02ace616b1a5e07b6350a1319b80eb32addc` — unchanged across all three phases
- **Streamer:** `@threadbase-sh/streamer@1.70.2` (#726 / PR #726, squash `4b8957d6`), reporting **`1.70.2+source`**, port **8772**
- **Device:** iPhone 17 Pro, iOS 26.5, UDID `6FE5C67C-F90B-4D4F-8287-2C49E4579F62`
- **Date:** 2026-08-28

---

## 1. Verdict

| cell | Row | Verdict |
|---|---|---|
| 1 | **Row 2** — answer with ids, revision, idempotency key | **PASS** — the fix's positive control |
| 2a | **Same-`idempotencyKey` replay** | **PASS** — unrunnable in phase B |
| 2b | **Row 3** content-change half | **PASS on intent**, mechanism is a new identity |
| 3 | **Row 4** — accept → resolved clears the card | **PASS** |
| 4 | **Row 5(c)** — reconnect after resolve | **PASS** |
| 5 | **Row 6** — two clients race | **PASS**, loser gets the **distinct** code |
| 6 | **Phantom re-provocation** | **EXPECTED-STILL-PRESENT** — not a regression |
| 7 | **Row 7a** — single-select *question* on the contract path | **PASS** — mapped honestly, one write, no durable phantom |
| — | §10.5 free check (row 8 control, phase-A method) | **PASS** |

**#720 is fixed.** Every phase-B cell blocked on it now runs and passes. **#721 and #724 are not in this release and both still reproduce, as expected.**

**Sentence of record** — approved verbatim; the report carries identical wording:

> On 1.70.2 the contract path holds for single-select permission gates **and** single-select questions — mapped honestly, answered once, resolved cleanly, card cleared, with no durable phantom. The residual #724 exposure on a correctly-classified question menu is a 60-second actionable window, not durable state; durable phantoms occur only on the #721 shape.

**`/prompt/answer` across the whole rig: 11 calls — 9 × 200, 2 × 409.** Both 409s are *intended* refusals from row 6's losing client (`already_resolved`, and `prompt_cancelled` in the discarded first run). Compare phase B: **3 calls, 3 × 409, zero 200s.**

---

## 2. Rig

### 2.1 Isolation — scratch HOME before the first boot
`HOME=$SCRATCH/home-172`, `THREADBASE_CONFIG_DIR=$SCRATCH/cfg-172`, port 8772, `--default-permission-mode acceptEdits`. `home-172` (its `.threadbase/cache`, `.claude` profile and seeded `.claude.json`) was built **before** the launcher ran. `lsof`: every SQLite handle under `cfg-172`/`home-172`, **0** under `/Users/ronenmars/.threadbase`. Only one rig up at a time — 8769 and 8770 confirmed down.

Profile sha256 **`6ec0209d…aefbc88`**, identical across all three phases; empty `allow`/`deny`/`ask`, **no `defaultMode` key**. `proj-172` holds no `settings.local.json` at close-out.

### 2.2 The pin — done the way §10.4 required
The exact spec was written into `package.json` **before** `npm install`, rather than via `npm i pkg@ver` which authors a caret:

```json
"dependencies": { "@threadbase-sh/streamer": "1.70.2" }
```

Verified four ways: spec after install `1.70.2` (still exact), installed `1.70.2`, lockfile `1.70.2` with integrity `sha512-fwbTnHaOdQQiaGTxbX+MY8mbU+R43uJUsvNJVGSwYoTZYDkMV1IGILMANspnVGt7+2mRihElw4lZr3HL8TUPCw==`, and live `/api/info` → `1.70.2+source`.

**v1.70.3 released mid-phase** (#725, a Codex resume fix, unrelated). The rig did **not** drift — `npm view` reports `latest` as 1.70.3 while the rig stayed 1.70.2, which is the exact spec doing its job. This is the second time in the track that a release landed inside our working window; the first cost two minutes (PHASE-B §2.2).

### 2.3 The version tripwire — three layers, and a correction

**Primary: exact artefact identity.** Four builds, four distinct dist hashes:

| version | dist sha256 | bytes |
|---|---|---|
| 1.70.0 | `06d6e2e4f226f9d8537060e99ef18b6a1295035daab1c31c09375e6b8953a0ad` | 7,729,493 |
| 1.70.1 | `868c24864eb9f4295624317833de55ef9c18f321ecf42d5f03a6010b2522654d` | 7,729,992 |
| **1.70.2 (this rig)** | **`a494a53ca2e8610583351e081c1262647c1ec8291e92cc4ef0e4a3cb56543188`** | **7,732,760** |
| 1.70.3 | `94ec757b877cb3519ff46bf97e82ba359cc384d68b35fa3ef9bfff6db7a36f17` | 7,732,661 |

Checked per row. It is an **identity, not a bound**, costs one `shasum`, and cannot be defeated by a later release that keeps the same strings.

**Secondary: two marker layers, kept for what they actually prove.**

| marker | 1.70.0 | 1.70.1 | 1.70.2 | 1.70.3 | observable |
|---|---|---|---|---|---|
| `promptState` | 0 | 5 | 5 | 5 | **wire** (`/input` 409 body) |
| `providerClosed(` | 0 | 0 | **3** | 3 | dist |
| `whileAnswering(` | 0 | 0 | **2** | 2 | dist |
| `deferredClose` | 0 | 0 | **4** | 4 | dist |

- `promptState` — the cheap per-row wire check that the rig is **not a phase-B build**.
- the `providerClosed(`/`whileAnswering(`/`deferredClose` triple — names **which fix** is present rather than which version number is claimed. *A version string is a claim; a fix marker is evidence.*

**Correction, volunteered.** My cell-1/cell-2 report described these two layers as *the* tripwire. They only bound 1.70.2 **from below** — a silent move to 1.70.3 would have passed both, since #726's markers persist in every later build. It did not happen (the four-way check at rig-up and live `/api/info` per row both read 1.70.2 throughout), but the tripwire was weaker than I described it, and the hash above is the primary check for that reason.

**Sequencing, stated plainly per §10.3 step 5:** the **build layer was established before cell 1**; the **wire layer was not** — cell 1's attempt returned 200 because no prompt was open, and it was confirmed at the start of cell 2. Cell 1 therefore rests on the version string, the lockfile integrity and the #726-exclusive dist markers, but **not** on a wire observation taken before it ran. Stronger than §10.3's fallback; not a wire layer, and not described as one.

### 2.4 Bundle provenance — re-verified against this rig, twice
Same three discriminators, same 27,424,807-byte entry bundle, both at rig-up and again after the mid-phase restart: `prompt_snapshot` **5**, `unsupported_prompt_shape` **3**, `RawKeyBar` **0**.

### 2.5 Log gap
`streamer-172.log` is one appended file with **no coverage between `11:09:14.202Z` and the restart at ~`13:2x`** (session-limit outage; rig and Metro died, simulator survived). Counts spanning it are before/after deltas — phase-A discipline. Rows completed before the outage are reported **from the files on disk**, not re-run.

**Artefact checks were sampled at row time, and `proj-172` is empty of them now.** `probe-example.html` / `probe-org.html` were deleted between rows as hygiene, so a later `ls` finds nothing. That absence is **row hygiene, not a contradiction of "artefact once"** — each row's count was taken while that row was live. Same class as the growing-file control caveat in PHASE-B §2.6.

---

## 3. Cell records

Common: version re-read live per row, dist hash checked, `promptState` present on the wire, isolated profile, content-free logging verified with a positive control (`example.com` **0** against **536** `http.request` lines on `streamer-172.log`).

### Cell 1 — Row 2, the fix's positive control. **PASS**

Session `971c87b2-1237-48c4-b0b4-51f918044404`, answered by an **app tap**.

- `POST /prompt/answer` → **200** at `10:41:27.569Z`, `ua: Threadbase/1 CFNetwork/…`
- **Prompt state:**
  ```
  10:40:49.833Z  seq 1  8e6e1817  rev 1  open
  10:41:27.574Z  LEGACY permission_cancelled
  10:41:27.574Z  seq 2  8e6e1817  rev 2  resolved  terminalReason=answered
  ```
  Checked programmatically for `8e6e1817`: **resolved 1, cancelled 0** — legacy `permission_cancelled` preceding exactly one `resolved` prompt_event, with no `cancelled` prompt_event for the answered prompt.
- **Exactly one write:** transcript 1 `tool_use` / 0 `tool_result` → **1 / 1**; artefact once, 559 bytes, mtime one second after the 200.
- **The phase-B symptom is gone:** `shots/C-row2-10-after-answer.png` shows the card cleared and `Done — downloaded to ./probe-example.html`, with **no "That question isn't open anymore." notice** — the contradiction that appeared four times in phase B.

### Cell 2a — same-`idempotencyKey` replay. **PASS**

Session `88417ed3-f0a9-43e7-8b92-bd17003c9861`. One key `56fd130c-…`, identical body, sent twice:

| call | status | ms | body |
|---|---|---|---|
| 1 | **200** | 3 | `state=resolved rev=2 terminalReason=answered` |
| 2 | **200** | 1 | identical |

Response bodies **byte-identical** (compared as sorted JSON). The `3 ms → 1 ms` drop is consistent with a replayed recorded outcome doing no adapter work.

**Zero additional bytes:** **1** `Bash` `tool_use` / **1** `tool_result` for **two** answer calls; artefact once, one mtime, `find` returns one path.

**This cell was unrunnable in phase B** — it would have replayed a recorded 409 (PHASE-B §4.5). It is the most direct demonstration that the idempotency machinery works as designed.

*Evidence caveat, mine:* `C-replay-tap.jsonl` captured only the opening frames — I backgrounded that tap inside a shell that exited. `C-replay-recheck.jsonl` is a deliberate re-subscribe and is the authoritative end state; the two 200s and the provider side are in the log and transcript regardless.

### Cell 2b — Row 3 content-change half. **PASS on intent; mechanism differs**

Session `c73fe00a-5f27-45ab-a23b-22ca678a84da`, a deliberately two-step task:
```
seq 1  9ae32406  rev 1  open       | example.com
seq 2  9ae32406  rev 2  resolved   | example.com   ← answered
seq 3  ad873cea  rev 1  open       | example.com   ← #724 transient
seq 4  ad873cea  rev 2  cancelled  | example.com     provider_closed
seq 5  11d83bdc  rev 1  open       | example.org   ← the genuine content change
```
The second, genuinely different gate arrives as a **new `promptId` at `rev 1`** — **not** a revision bump. The card followed it (`shots/C-row3-20-second-gate.png`).

**A correction to the plan's own wording, and both halves must be said so nobody reads the row as fudged to pass.** Across every phase-B and phase-C tap the observed `(revision, state)` pairs are only `(1, open)` ×28, `(2, cancelled)` ×16, `(2, resolved)` ×5, `(2, unavailable)` ×2 — **maximum revision ever observed is 2**. So on this build **`revision` is a state-transition counter, not a content counter**: 1 while open, 2 on reaching a terminal state; a content change is expressed as a **new `promptId`**, never as a bump.

The row's expectation ("a content change *does* bump") described the **intent** — the card must follow content changes and must not follow cursor moves — and the build satisfies that intent by a different mechanism. The intent holds; the stated mechanism does not.

### Cell 3 — Row 4, accept → resolved clears the card. **PASS**

Session `9133be23-677c-405d-803c-93ecff5f9dff`, app tap.
```
13:31:56.519Z  seq 1  62659674  rev 1  open
13:36:01.061Z  LEGACY permission_cancelled
13:36:01.063Z  seq 2  62659674  rev 2  resolved  answered        +2ms
13:36:01.107Z  seq 3  ba3e8e73  rev 1  open                      +44ms   ← #724
13:36:01.462Z  seq 4  ba3e8e73  rev 2  cancelled provider_closed +353ms
```
Card cleared on `resolved` (`shots/C-row4-31-after-resolve.png`), no notice. One write: 1 `tool_use` / 1 `tool_result`, artefact once.

**There is no "ghost" state on the wire.** The prompt goes `open → resolved` with nothing between; `entry.answering` is internal to the registry and emits no frame. The row's "accept → ghost → resolved" describes a **client-side optimistic** state, not a server one — anything a client renders during the round-trip is its own invention. Legitimate, but the contract does not announce it, and a future row should not expect a frame for it.

### Cell 4 — Row 5(c), reconnect after resolve. **PASS**

Same session, by then holding **two terminal records and nothing actionable**:
```
snapshot sequence 4  prompts 2
  62659674  rev 2  resolved   answered
  ba3e8e73  rev 2  cancelled  provider_closed
ACTIONABLE prompts: 0
```
**Hard process kill** (`simctl terminate`) → relaunch → navigate into the session. **No card rendered** (`shots/C-row5c-40-after-reconnect.png`), resolved history only. Terminal records in a snapshot do not reopen a card — tested on its own terms rather than leaning on cell 2a's re-subscribe.

### Cell 5 — Row 6, two clients race. **PASS, with the distinct code**

Session `d7e96fd0-27ec-45ec-96eb-76b4cf6a8707`. Client B armed **before** the tap with the target `promptId` **frozen**, firing a **fresh `idempotencyKey`** — a genuine second answer, not a replay.

| | request | response |
|---|---|---|
| **App (winner)** | `13:45:11.963Z`, `ua: Threadbase/1 CFNetwork/…` | **200** |
| **Client B (loser)** | `13:45:12.356Z`, same `promptId b5a25027`, measured **+301 ms** | **409 `{"ok":false,"code":"already_resolved"}`** |

**One provider response:** 1 `Bash` `tool_use`, 1 `tool_result`, artefact exactly once.

**Reason strings are client-sourced.** The streamer does not log 409 reason strings — `already_resolved` and `prompt_cancelled` come from the **response bodies observed client-side**, exactly as `gate_closed` did in phase A (PHASE-A §3, row 5(c)). Good evidence; not server-log evidence, and the report should not blur the two.

**This is the separation 1.69.6 could not express.** Phase A collapsed every losing case into `gate_closed` (PHASE-A §3, row 6). Here both sides exist on the same rig:

| loser answered… | code |
|---|---|
| the prompt that **was answered** | **`already_resolved`** |
| a prompt that **vanished** | **`prompt_cancelled`** |

**Methodological correction, mine.** My first run produced `prompt_cancelled` and I nearly reported it as the loser's code. It was wrong: the racer took "the latest open prompt", so by firing time it had retargeted onto the **#724 teardown transient** (`b5dda12d`) rather than the prompt the app answered (`d6985091`). I froze the target at arm time and re-ran. The discarded run is not waste — it is the contrast row above, and a live demonstration that **#724 can misdirect a second client's answer onto a phantom**.

### Cell 6 — phantom re-provocation. **EXPECTED-STILL-PRESENT**

Session `be48a341-dc86-4e41-bf07-5eeeba3d8c0f`. Provocation gated on **attempt 1**.

**#721 unchanged.** The provider rendered the two-question multi-select form (de-escaped screen: `Submit` ×1, `☐` tabs ×2, unchecked `[]` ×3) and the contract still reported `questions 1, inputMode "single", multiSelect None, answerRequirement "unknown"`. The answer was still **accepted 200 `resolved/answered`** rather than refused with `unsupported_prompt_shape`.

**#724 unchanged — the durable phantom reproduces:**
```
seq 1  8ae656f1  rev 1  open
seq 2  8ae656f1  rev 2  resolved  answered
seq 3  7bb25031  rev 1  open                ← minted at teardown, NOT cancelled

fresh subscribe → snapshot sequence 3, prompts 2
   8ae656f1  rev 2  resolved  answered
   7bb25031  rev 1  open      None          ← ACTIONABLE count: 1
```

**Recorded as expected-still-present, never as a regression** — #721 and #724 are not in the 1.70.2 release. The surprise case (the phantom *failing* to reproduce) did not occur.

**Narrowing worth carrying to #724's acceptance criterion.** On 1.70.2 the **permission-gate** transients now self-cancel with `provider_closed` within ~350 ms (cells 3 and 5) rather than lingering. It is specifically the **question-menu** case — where the menu stays on screen, i.e. the #721 shape — that still yields a durable one. So #724's remaining exposure is **narrower than in phase B and entangled with #721**, exactly as the intersection note in PHASE-B §4.4 predicted. The stated criterion — a post-answer snapshot holding zero teardown-minted open prompts — is still not met, but only on the #721 shape.

### Cell 7 — Row 7a, single-select **question** on the contract path. **PASS**

Session `7a1ca716-24e4-48ae-b393-04666b83968b`. Added because no phase had ever answered a genuine single-select *question* on the contract path — phase B's row 7 went straight to multi-select by design, and the phantom re-provocation reused the same #721 shape, so every question-menu answer on 1.70.2 until now was a **wrongly-accepted** multi-select.

**The shape is mapped honestly — the direct contrast with #721.**

| | screen (de-escaped) | contract |
|---|---|---|
| tabs | `☐ Choice` — **one** | `questions: 1` |
| Submit affordance | **absent** | — |
| option labels | `Option A` / `Option B` / `Type something.` / `Chat about this`, **no `[ ]` glyphs** | identical set, no glyphs |
| navigation | `Enter to select · ↑/↓ to navigate · Esc to cancel` | `inputMode: "single"`, `multiSelect: None`, `allowOther: false` |

Compare #721, where the *same* field values (`questions 1`, `inputMode "single"`, `multiSelect None`) described a form carrying `☐ Languages ☐ Environments ✔ Submit` and whose labels read `'[ ] Python'`. **So `inputMode: "single"` is not inherently untrustworthy** — it is correct when the shape is single-select. #721 is a mapping failure on a specific shape, not a blanket one.

**Answered by tap** (`^Option A$`) from the card:
- `POST /prompt/answer` → **200** at `13:55:17.752Z`, `ua: Threadbase/1 CFNetwork/…`
- `seq 1 16d9a6a9 rev 1 open` → `seq 2 … rev 2 resolved terminalReason=answered`
- **one write:** exactly **1** `tool_use` in the transcript — `AskUserQuestion` `toolu_01W4TAsFKWuLMv4jBU11DzgX`
- provider recorded it: `User answered Claude's questions: · Which would you like? → Option A`, then `You selected Option A.` (`shots/C-row7a-51-after-answer.png`); card cleared, no notice

**No durable phantom.** The teardown-minted `ad571d16` (born +321 ms) reached `cancelled / provider_closed` at `13:56:18.076Z`, and a fresh subscribe afterwards shows **ACTIONABLE count 0**. It self-cancelled: that session was never stopped (0 stop requests; still `attached` afterwards).

No refusal was involved, so no zero-bytes table applies to this cell.

### §10.5 free check — row 8's control, the phase-A way. **PASS**

```
STEP 1  answer the gate       -> 200  state=resolved  terminalReason=answered
STEP 2  send after answering  -> 200  {"ok":true}
```
Step 1 was **impossible** in phase B. Per §10.5 this is an independent confirmation that #720 is fixed, obtained without spending a row — and its contrapositive would have overridden a green cell 1.

---

## 4. What changed between 1.70.0 and 1.70.2

Read from the dist diff against the hash-verified baseline. #726 adds two registry methods and two fields:

- **`providerClosed(promptId, reason)`** — the provider's prompt left the screen. Distinct from `transition` because *the detector cannot tell a teardown it observed on its own from one our own write caused*. While an answer is writing, the close is **deferred** and the answer decides.
- **`whileAnswering(promptId, write)`** — runs a provider write that may close the prompt as a side effect, so the close it causes is deferred rather than applied. Used by the legacy permission route; `performAnswer` manages the same two fields directly.
- fields **`entry.answering`** and **`entry.deferredClose`**.

The shipped comment states the principle the phase-B findings implied: *"Success is the adapter's own result, never the prompt's absence from the screen."* Only the provider-close path defers — `replaced`, `unavailable` and `expired` still go through `transition` and still win, because none of them was caused by our write.

**This is the correct fix for the defect as characterised in PHASE-B §4.1/§4.3.** It repairs the outcome inference; it does not touch the mapper (#721), which is why cell 6 still reproduces.

---

## 5. Findings

### 5.1 #720 — fixed, verified
9 × 200 and 0 unintended 409s across 11 calls, against phase B's 3-for-3 failure; one write per answer everywhere; the misleading notice gone.

### 5.2 #721 — unchanged, still reproduces (cell 6)

### 5.3 #724 — unchanged; scope now precisely bounded. See §5a.

### 5.4 The contract's distinct loser codes — earned
`already_resolved` vs `prompt_cancelled`, both observed on the same rig (cell 5). This is the separation 1.69.6 collapsed into one string, and it is now measured rather than promised.

### 5.5 `revision` is a state counter, not a content counter
Max revision ever observed across all three phases: **2**. See cell 2b.

### 5.6 No wire-level "ghost" state
`open → resolved` with nothing between (cell 3).

---

## 5a. Transient lifetime by prompt shape — the three tiers

The single most useful structural result of phase C, and the thing that bounds #724's scope.

| shape | born after resolve | transient lifetime | exposure |
|---|---|---|---|
| **permission gate** (cells 1, 3, 5) | +1 – +44 ms | **0.0 – 0.4 s** | negligible |
| **single-select question menu** (cell 7) | +321 ms | **60.0 s**, self-cancelled | a 60-second actionable window |
| **misclassified multi-select form** (#721, cell 6) | +15 ms | **durable** — see **§6a** | actionable in the snapshot indefinitely |

**#724's residual is the misclassified-form case, not "the question-menu case."** A correctly-classified question menu settles itself; the durable exposure lives behind #721. That reframes #724's fix scope: its acceptance criterion — a post-answer snapshot holding zero teardown-minted open prompts — is still unmet, but the shape that violates it durably is the #721 shape.

**Both halves of the 60-second tier must be said.** It is **not durable state** — the record self-cancels with `provider_closed` and a later subscriber sees `ACTIONABLE count 0`. It is also **not nothing**: a client subscribing inside that minute receives an actionable phantom, which is precisely the exposure 3b identified in phase B. A lesser and separately-describable problem, not an absent one.

**A caution for anyone re-running the table that produced it.** Its generating heuristic pattern-matches *"a terminal state followed by a new open prompt"* — and a **genuine next gate** satisfies that too. Cell 2b's `11d83bdc` was reported by the heuristic as a transient "STILL OPEN"; it is in fact the second gate of the two-step task, an ordinary prompt that had simply not been answered yet. Chase every outlier before trusting a derived row.

---

## 6. Method notes added in this phase

Carrying forward from PHASE-A §8 and PHASE-B §8:

- **A candidate discriminator must be checked against *every* build in the comparison, not only the one it came from.** `resumeIdForRow` looked like a 1.70.3 marker in the diff; it is present **5 times in all four builds** — the diff had moved lines that use it. Checking all four is what caught it; checking only 1.70.3 would have produced a tripwire that fires on everything.
- **Prefer an identity to a bound.** Markers bound a build from one side; a dist hash identifies it. Four builds, four hashes, one `shasum` per row.
- **A version string is a claim; a fix marker is evidence.** Keep both, and say which one a given row rests on.
- **Freeze a race target before the race.** Taking "the latest open prompt" at fire time made client B answer a teardown phantom and produced the wrong reason code — a green-looking result about the wrong object.
- **A discarded run can be the contrast case.** The mis-targeted row-6 run supplied `prompt_cancelled` and made the `already_resolved` result meaningful by contrast; it is reported, not deleted.
- **Rebuild a positive control when a defect removed the usual one, and re-test the original once the defect is fixed** — that re-test is itself free evidence (§10.5).
- **A derived table is a hypothesis until its outliers are chased.** An automated lifetime table produced two wrong readings at once — a phantom that looked self-cancelling but was killed by my own session stop 2 ms earlier, and a genuine next gate misread as a transient. Both were caught by asking *why* a number looked the way it did, not by re-running the script, which would have reproduced them. Full account in **§6a**.
- **A number already sent is not thereby settled.** The wrong lifetime had been reported before it was caught; the correction is owed the moment it is found, not weighed against the awkwardness of having reported it.
- **Cover the honest case as well as the broken one.** Every question-menu answer on 1.70.2 was a wrongly-accepted multi-select until row 7a; without it the verdict would have generalised from the defective shape alone.

---

## 6a. Incident — the probe nearly credited the release with a fix it did not make

This is not a footnote adjusting a number. It is a near-miss in which the probe would have handed v1.70.2 credit it had not earned, and the correction was made **after** the wrong figure had already been reported.

**What happened.** I generated a table of teardown-transient lifetimes across every phase-C tap by script. It reported the #721 phantom `7bb25031` as `lifetime 354.6 s` — a finite lifetime, which reads as *the server settled it on its own*. I had already sent that number to the orchestrator. On the strength of it, the natural conclusion was that 1.70.2 had quietly improved the durable phantom of phase B, and that #724's worst case had softened from "durable" to "clears in about six minutes".

**Why it was wrong.** The phantom's cancel is logged at `13:52:49.900Z`. My own `POST /api/sessions/be48a341…/stop` for that session is logged at `13:52:49.902Z` — **two milliseconds later**. The prompt did not settle itself; **I killed the session it lived in**, during setup for row 7a, and the registry cancelled it as a consequence. The phantom had been open for roughly six minutes at that point and was **still open when I ended it**. Its true lifetime is not 354.6 s; it is *unbounded, and I truncated the measurement*.

**What it would have cost.** Phase B's finding is that the #721 shape mints a prompt that outlives the answer indefinitely and is served actionable to any new subscriber. Had the 354.6 s line stood, the report would have said 1.70.2 partially fixed that — a release credit for behaviour nobody changed, resting on an artefact of my own teardown. Anyone later testing #724's fix would have measured against a false baseline.

**How it was caught.** Not by re-running the script, which would have reproduced the same number. By asking why one row of a derived table disagreed with every other row, and then checking what else happened at that timestamp. The two-millisecond gap is what gave it away.

**The rule this produces**, now in §6: *a derived table is a hypothesis until its outliers are chased.* And its corollary, which is the harder half: **a number already sent is not thereby settled** — the correction is owed as soon as it is found, not weighed against the awkwardness of having reported it.

---

## 7. Evidence index

Cite `evidence-scrubbed/` — **134 files**, 0 rig keys (control: 46 leaking originals).

| file | contents |
|---|---|
| `evidence-scrubbed/C-row2-tap.jsonl` | cell 1 — the fix's positive control |
| `evidence-scrubbed/C-replay-tap.jsonl`, `C-replay-recheck.jsonl` | cell 2a — replay; recheck is the authoritative end state |
| `evidence-scrubbed/C-row3-tap.jsonl` | cell 2b — content change → new promptId |
| `evidence-scrubbed/C-row4-tap.jsonl` | cell 3 |
| `evidence-scrubbed/C-row5c-pre.jsonl` | cell 4 — snapshot with 2 terminal records, 0 actionable |
| `evidence-scrubbed/C-row6-tap.jsonl`, `C-row6b-tap.jsonl` | cell 5 — discarded contrast run, then the correct run |
| `evidence-scrubbed/C-row6-clientB.jsonl` | client B's own record, incl. frozen target and measured +301 ms |
| `evidence-scrubbed/C-phantom-tap.jsonl`, `C-phantom-recheck.jsonl` | cell 6 — the durable phantom |
| `evidence-scrubbed/C-row7a-tap.jsonl`, `C-row7a-recheck.jsonl` | cell 7 — single-select question, and its self-cancelled transient |
| `evidence/screens/row7a-pre.json`, `row7a-post.json` | cell 7 — the screen before and after |
| `evidence-scrubbed/C-tripwire-tap.jsonl` | wire tripwire + §10.5 free check |
| `evidence-scrubbed/streamer-172.log` | rig log, one file, **gap `11:09:14Z` → ~`13:2x`** |
| `evidence-scrubbed/build-1.70.0/cli.cjs` | baseline, sha256 `06d6e2e4…53a0ad` |
| `evidence-scrubbed/build-1.70.2/cli.cjs` | this rig, sha256 `a494a53c…56543188` |
| `evidence/shots/C-*.png` | screenshots by cell |
| `$SCRATCH/racer172.py` | contract racer — freezes the target at arm time, refuses profile-mutating options |
| `$SCRATCH/answer170.py` | contract answerer — selects by label |

**Sessions:** cell 7 `7a1ca716`, cell 1 `971c87b2`, 2a `88417ed3`, 2b `c73fe00a`, 3+4 `9133be23`, 5 `d7e96fd0` (and discarded `b5ce08b7`), 6 `be48a341`, tripwire/§10.5 `C-tripwire-session`.

---

## 8. Appendix — phase D, as fixed by the owner

> **This section is a plan, not a result.** Nothing in it has been executed. Everything above it is a record of what happened; this is what happens next, recorded now so it cannot drift from the evidence it depends on and nobody reconstructs it from message history. When it executes, its result goes in `PHASE-D-CLOSEOUT.md` and this section gets a pointer, exactly as PHASE-B §10 did.

**Standing verdict at the time of writing.** Phase 2 is **signed off for the single-select paths against v1.70.2**. Sign-off for **multi-select and unknown shapes is held until #721 ships**. Group E does not fire on the partial verdict.

### 8.1 Trigger

The **#721 release tag**, sent by the orchestrator. A **release**, not a merge, not an approved diff, not a branch build. Do not start without it.

### 8.2 Scope

**Row 7 proper — the fail-closed sub-checks that were never assessable.** In phase B these were reported *not-assessable* rather than failed, because the card never entered the fail-closed state: the mapper misreported a two-question multi-select as `questions: 1, inputMode: "single"`, so the app rendered exactly what it had been told to render (PHASE-B §4.2). With the mapper fixed, each becomes testable for the first time:

- the card shows **guidance with no selectable rows**
- **dismiss** works
- **composer send is disabled**
- **Escape** closes it
- **zero bytes**, with the full de-escaped table and every control returning non-zero

**#724 durable-case re-check on the same build.** Two distinct questions, and they are not the same question:

1. Does the **misclassified-form phantom** go away with #721 — i.e. was the durable case purely a consequence of the mapper accepting a form it should have refused?
2. If a form is now **refused**, does anything mint a durable `open` prompt at all — or does the teardown path still produce one on some other shape?

**Then the final verdict line**, replacing the partial sign-off.

### 8.3 Carried expectation — measure it, do not assume it

Phase C bounded #724's residual to three tiers (§5a): **0.0–0.4 s** on permission gates, **60 s** on a well-formed question menu, **durable only behind #721**. So a #721 fix **may** resolve the durable case as a side effect.

**That is a hypothesis, not a prediction to be confirmed.** The 60-second tier exists independently of #721 and has no reason to change; if it persists after #721 ships, #724 remains open on its own terms with a smaller blast radius. Measure both tiers on the new build and report them separately.

### 8.4 Method — unchanged and non-negotiable

- **Exact pin, never a range.** Write the spec into `package.json` **before** `npm install`; `npm i pkg@ver` authors a caret. Two releases landed inside our working window during this track (PHASE-B §2.2, PHASE-C §2.2).
- **Per-row live version *and* dist-hash identity, hash primary.** Diff the new dist against the preserved **`evidence-scrubbed/build-1.70.2/cli.cjs`**, sha256 `a494a53ca2e8610583351e081c1262647c1ec8291e92cc4ef0e4a3cb56543188` — **check that hash before diffing**, so the comparison is provably against the build this phase measured. Derive the new discriminator by PHASE-B §10.3, and check every candidate against **every** build in the comparison (§6).
- **Scratch HOME built before the first boot**; own config dir, own project; `lsof` showing zero handles under the real home.
- **Served-bundle provenance re-verified against the new rig**, never inherited.
- **Isolated `.claude` profile**, sha256 `6ec0209d…aefbc88`, empty allow/deny/ask, no `defaultMode` key.
- **Never** the "don't ask again" / "switch to auto mode" options — enforced by harness assertions, not attention.
- **Fresh session or a differently-worded provocation after any cancel.**
- **Artefact and control counts are sampled at row time and said to be** (§2.5); controls asserted non-zero, never as values; line counts stated as such.
- **Scrub before hand-off; cite `evidence-scrubbed/` only.** Every tap writes the rig key into its own argv, and the streamer prints its key unmasked at boot (**#723**).

### 8.5 Apparatus held ready

Rig, app, simulator, Metro, harness and scrubber are held as-is. Reusable without rebuilding: `tap.mjs`, `answer170.py`, `racer172.py` (target frozen at arm time — see §3 cell 5 for why), the Maestro flows in `$SCRATCH/flows/`, the scrubber, and both preserved build baselines. The scratchpad lives under `/private/tmp` and does not survive indefinitely; everything durable is already in `evidence-scrubbed/`.

**The live apparatus was lost once after phase C completed** — background-task cleanup terminated the rig and Metro — and was **restored and re-verified**: rig `1.70.2+source` on 8772, dist sha256 `a494a53ca2e8610583351e081c1262647c1ec8291e92cc4ef0e4a3cb56543188`, **0** handles under `/Users/ronenmars/.threadbase`, pairing intact (1 device), Metro serving on 8081, simulator still booted. Consequently `streamer-172.log` carries a **second shutdown marker and a second gap** (~`17:05` → ~`17:09`) which **no measurement spans** — every phase-C row predates it, which is why §2.5 documents only the first gap.

**Nothing durable was ever at risk, and that is the guarantee this section exists to give.** The close-outs, the 140-file `evidence-scrubbed/` tree and both hash-verified build baselines live in the workspace and never depended on a live process; every rebuild input survived (launchers, `str-172` still pinned to exact `1.70.2`, the isolated profile still `6ec0209d…aefbc88`, 5/5 harness scripts, 22 flows). **A phase D that finds the apparatus down costs a rebuild, not a reconstruction.** Verify it is real before trusting it: `/api/info` for the version, `shasum` for the dist identity, `lsof` for isolation.


---

> **Phase D has since executed.** Streamer **1.70.4** (dist sha256 `3f23c274e26ab5c21e91d9c0325ece16c16a6a3e2cf3fefb2f9e7cd93cc52ec7`) was measured against the scope in §8.2 above. Outcome: **#721 is fixed to its scope and stays closed** — the multi-select and glyph halves are reliably repaired. The residual multi-question defect proved to be a **separate, order-dependent two-producer bug**, filed as **threadbase-streamer #730 (P2)**: a screen scraper is permitted to overwrite the authoritative transcript-sourced prompt, and `provenance.confidence` is already on the wire as the discriminator it fails to act on.
>
> §8.3's carried expectation is **superseded rather than confirmed**. The tiers are explained by **producer, not by parse**: a transcript-sourced prompt expires at **60 s** (four observations, 59.949–60.010 s, including the single-select menu §8.3 asked for), while a screen-sourced prompt lives exactly as long as its form stays on screen (4 s to 310 s; `af409c8c` durable at 290.5 s with one write in its life, at the end of it). The phase-D probe's first version of this claim — "degraded parses are durable, no exceptions" — **was wrong and is withdrawn**; see PHASE-D §6a withdrawal 3.
>
> Full record: **`PHASE-D-CLOSEOUT.md`**.
