# Phase D close-out — streamer v1.70.4 (#721 fix verification)

**Build under test:** `1.70.4+source`, port 8774.
**Dist identity:** sha256 `3f23c274e26ab5c21e91d9c0325ece16c16a6a3e2cf3fefb2f9e7cd93cc52ec7` — checked per row as the primary version tripwire, per PHASE-C §8.4.
**App under test:** threadbase-mobile `40ac02ace616b1a5e07b6350a1319b80eb32addc` — unchanged across phases A–D.
**Isolated profile:** `~/.claude/settings.json` sha256 `6ec0209d91f9fa23de6ed92b5e6df8585e9a3a3e64816c3dad4fc1730aefbc88`, verified again at the end of the phase.

---

## 1. Verdict

**#721 is fixed to its scope and stays closed.** The residual nondeterminism is a **separate, newly-understood defect**, filed as **threadbase-streamer #730 (P2)**.

> **There are two producers of prompt payloads, not one flaky scraper.** A **transcript**-sourced prompt (`provenance: {source: "transcript", confidence: "authoritative"}`) carries the correct 2-question payload; a **screen**-sourced one (`source: "screen"`, `confidence: "inferred"`) carries a degraded 1-question scrape of the visible tab, with two TUI affordances mistaken for options. Which one a client ends up with is **order-dependent**: whichever producer lands last wins, and **the screen scraper is permitted to overwrite the authoritative transcript prompt**. Because a prompt's payload is never revised in place, the parse that wins is then **frozen for that promptId's entire life**.

Owner's trace: `handleLiveQuestion` replaces a prior prompt without checking whether it is the transcript-sourced one, while `handleJsonlQuestion` upgrades in place when content keys match.

**The fix needs no schema change.** `provenance.confidence` is already on the wire and is exactly the discriminator the server (or a client) could act on. That is the **second time in this track** the contract has carried the distinction it fails to act on — `provider_closed` was the first, in phase C. Worth stating as a pattern rather than twice as a coincidence.

**The app fails closed** on the degraded shape, which is why this is not user-facing data loss today: it renders guidance rather than a wrong form, refuses to answer, and writes no answer bytes.

**#724's residual is explained by producer, not by parse** (§3.2): a transcript-sourced prompt expires at 60 s; a screen-sourced one lives exactly as long as its form stays on screen.

**No regression** on the single-select paths signed off in phase C (§3.3).

## 2. Rig

### 2.1 The pin
Exact spec written into `package.json` **before** `npm install`, never `npm i pkg@ver` (which authors a caret — the phase-B near-miss). Verified four ways; lockfile integrity matched the owner's `sha512-xlLrXbas6b5EGtBkgaBU0R4E3HWt6se8nOCLkq1CdX36vlK159be3+/s2d7CbldkEBs+b6PWD0nvrjkPHpbQUA==` exactly.

### 2.2 Version tripwire — hash primary
`3f23c274…` diffed against the preserved `evidence-scrubbed/build-1.70.2/cli.cjs` (`a494a53c…`, hash checked before diffing). Five builds now have five distinct hashes.

**1.70.4-exclusive markers** (0 occurrences in 1.70.0/.1/.2/.3): `stripStateMarker`, `KNOWN_STATE_MARKER_RE`, `multiSelect: sawStateMarker`. These are the fix.

**One candidate rejected:** `PERMISSION_LABEL_RE` looked like a new marker in the diff and is present **3× in all five builds**. Caught by the PHASE-C §6 rule — *a candidate discriminator must be checked against every build in the comparison* — which has now earned its place twice.

### 2.3 Isolation
Scratch `HOME` built before the first boot; own config dir, own project. **0** handles under `/Users/ronenmars/.threadbase`. One rig at a time — ports 8769/8770/8772 confirmed down. Served-bundle provenance re-verified against this rig, not inherited: 27,424,807-byte entry bundle, `prompt_snapshot` ×5, `unsupported_prompt_shape` ×3, `RawKeyBar` ×0.

---

## 3. Cell records

### 3.1 Row 7 proper — the multi-select form. **PASS on every fail-closed sub-check and on D10**

**Mapping**, against a tool call whose ground truth is always 2 questions (`Topics`: Frontend/Backend; `Tools`: CLI tools/GUI tools):

