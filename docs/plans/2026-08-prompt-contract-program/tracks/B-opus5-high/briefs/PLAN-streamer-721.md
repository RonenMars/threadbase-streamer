# Approved plan — streamer #721 (from `streamer-shape-classification-engineer`, 2026-08-28)

Sub-agent died on the usage limit mid-implementation. A respawn continues **this plan and the work already in the worktree**; it does not re-derive either. Approved by the program owner, including the addendum.

## Reproduction, already done (do not redo)

Captured screens replayed through a headless xterm configured as `pty-shared.createScreen()` (120x40, scrollback 1000) and read back the way `getOutputLines` does (`slice(-60)`). The real detector returns, on all four captures: **1 question, `multiSelect: false`, `header: ""`**, labels `"[ ] Python"`, `"[ ] JavaScript"`, `"[ ] Type something"`, `"Chat about this"` (`"[✔] Python"` on the post captures). `resolveAnswer(first option)` → `{"ok":true,"keys":"\r"}` — a bare Enter, which on a multi-select TUI toggles rather than submits.

Confirmed against production: the rig log records `pty.keys_write byteLen: 1` on both row-7 sessions in the same millisecond as each 200 — so the harness reproduces the production path in fact. Taps show `prompt_event` seq 1 `open`/`single` → seq 2 `resolved`/`answered` → seq 3 **13 ms later** a fresh promptId with `[✔] Python`.

## Scope: detection + label hygiene. Not multi-question representation.

`AskQuestion.multiSelect` already exists and everything downstream honours it (`ptyPromptAdapter.ts:47` → `inputMode: "multi"`; `answersToKeystrokes.ts:51` throws `UnsupportedPromptShapeError("multiSelect")` before building a keystroke, so zero bytes is structural). The defect is that the value is never computed. Multi-question representation is deliberately unfixed: a multi-question single-select carousel works today, and honest N-question representation needs the keystroke synthesizer the workspace CLAUDE.md forbids.

## The rule (per option label, after stripping cursor and numbering)

- **(a) known state marker** — `[` + {space, `x`, `X`, `*`, `✓`, `✔`} + `]`, or leading `☐`/`☑`/`☒` → multi-select; strip the marker.
- **(b) unrecognised leading `[…]`/`(…)` of ≤3 chars** → shape not understood; leave the label alone.
- **(c) otherwise** → ordinary label.
- **ANY** option matching (a) or (b) → `multiSelect: true`. Otherwise `false`, byte-identical to today.

"Any", not "all", is an empirical result: the escape-hatch option `Chat about this` carries no checkbox, so "some marked, some not" is the normal shape and an "all" rule would have shipped the bug. Branch (b) is what makes the classifier fail towards unanswerable — glyph-matching alone is a positive detector, so an unfamiliar marker would fall through to `single`, which is the defect itself.

Two signals designed then **refuted by running against the repo's own fixtures**: the row-9 tab strip as a refusal trigger (would break working single-select carousels — real evidence of the wrong proposition), and `Type something` as a free-text signal (`REAL_MENU` line 44 already contains `"  5. Type something."` and asserts it at line 60, so keying on it would redden the existing positive control).

## The glyph strip is load-bearing, not hygiene

`questionContentKey` keys on question text plus option labels, so `[ ] Python` → `[✔] Python` changes the key — which is why the repaint minted a new promptId instead of being suppressed. The strip therefore fixes a second, independent path: a user ticking a box **at their own keyboard**, with no byte from us, churns a fresh prompt today. `multiSelect: true` stops us writing the byte; the strip stops host-side toggles churning prompts. Neither alone covers both.

Accepted trade: stripped labels no longer carry tick state. Moot on the contract path (the card renders no options under `unsupportedShape`) and the legacy rows are unactionable anyway.

## Where it surfaces

`handleLiveQuestion` passes one `questions` array into `questionPromptDraft`, `pendingQuestions` and the legacy `question` event, so one detector change covers all three. Contract → `inputMode: "multi"` → mobile `40ac02ac` `mapPromptToBlock` returns `unsupportedShape` with `options: []`, no tappable rows — an existing refused bucket. Route → `unsupported_prompt_shape` 400, `sendKeys` unreachable.

**Legacy-path caveat, ruled ACCEPTABLE by the owner, no mobile change required:** `mapAskQuestionToBlock` never sets `unsupportedShape`, so legacy clients still render tappable rows and a tap gets the 400 as a toast rather than a disabled card. "Never break released clients" protects behaviour that works; today that same tap writes `\r` into a live form, so a zero-byte 400 is an improvement, not a break. State that reasoning in the PR body. A mobile P3 is filed separately by the owner.

## Tests (six) and mutations (five)

1. `detect-question-from-screen.test.ts` — "classifies the captured multi-select form as multiSelect, never single". Fails today (`false`).
2. Same file — "strips checkbox markers from option labels": exactly `["Python","JavaScript","Type something","Chat about this"]`. Fails today.
3. `fail-closed-answer.test.ts` — the REAL screen path: captured screen → headless xterm as `pty-shared.createScreen()` → `detectQuestionFromScreen` → `resolveAnswer`, asserting 400 / `unsupported_prompt_shape` / `written === []`. The `AskQuestion[]` comes from the detector on the fixture, never hand-built. Fails today (200, `written === ["\r"]`).
4. **Positive control** — `MENU` and `REAL_MENU` unchanged (`multiSelect === false`, labels unchanged, route 200 with expected keystrokes), and the single-select permission gate untouched. Passes today and must keep passing: a classifier that refuses everything satisfies 1-3.
5. `detect-question-from-screen.test.ts` — "a checkbox toggle does not change the question content key": `questionContentKey(7-pre) === questionContentKey(7-post)`. Fails today.
6. A synthetic `[?] Foo` / `( ) Foo` fixture asserting refusal, so branch (b) is proven to do work.

Mutations, each must go red: force `multiSelect: false` → 1 and 3; delete the strip → 2 and 5; "all options marked" rule → 1; refuse-everything → 4; drop branch (b) → 6.

## Vacuity finding — must be named in the PR body

`__tests__/fail-closed-answer.test.ts:26` hand-builds `const multiSelect: AskQuestion = { ...single, multiSelect: true }`, and no producer can emit that value (`detectQuestionFromScreen.ts:130` hardcodes `false` and is the only screen producer). So the suite guarding the Phase 1 fail-closed guarantee passes against a state the real path cannot reach — the same class as `prompt-answer-pty.test.ts` replacing `sendKeys` in #700. Test 3 closes it.

## PR body must also carry

The `byteLen: 1` harness-versus-production match; the strip stated as load-bearing; **#727** cited for the `screen:${sessionId}:${key.length}` toolUseId collision (already filed — do not file again); and that **#724 stays open** — this removes one source of orphaned `open` prompts, not the mechanism.

## Fixtures and secrets

Rendered line arrays only, from the four `B-row7-screen-7*.json` captures; never the log or taps (readable for context, they are scrubbed). Re-grep whatever is staged for `tb_` and report the result.