| | phase B (1.70.0/1.70.2) | 1.70.4 | screen |
|---|---|---|---|
| `inputMode` | `"single"` ✗ | **`"multi"` ✓** | checkboxes + Submit |
| option labels | `'[ ] Python'` ✗ | **`'Frontend'` ✓** | glyph is screen furniture |
| `questions` | `1` ✗ | **producer-dependent** — `2` from the transcript producer, `1` from the screen scraper (**#730**) | two tabs |

**Fail-closed sub-checks:**

- **Card shows guidance, no tappable rows** — `shots/D-row7-10-card.png`: heading *"Which topics are you interested in?"*, amber guidance *"This prompt needs an answer this app can't send yet — answer it in the terminal."*, **zero** option rows, Cancel present.
- **Composer send disabled** — typed a draft and tapped send: `/input` requests 1 → 1, `input.prompt_pending` 0. No request issued. The block is a **server** guard, not merely client-side: `/input` answers `409 prompt_pending` to any caller.
- **Dismiss works** — the card's Cancel closes the form.
- **Escape closes it** — **NOT VERIFIED.** See §6a withdrawal 2.
- **Direct `POST /prompt/answer` refused** — a **well-formed** answer (correct promptId, revision, questionId, real optionId) → `400 {"ok":false,"code":"unsupported_prompt_shape"}`. Phase B accepted the identical request with `200 resolved`. The refusal was **non-destructive**: the prompt stayed `open` at rev 1.

**Zero bytes — de-escaped table, controls non-zero:**

| check | expect | observed |
|---|---|---|
| TARGET checked marker (`[x]`/`[✔]`) on screen | 0 | **0** |
| TARGET `Youselected` on screen | 0 | **0** |
| TARGET `tool_result` blocks after the refusal | 0 | **0** |
| CONTROL `[]Frontend` still unchecked | >0 | 1 |
| CONTROL `Submit` still on screen | >0 | 1 |
| CONTROL `Entertoselect` still on screen | >0 | 1 |
| CONTROL `AskUserQuestion` in transcript | >0 | 3 |

Decisive confirmation nothing was answered: the transcript's lone `tool_result` reads *"The user doesn't want to proceed with this tool use. The tool use was rejected"* — a rejection, no option recorded.

**Content-free logging clean:** `Frontend` greps **0** in `streamer-174.log`, against **50** `http.request` control lines.

**The Cancel writes to the PTY — and that is correct.** `POST /input → 200` from `Threadbase/1 CFNetwork` at `14:35:59.516Z`, prompt `cancelled/provider_closed` 95 ms later. This is the documented raw-key path (`keys` body, #692 design — §5.3), **not a hole**. D10's claim is that no *answer* is synthesized, and that holds absolutely; dismiss **cancels** rather than answers, and it is the same mechanism as the required "Escape closes it" sub-check. **"Zero bytes" is true of the answer path, not of the card as a whole.**

### 3.2 Cell 2 — #724's residual, recorded **by producer**

`source` is the real variable, so every observation is tagged by it rather than by "degraded/correct".

**Measurement quality is separated first.** Five prompts are excluded outright: my tap died mid-phase (§6), so their open or terminal frame is known only from a later snapshot and their lifetime is **not measurable**. Reporting them would have inflated the sample with numbers I cannot stand behind — `c3676582`'s "281 s" and `a2822e91`'s "89.9 s" in the superseded table were both artefacts of that gap.

**Cleanly measured** — open *and* terminal both observed as live `prompt_event` frames (n=14):

| source | n | outcome |
|---|---|---|
| **screen** | 7 | **7/7 ended when the form left the screen** — 6 within **95 ms** of a PTY write, 1 by a contract answer. **None self-terminated on a timer.** Lifetimes **1.2 s – 309.9 s**. |
| **transcript** | 7 | **4/4 that were neither answered nor overwritten expired at 60 s** — 60.001 / 60.002 / 60.010 / 59.949 s. Plus 2 ended `replaced` at 5.89 s, and 1 `answered` at 1.047 s. |

**Every cleanly-measured observation, individually** — nothing aggregated away:

| id | source | lifetime | terminal reason | what ended it |
|---|---|---|---|---|
| `06244f4c` | screen | 1.164 s | `answered` | my contract answer (row 2 control) |
| `06a2830a` | screen | **4.096 s** | `provider_closed` | PTY write −0.072 s |
| `b541ac73` | screen | **10.285 s** | `provider_closed` | PTY write −0.071 s |
| `fd93b64a` | screen | **10.461 s** | `provider_closed` | PTY write −0.073 s |
| `cc7a33de` | screen | **10.762 s** | `provider_closed` | PTY write −0.072 s |
| `af409c8c` | screen | **290.495 s** | `provider_closed` | PTY write −0.093 s (the only write in its life) |
| `0c1126d1` | screen | **309.852 s** | `provider_closed` | the app's Cancel, −0.095 s |
| `d0bc40f8` | transcript | 1.047 s | `answered` | my contract answer (row 7a control) |
| `791fe7d8` | transcript | 5.892 s | `replaced` | overwritten by screen prompt `06a2830a` |
| `b58a428a` | transcript | 5.894 s | `replaced` | overwritten by screen prompt `4d55c505` |
| `d81897db` | transcript | **59.949 s** | `provider_closed` | **self-terminated** — no write during its life |
| `e300ad9d` | transcript | **60.001 s** | `provider_closed` | **self-terminated** |
| `414d7850` | transcript | **60.002 s** | `provider_closed` | **self-terminated** (an ESC 1.418 s earlier is coincidental — see below) |
| `222f5923` | transcript | **60.010 s** | `provider_closed` | **self-terminated** — no write during its life |

**The four short-lived screen prompts — 4.1 s, 10.3 s, 10.5 s, 10.8 s — are the ones the superseded claim omitted.** Each ended within **73 ms** of a PTY write I issued myself. They are not counter-examples to the rule below; they are instances of it.

**The rule, stated as measured:**

> **A screen-sourced prompt's lifetime is its form's lifetime on screen; a transcript-sourced prompt expires at 60 s.**

This explains 4 s, 10 s and 310 s with one mechanism, and it makes the durable case a **consequence of the form staying up** rather than of the parse being wrong. It replaces the superseded claim that "degraded parses are durable" — see §6a withdrawal 3.

- **The 60 s tier**, on a single-select menu as PHASE-C §8.3 requires: `222f5923`, **60.010 s**, self-terminated with no write during its life. Four observations, tight to the millisecond.
  *One caution:* `414d7850` ended at 60.002 s with an unrelated ESC 1.418 s earlier. The write is **coincidental**, not causal — it landed at the tier to the millisecond.
- **The durable case**, clean: `af409c8c`, screen-sourced, **290.5 s**, with **exactly one** PTY write in its entire life — at **+290.4 s**, the ESC that ended it. Strictly untouched until then, and still `open` at 3.6× the 60 s tier. This is the clean case of a form left up.

**Frame-level gap between the two producers**, where both appeared on one form:

| first | second | gap |
|---|---|---|
| `b58a428a` (transcript) | `4d55c505` (screen) | **+5.894 s** — screen overwrote transcript (`replaced`) |
| `791fe7d8` (transcript) | `06a2830a` (screen) | **+5.892 s** — screen overwrote transcript (`replaced`) |
| `cc7a33de` (screen) | `222f5923` (transcript) | **+10.861 s** — *not* an overwrite; the screen prompt had already been cancelled 0.1 s earlier |

The two overwrites are strikingly consistent at ~5.89 s. **Both observed overwrites run transcript → screen**; the third pair is not an overwrite at all, so it neither supports nor contradicts the direction.

**Two caveats that must not be dropped:**
1. **Direction is stated as observed.** `replaced` occurs twice in the frame-level data, both transcript → screen. **No frequency is claimed** — this is not a rate.
2. **No in-place upgrade was ever observed.** No prompt's payload changed within its life, across all 19 prompts. So `handleJsonlQuestion`'s repair path either did not trigger here or emits no frame. **That is an open question, not a claim.**

**Link to #721/#730 holds regardless of mechanism:** every correct (transcript) parse expired on schedule, and the durable case appeared only behind a degraded (screen) one.

### 3.3 Cell 3 — positive controls on 1.70.4. **PASS, both**

The guard against this phase's worst outcome: a #721 fix that broke the single-select paths already signed off in phase C.

| control | mapping | answer | provider-side effect |
|---|---|---|---|
| **Row 2** permission gate | `06244f4c`, `questions:1`, `inputMode:"single"`, options `Yes / Yes-and-don't-ask / Yes-and-auto-mode / No` | `200` → rev 2 `resolved`/`answered` | **the command actually ran** — `Bash` tool_use with the exact curl, `tool_result: 200` |
| **Row 7a** single-select question | `d0bc40f8`, `questions:1`, `inputMode:"single"`, options `Technology / Business` | `200` → rev 2 `resolved`/`answered` | **the selection was recorded** — `tool_result: Your questions have been answered: "Which topic are you interested in?"="Technology"` |

Recorded **by producer**: the gate `06244f4c` was **screen**-sourced, the question `d0bc40f8` **transcript**-sourced. Both answered correctly, so the answer path works from either producer — the #730 defect is in payload completeness, not in answerability.

Verified against **real objects**, not typed declarations: both answers were confirmed by their provider-side effect, not by the HTTP status alone.

**Profile integrity held** — the #709 facet-1 check: `proj-174/.claude/settings.local.json` **absent** (no "don't ask again" rule was written), rig profile sha still `6ec0209d…aefbc88`. Neither profile-mutating option was ever selected; the harness assertion enforces this rather than attention.

---

## 4. What changed between 1.70.2 and 1.70.4

`stripStateMarker`, `KNOWN_STATE_MARKER_RE`, `multiSelect: sawStateMarker` — all 1.70.4-exclusive. They deliver the `inputMode` and glyph halves of #721. Nothing in the diff addresses multi-*question* extraction, which is consistent with the nondeterminism observed.

---

## 5. Findings

### 5.1 #721 — fixed to scope, stays closed. Residual is **#730**
`stripStateMarker` / `KNOWN_STATE_MARKER_RE` / `multiSelect: sawStateMarker` deliver #721's `inputMode` and glyph halves, reliably, across every observation.

The residual multi-question defect is **threadbase-streamer #730 (P2)** — two producers, order-dependent, with the screen scraper permitted to overwrite the authoritative transcript prompt. Verdict wording of record: §1.

**`provenance` is the discriminator, and it works.** Across the 2-question provocation, `source` predicted the parse **every time**: `screen`/`inferred` → degraded 1-question, `transcript`/`authoritative` → correct 2-question.

**Stated precisely, because the raw question count is not the test:** for single-select menus and permission gates, `questions: 1` is *correct* from either producer (`222f5923` transcript Q=1, `06244f4c` screen Q=1, `d0bc40f8` transcript Q=1). Provenance predicts **degradedness on a multi-question form**, not question count in general. A future check must compare against the tool call's ground truth, not against a bare count.

**Frequency, for the multi-question form only:** 11 prompts, **6 screen-sourced (degraded) / 5 transcript-sourced (correct)** — close to a coin flip, neither rare nor an edge case.

**No schema change is needed to fix it** — see §1.

### 5.2 #724 — residual explained by **producer**, not by parse
See §3.2. A transcript-sourced prompt expires at 60 s; a screen-sourced one lives as long as its form is on screen. That single rule covers 4 s, 10 s and 310 s. The durable case is a form left up — `af409c8c`, 290.5 s, one write in its life, at the end of it.

### 5.3 `keys` vs `input` — #692 design, still holding on 1.70.4
Same session, same open prompt, same ESC payload, back to back:

```
{"input": ESC}  -> 409  {"ok":false,"reason":"prompt_pending","promptKind":"question","promptState":"open"}
{"keys":  ESC}  -> 200  {"ok":true}
```

A `keys` body reaches `sendKeys` **before** the open-prompt check and is never refused; an `input` body hits the guard. **Text is barred, raw keys are not** — the same statement phase A made about 1.69.6. This resolves the app-Cancel anomaly, confirms the Cancel path is documented behaviour rather than a hole, and bounds the composer guard's scope.

### 5.4 A prompt can be *replaced*, and the replacement can be the lossy one
`b58a428a` and `791fe7d8` (both **transcript**, `Q=2`) each ended `terminalReason: "replaced"` at **5.894 s** and **5.892 s**, superseded by a **screen**-sourced `Q=1` prompt under a **new promptId**. This is #730's mechanism visible on the wire.

The precise statement the evidence supports:

> A given `promptId`'s payload never changes — no in-place revision was observed on any of the 19 prompts. But a form can be re-scraped and **replaced** by a new `promptId` carrying a *different* parse. A contract client keyed on `promptId` therefore sees its prompt **retired underneath it** — the same structural exposure as the phase-B headline, where the legacy client keyed on gate content and would have ridden the replacement invisibly.

**Two caveats, carried deliberately:**
1. **Direction as observed:** both overwrites run transcript → screen. **No frequency is claimed.**
2. **No in-place upgrade was ever observed.** `handleJsonlQuestion`'s repair path either did not trigger here or emits no frame — **an open question, not a claim.**

Fix ownership is unchanged and server-side; a content-key fallback is **not** the fix (it would reintroduce #871).

## 6. Method notes added in this phase

- **A dead recorder and a silent server are indistinguishable from the outside.** My tap process died three times (`nohup … &` inside a tool call is reaped when the call returns); for a stretch, trials ran against a dead recorder and the empty result read as data. It nearly produced a "stuck prompt" finding — a prompt dismissed on screen but still `open` on the wire four minutes later — which a fresh subscribe disproved. Fixed by launching the tap as a tracked background task and verifying liveness before every trial.
- **Probe the body field, not the route.** `GET /prompts` is 404 and there is no `/keys` route; prompts are WS-only and `keys` is a **body field** of `/input`. Both 404s were mine.
- **`/input` takes `input`, not `text`.** A wrong field name returns `400 Missing input field`, which reads like a server refusal.
- **Byte-exact equality is the wrong assertion for a live TUI.** A "screen unchanged" check reported movement; the two captures differed by **2 bytes** with identical phrase sets — the elapsed-time counter ticking. Content equality is the right check and it held.
- **An unscrolled screenshot is not evidence of absence** (carried from phase A; still load-bearing).

All four join the standing rule: **an empty result is a claim about your tooling until you prove the tooling can return something.** That rule caught **three** separate false claims in this phase alone — the missing route, the `text`/`input` field, and the dead-recorder "stuck prompt".

---

## 6a. Withdrawals

Both are recorded as withdrawals, not silent edits.

**Withdrawal 1 — "the second question is STILL dropped."** Reported after row 7 proper on a single observation. **Wrong**: a complete 2-question payload does reach the wire, and the correct finding is the order-dependent two-producer defect now filed as **#730** (§1, §5.1). The lead caught it because the tap I supplied contained its own counterexample. Generalising from n=1 is what produced it.

**Withdrawal 2 — "Escape closes it" scored PASS.** **Not demonstrated.** The Escape returned 200 at `14:36:29.083`, but `e300ad9d` cancelled at `14:36:59.714` — **exactly 60.001 s after it opened**, 30.6 s *after* the Escape. That is the 60 s self-cancel tier, not the keystroke. The sub-check is **not verified**; a passing status code was mistaken for a causal effect.

**Withdrawal 3 — "every degraded parse left alone exceeded 60 s and never self-cancelled; no exceptions either way."** **Wrong, and wrong in a way the phrasing concealed.** Four screen-sourced prompts terminated in **4–11 s**. My table's "left alone" qualifier silently excluded every prompt I had myself ended, while the sentence claimed "no exceptions either way" — so a filtered sample was reported as an exhaustive one. Two of the lifetimes I quoted (`c3676582` 281 s, `a2822e91` 89.9 s) were additionally **unmeasurable**, spanning the dead-tap window. Superseded by §3.2's producer rule, which is both correct and stronger. The lead caught it by extracting every open→terminal pair rather than accepting my table.

---

## 7. Evidence index

Scrubbed mirror only — every tap writes the rig key into its own argv, and the streamer prints its key unmasked at boot (**#723**).

| artefact | what it carries |
|---|---|
| `evidence-scrubbed/build-1.70.4/cli.cjs` | the dist under test, sha256 `3f23c274…` verified at the destination |
| `D-row7-tap.jsonl` | row 7 proper — every frame, both parses |
| `D-recon-tap3.jsonl` | reconciliation + tier measurements |
| `D-trials3.json`, `D-trials4.json` | trial records, including the **not-run** rows |
| `D-recon.jsonl` | detection-vs-screen correlation |
| `shots/D-row7-10-card.png` | the fail-closed guidance card |
| `streamer-174.log` | rig log; `Frontend` count 0 against 50 `http.request` |

**Not run:** 6 trials, all refused `409 prompt_pending`. Recorded as not run with that reason — the guard working, not a harness failure.

---

## 8. Appendix — what a phase E would carry

Nothing is scheduled. If the owner ships a multi-question mapping fix:

1. **Re-measure the producer split** (§5.1) on the new build with the same provocation — the qualitative finding is nondeterminism, so a fix must be shown to make the correct parse *deterministic*, not merely more common. A handful of correct runs proves nothing here.
2. **Re-measure lifetime by producer** (§3.2), not by parse. The prediction to test: a #730 fix should leave the 60 s transcript expiry untouched and remove the *degraded* durable case, because the form-lifetime rule is about the screen producer, not about correctness.
3. **Answer the open question of §5.4** — does `handleJsonlQuestion`'s in-place upgrade ever emit a frame? It was never observed here.
3. **Re-run cell 3's controls** — the same regression guard, for the same reason.
4. **Row 7's fail-closed sub-checks must be re-run, not inherited.** If the shape becomes answerable, `unsupported_prompt_shape` should stop firing — and that change must be observed, not assumed.
5. **Escape-closes-it is still owed** (§6a withdrawal 2) and needs a causal test: send the key, and prove the close is attributable to it rather than to the 60 s timer.

Method is PHASE-C §8.4, unchanged, plus §6 above.
