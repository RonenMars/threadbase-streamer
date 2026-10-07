# Provider question parsing

How each supported coding-agent CLI asks the user a question, and how the streamer detects, parses and structures it into a card.

Scope: permission gates, startup and trust gates, multi-choice questions, multi-question prompts, option descriptions, free-text answers and usage-limit screens, from the terminal screen through to the card a client receives and the bytes written back to the PTY.
Session state is covered in `docs/architecture/provider-session-states.md`; it is mentioned here only where a question holds a turn open.

Read against `origin/main` at `58352e8d` (release 1.111.0) on 2026-10-06.
Copilot CLI is **not on `main`**: everything in section 4 describes the unmerged branch `feat/copilot-provider` (PR #1002, open, read at `abe0f7d4`) and the investigation report in `docs/compatibility/copilot-cli-questions.md`.

## Reading this document

Every behavioural claim carries a `path:line` and a greppable anchor in backticks.
Line numbers drift within hours, so search for the anchor when the number misses.
Paths are relative to the repository root unless prefixed with `tb-mobile:` (the mobile client's repository).

Each claim is tagged with how it is known:

- **[code]** — verified by reading the code at the commit above.
- **[transcript YYYY-MM-DD]** — observed in a working session on that date and not re-proven against current code; treat it as a lead.
- **[unknown]** — not established; nothing here should be read as a guess.

Screen examples are copied from fixtures in the repository, and each one names its fixture and says whether that fixture is a raw capture.

## 1. Overview

### 1.1 The shared pipeline

1. A provider CLI paints a prompt into its PTY.
2. The provider's runner looks at the **rendered screen** (the headless-terminal row text, not the byte stream) and, for Claude Code only, at OSC escape sequences and the conversation transcript.
3. A detector turns the screen into either a *permission gate* (`PermissionGate`: prompt, detail, numbered options) or a *question* (`AskQuestion[]`).
4. The runner reports it through one of two callbacks: `onPermissionChange` (`src/types.ts:776`) or `onLiveQuestion` / `onLiveQuestionGone` (`src/types.ts:809`, `:813`). **[code]**
5. The server wires those to handlers (`src/server-wiring.ts:436`, `:449`, `:456`), which record a provider-neutral prompt and broadcast a legacy WebSocket card. **[code]**
6. A client answers over REST; the server translates the answer into keystrokes and writes them to the PTY.

There is no shared detector.
Claude Code's detection lives in `src/pty-manager.ts` (`detectLivePrompts`, `:1003`), Codex's in `src/codex-pty-runner.ts` (`detectScreenState`, `:927`), and the Cursor and Copilot runners have none. **[code]**

### 1.2 Wire shape of a card

Two legacy WebSocket transports exist, plus a newer provider-neutral contract layered over both.

**`permission` / `permission_cancelled`** (`src/types.ts:352`, `:374`) **[code]**

| Field | Meaning |
|---|---|
| `sessionId` | The live session. |
| `prompt?` | The question line above the options. |
| `detail?` | Context above the prompt, such as the command being approved. |
| `options` | `PermissionOption[]` (`src/types.ts:262`): `index` is the number **shown on screen**, `label` is the row text, `answerKeys?` is a literal byte string that overrides the default answer encoding. |
| `cursor?` | The on-screen index the CLI's cursor is on, when exactly one cursor row was found. |
| `contentKey` | Identity of the gate's content (`permissionGateKey`, `src/services/questions/detectPermissionGate.ts:79`). |
| `gateId` | Identity of this occurrence of the gate. |

**`question` / `question_cancelled`** (`src/types.ts:347`, `:348`) **[code]**

| Field | Meaning |
|---|---|
| `sessionId` | The live session. |
| `toolUseId` | The transcript `tool_use` id, or a synthetic `screen:<sessionId>:<n>` id when the card came from the screen (`src/api/handlers/sessions.handlers.ts:1286`). |
| `questions` | `AskQuestion[]` (`src/types.ts:251`): `question`, `header`, `multiSelect`, `options`. |
| `options[]` | `AskOption` (`src/types.ts:245`): `label`, `description`, `preview?`. |

**Prompt contract** (`prompt_event` / `prompt_snapshot`, `src/schemas/prompt.schema.ts`) **[code]**

- `PROMPT_SCHEMA_VERSION = 1` (`:3`), advertised by `/api/info` as `promptContract: { schemaVersion: 1, atomicAnswer: true }` (`src/api/routes/misc.routes.ts:460`).
- `PromptSchema` (`:52`) carries `state` (open, updated, resolved, cancelled, expired, unavailable), `intent` (`approval` or `question`, `:60`), title, message, detail, questions and a `provenance` with a `source` (provider, screen, transcript, synthetic) and a `confidence` (authoritative or inferred).
- `PromptQuestionSchema` (`:15`) carries `questionId`, `text`, `header?`, `inputMode` (`single`, `multi` or `text`, `:20`), `options`, `allowOther` and `secret`.
- `PromptOptionSchema` (`:8`) carries `optionId`, `label`, `description?`, `preview?`.
- Both legacy transports are adapted into it by `permissionPromptDraft` and `questionPromptDraft` (`src/services/prompts/ptyPromptAdapter.ts:5`, `:30`).
- A permission gate becomes one `single` question with intent `approval` and provenance `screen` / `inferred`.
- A question becomes `multi` when `multiSelect` is set and `single` otherwise; a screen-sourced question is `inferred`, a transcript-sourced one is `authoritative`.
- No producer emits `inputMode: "text"`, so the contract can describe a free-text question but nothing on `main` creates one. **[code]**

### 1.3 Answer routes

All under `/api/sessions` (`src/api/routes/sessions.routes.ts:68`–`:88`). **[code]**

| Route | Handler | What it writes |
|---|---|---|
| `POST /:id/permission/answer` | `handlePermissionAnswer` (`sessions.handlers.ts:1632`) | `option.answerKeys`, else `permissionAnswerKeys(option.index)`. |
| `POST /:id/answer` | `handleSendAnswer` (`:1982`) | Keys from `resolveAnswer` → `answersToKeystrokes`. |
| `POST /:id/prompt/answer` | `handlePromptAnswer` (`:2058`) | The same two encodings, selected by `permissionAnswerAdapter` (`:1470`) or `questionAnswerAdapter` (`:1534`). |
| `POST /:id/raw-key` | `handleRawKey` (`:1836`) | One named key from `RAW_KEY_BYTES` (`:126`): escape, up, down, left, right, tab, shift_tab, enter. |
| `POST /:id/input` | `handleSendInput` (`:1046`) | Text plus Enter, or literal `keys`. |

Three rules apply to every provider. **[code]**

- `handlePermissionAnswer` takes `optionIndex` as a **0-based position in the card's option list**, not the on-screen digit, and answers 409 with `gate_closed` or `gate_mismatch` when the card is stale (`:1680`, `:1695`).
- A text `{input}` is refused with 409 `prompt_pending` while a permission or question card is open, so a typed message cannot land in a menu; literal `{keys}` are not arbitrated (`:1198`–`:1208`).
- A raw `enter` resolves the open prompt record and a raw `escape` cancels it (`:1954`, `:1956`).

A subscriber that connects late is sent the pending card again (`ws.replay_permission`, `ws.replay_question`, `src/server-wiring.ts:932`, `:949`). **[code]**

## 2. Claude Code

### 2.1 Kinds of question the CLI asks

- **Tool permission gate** — "Do you want to proceed?" with numbered Yes / No rows.
- **`AskUserQuestion` menu** — a model-asked question with numbered options, optionally multi-select, optionally several questions behind a tab bar, with a "Type something" free-text row and a "Chat about this" row.
- **Submit confirmation** — "Ready to submit your answers?" after a multi-question or multi-select form.
- **Unnumbered startup choice** — the workspace-trust list, confirmed with Enter.
- **Unboxed numbered picker** — a numbered list with a cursor and no gate footer.
- **Shell prompt inside the PTY** — a `[y/n]`, "Press Enter" or numbered prompt printed by a command rather than by Claude Code.

Two prompts are suppressed at spawn rather than detected: sessions start in `--permission-mode acceptEdits` by default, and the bypass-mode warning menu is switched off through `skipDangerousModePermissionPrompt` (`src/pty-manager.ts:310`–`:349`). **[code]**
Usage-limit screens: no detector exists for Claude Code, and what the screen looks like in a streamer PTY is **[unknown]**.

### 2.2 What it looks like on screen

Permission gate, rendered by replaying the raw PTY chunks of `__tests__/fixtures/turn-signals/claude-2.1.280-gate.json` (a raw capture, Claude Code 2.1.280) through a headless terminal at 120 columns; header and status rows omitted, the rule shortened:

```text
────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   touch /tmp/tb-gate-probe-$(date +%s)
   Create a timestamped probe file in /tmp

 Contains command_substitution

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and switch to auto mode · auto mode handles these prompts for you
   3. No

 Esc to cancel · Tab to amend
```

The gate in this capture is **not boxed**; it sits under a full-width rule.
The boxed gate in `__tests__/detect-gate-screen.test.ts` (`GATE_SCREEN`) is hand-written to mirror an earlier measurement and is not a raw capture.

`AskUserQuestion`, multi-select and multi-question, from `__tests__/fixtures/row7-multi-select-screen.ts:13` (`MULTI_SELECT_SCREEN`, captured from Claude Code 2.1.247 and stored as the row array the detector receives; the rule is shortened here):

```text
←  ☐ Languages  ☐ Environments  ✔ Submit  →

Which languages should be used?

❯ 1. [ ] Python
  Use Python
  2. [ ] JavaScript
  Use JavaScript
  3. [ ] Type something
     Next
────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

It shows every feature at once: the tab bar of question headers, a description row under each option, the free-text row, and the escape-hatch row below a rule.

No raw fixture exists for the unnumbered startup choice or the unboxed picker; their detectors cite a measurement on Claude Code 2.1.278 in comments only. **[code]**

### 2.3 Detection trigger

Detection runs in `detectLivePrompts` (`src/pty-manager.ts:1003`) on every output chunk. **[code]**

- **OSC 777 notify.** `hasPermissionOsc` matches a notify whose body says "needs your permission" (`OSC_777_PERMISSION_RE`, `detectPermissionGate.ts:104`); `hasWaitingForInputOsc` is the close signal (`:107`). The regexes run over the previous chunk's last 128 characters plus the current chunk (`OSC_TAIL_CHARS`, `pty-manager.ts:107`), so an escape split across chunks still fires.
- **Paint-time scrape.** Claude Code debounces that notify by about six seconds after painting the gate, so the rendered screen is also scraped on output, at most once per 300 ms (`SCRAPE_THROTTLE_MS`, `:118`), over the last 60 rows.
- **`Enter to select` footer.** Seeing that phrase in the chunk or on screen (`hasAskFooter`, `:1032`) routes to the question detector.
- **Transcript.** A `tool_use` named `AskUserQuestion` in the conversation JSONL is parsed by `detectAskUserQuestion` (`src/services/questions/detectAskUserQuestion.ts:61`). It arrives after the screen path and upgrades the card.
- **Idle rescan.** `handleQuiet` (`:1243`) rescans for a startup gate when the session is `waiting_input` with no card open.

The arms run in a fixed order: OSC-triggered scrape (even with zero options), refresh or close of an already-open gate, then a paint-time claim `detectGateScreen ?? detectPickerScreen ?? detectStartupChoiceGate` (`:1139`, `:1177`), then `detectQuestionFromScreen` (`:1197`), then `detectShellPrompt` (`:1220`). **[code]**

A gate or an `Enter to select` menu on screen holds the turn open: `recheckReadyFromScreen` (`:1400`) refuses to end the turn while one is painted. **[code]**

### 2.4 Parsing rules

**Permission gate** (`scrapePermissionGate`, `detectPermissionGate.ts:156`). **[code]**

- Options match `OPTION_RE` (`:135`): optional cursor glyph `❯`, `›` or `>`, a number, a dot, a label.
- Only the **last** option block on screen is taken, scanning bottom-up, because prose above a gate can contain a numbered list.
- The cursor is reported only when exactly one row carries a glyph.
- The prompt is the nearest non-chrome line above the block; up to six lines above it become `detail` (`MAX_DETAIL_LINES`, `:221`).
- `detectGateScreen` (`:270`) accepts the result as an unsolicited gate only with two or more options, an `esc to cancel` footer (`GATE_FOOTER_RE`, `:256`), **no** `Enter to select` footer (`ASK_MENU_FOOTER_RE`, `:259`) and at least one label starting with Yes or No (`YES_NO_LABEL_RE`, `:262`).
- `detectPickerScreen` (`:296`) accepts an unboxed numbered list with a cursor and no composer rule below it.

**`AskUserQuestion` from the screen** (`detectQuestionFromScreen`, `detectQuestionFromScreen.ts:122`). **[code]**

- Requires the `Enter to select` footer (`ASK_FOOTER_RE`, `:27`) and two or more options.
- Options match `OPTION_RE` (`:31`), which accepts only `❯` as the cursor glyph.
- A block whose labels are exactly Yes / No is rejected as a permission gate (`PERMISSION_LABEL_RE`, `:42`).
- A leading checkbox (`[ ]`, `[x]`, `[✓]`, `☐`, `☑`, `☒`) is stripped from the label (`KNOWN_STATE_MARKER_RE`, `:52`) and sets `multiSelect: true` (`:206`).
- The question is the line ending in `?` above the options; a question wrapped over several rows is rejoined by `joinWrappedQuestion` (`:106`), up to `MAX_WRAPPED_QUESTION_ROWS = 6` (`:104`), stopping at a header chip (`HEADER_CHIP_RE`, `:97`).
- **Descriptions are dropped**: every option is emitted as `{ label, description: "" }` (`:160`).
- **One question per card**, with `header: ""` (`:206`): on a multi-question form only the tab currently on screen is carded.
- The "Type something" and "Chat about this" rows are carded as ordinary options.
- The submit screen is recognised (`isSubmitConfirmationScreen`, `:216`) and carded as a normal two-option question.

**`AskUserQuestion` from the transcript** carries everything the tool call held: every question, `header`, option `description`, `preview`, `multiSelect` and the real `toolUseId`. **[code]**

**Unnumbered startup choice** (`detectStartupChoiceGate`, `detectStartupChoiceGate.ts:60`): an `enter to confirm` footer (`CONFIRM_FOOTER_RE`, `:28`), a cursor row and unnumbered sibling rows; indices are synthesised by position. **[code]**

**Shell prompt** (`detectShellPrompt`, `detectShellPrompt.ts:69`): `[y/n]` (`YN_RE`, `:38`), "press enter" or a trailing "continue" (`:42`, `:43`), or a contiguous `1..n` numbered block (`NUMBERED_RE`, `:48`); anything carrying Claude Code chrome is rejected (`CLAUDE_CHROME_RE`, `:53`). **[code]**

### 2.5 The structured card produced

- Permission gates, pickers, startup choices and shell prompts go out as `permission` (`handlePermissionChange`, `sessions.handlers.ts:1374`), deduplicated by content key. A gate reported by OSC before its options could be scraped is broadcast with `options: []` and gets no prompt record. **[code]**
- Screen-detected questions go out as `question` with a synthetic `screen:` id (`handleLiveQuestion`, `:1272`). **[code]**
- When the transcript line arrives, `handleJsonlQuestion` (`:1323`) upgrades provenance to `transcript`, and `processJsonlQuestions` (`src/server.ts:3175`) re-broadcasts the card with the real `toolUseId` (`shouldBroadcastQuestion`, `src/services/questions/questionBroadcast.ts:46`). **[code]**
- A transcript question is auto-cancelled after 60 seconds, and is suppressed when the transcript file is contended or the question belongs to a different writer than the PTY. **[code]**

So a Claude question card starts with labels only and gains headers, descriptions and the remaining questions once the transcript catches up.

### 2.6 How an answer is written back

| Prompt | Bytes | Source |
|---|---|---|
| Numbered gate or picker | the on-screen digit, then `\r` | `permissionAnswerKeys`, `permissionAnswerKeys.ts:14` |
| Unnumbered startup choice | Up or Down repeated by the distance from the cursor, then `\r` | `startupChoiceAnswerKeys`, `detectStartupChoiceGate.ts:44` |
| Shell `[y/n]` | `y\r` or `n\r` | `detectShellPrompt.ts` (`YN_RE` branch) |
| Shell "press enter" / "continue" | `\r` | same file |
| `AskUserQuestion`, single question, single select | Down repeated by the option's position, then `\r` | `answersToKeystrokes`, `answersToKeystrokes.ts:43`, `:62` |

All **[code]**.

- `answersToKeystrokes` assumes the cursor starts on the first option and supports exactly one single-select question with one chosen label.
- A multi-question card, a multi-select card or more than one label throws `UnsupportedPromptShapeError`, surfaced as `unsupported_prompt_shape`; the legacy route answers 400 telling the user to answer in the terminal (`resolveAnswer.ts:21`, `handleSendAnswer`). **[code]**
- A free-text answer has no encoding at all: text responses to a question are refused as `unsupported_prompt_shape` (`questionAnswerAdapter`, `:1534`). **[code]**
- Before writing, the server re-scrapes the screen to confirm the gate or menu is still painted (`permissionGateStillOpen`, `:1784`; `isQuestionMenuOnScreen`, `detectQuestionFromScreen.ts:236`). **[code]**
- Writing an exact permission answer closes the gate immediately, without waiting for the screen to change (`isPermissionAnswer`, `pty-manager.ts:549`). **[code]**

### 2.7 Persistence or auto-answer

The streamer persists no Claude answers and auto-answers nothing. **[code]**
"Don't ask again" choices are persisted by Claude Code itself.
The only streamer-side avoidance is at spawn: the default permission mode and the seeded settings in 2.1.

### 2.8 Known bugs and gaps

- Option descriptions are dropped from screen-detected questions on `main`. PR #1012 (open, branch `feat/screen-question-option-descriptions`, read at `f5af99fc`) attaches indented rows under an option as its description and widens `HEADER_CHIP_RE` to include the tab-bar arrows. **[code]** for both sides of the diff.
- A multi-question form is carded one tab at a time from the screen; a client sees the full set only after the transcript line arrives. **[code]**
- Multi-select, multi-question and free-text answers cannot be sent through a card; they need raw keys or the terminal. **[code]**
- A wrapped question once reached the phone as only its last row; fixed by `joinWrappedQuestion` (PR #1007, release 1.105.1). **[transcript 2026-10-01]** for the symptom, **[code]** for the fix.
- "The card still shows no option labels for a multi-question prompt" was reported from the mobile side. **[transcript 2026-10-04]**, not reproduced here.
- The paint-time detectors have a raw fixture only for the numbered gate and the `AskUserQuestion` menu. **[code]**

## 3. Codex

### 3.1 Kinds of question the CLI asks

- **Directory-trust gate** — "Do you want to trust the contents of this directory?"
- **Hooks-review gate** — "Hooks need review".
- **Command approval** — an `E X E C` card with `Environment:` and `Reason:` rows.
- **Usage-limit screen**, and the softer "usage limit reset available" tip.
- **Rate-limit menu** — "Approaching rate limits", offering a model switch.
- **Generic numbered picker** — for example the sign-in method list.
- **Structured model question** (`request_user_input`) — exists in the CLI but is default-off; see 3.8.

### 3.2 What it looks like on screen

Sign-in picker, from `__tests__/detect-codex-picker.test.ts:10` (`SIGN_IN_PICKER`, captured from codex-cli 0.154.0; a test at `:41` pins that the blank separator rows are still present):

```text
  Welcome to Codex, OpenAI's command-line coding agent

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use

  Press enter to continue
```

Hooks-review gate, from `__tests__/codex-pty-runner.test.ts:50` (`HOOKS_GATE_SCREEN`, commented as captured verbatim from a live PTY probe on 2026-07-14):

```text
  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  Press enter to confirm or esc to go back
```

Directory-trust gate, from `__tests__/codex-pty-runner.test.ts:43` (`TRUST_GATE_SCREEN`, commented as captured verbatim; it has no blank rows, so whether it preserves the real spacing is **[unknown]**):

```text
Do you want to trust the contents of this directory?
1. Yes, continue
2. No, quit
Press enter to continue
```

Command approval, from `__tests__/codex-pty-runner.test.ts:61` (`COMMAND_APPROVAL_SCREEN`; the file states no capture provenance, so treat it as a constructed fixture):

```text
E X E C
Environment: local
Reason: Run the focused test suite
$ npx vitest run __tests__/codex-pty-runner.test.ts
› 1. Yes
  2. No
Press Enter to confirm
```

Usage limit with the rate-limit menu, from `__tests__/codex-pty-runner.test.ts:743` (`USAGE_LIMIT_SCREEN`; no capture provenance stated; the first row is abridged here):

```text
You've hit your usage limit. Upgrade to Pro, [...] or try again at Aug 8th, 2026 10:18 AM.

Approaching rate limits
› 1. Switch to gpt-5.6-luna (selected)
  Fast and affordable agentic coding model.
  2. Keep current model.
  3. Keep current model (never show again).
```

### 3.3 Detection trigger

Rendered-screen text only. **[code]**

- `detectScreenState` (`src/codex-pty-runner.ts:927`) reads the visible rows on each pass and tests them in order: trust or hooks gate regex, `detectCodexCommandApproval`, `detectCodexBlockingPrompt`, `detectCodexPicker`.
- No OSC sequence and no transcript line triggers a card.
- The soft "usage limit reset available" tip becomes a card only when a submitted prompt is stuck behind it (`elevateSoft`, `:994`).
- An open gate, approval or picker holds the turn open (`cardOpen`, `:1109`), and text sent meanwhile is queued rather than typed into the dialog (`sendInput`, `:465`).

### 3.4 Parsing rules

All in `src/services/questions/codexScreen.ts`. **[code]**

- **Trust gate**: `CODEX_TRUST_GATE_REGEX` (`:49`), `/trust the contents/i`.
- **Hooks gate**: `CODEX_HOOKS_GATE_REGEX` (`:57`), `/hooks need review/i`.
- **Command approval** (`detectCodexCommandApproval`, `:111`): requires the spaced `E X E C` heading, an `Environment:` row, a `Reason:` row, a Yes row, a No row and a confirm footer, all present; a usage-limit phrase on the same screen vetoes it. `detail` is the environment, reason and command rows joined with newlines.
- **Usage or rate limit** (`detectCodexBlockingPrompt`, `:253`): `CODEX_USAGE_LIMIT_RE` (`:76`), `CODEX_USAGE_RESET_TIP_RE` (`:80`), `CODEX_RATE_LIMIT_MENU_RE` (`:83`). Options come from `parseCodexNumberedOptions` (`:237`), which strips a trailing "(selected)". With no numbered rows the card gets one synthetic dismiss option. `detail` is the "try again at" line.
- **Generic picker** (`detectCodexPicker`, `:184`): the last contiguous `1..N` run of `CODEX_PICKER_ROW_RE` (`:161`) rows, with at most `MAX_PICKER_ROW_GAP = 2` non-option rows between consecutive options (`:167`), exactly one cursor row, no compose line below, and not while the status bar shows Ready. The prompt is the last intro line above the options and earlier intro lines become `detail`.
- **Descriptions**: the indented row under a picker option is skipped, not carried. The `permission` transport has no description field at all.
- **Multi-select and multi-question**: no Codex detector handles either.
- **Wrapped lines**: no rejoining. For the sign-in picker above the card's prompt is the second half of a wrapped sentence, "or connect an API key for usage-based billing", which the test asserts.

### 3.5 The structured card produced

Every Codex prompt goes out on the `permission` transport; the runner deliberately never calls `onLiveQuestion`. **[code]** (`src/codex-pty-runner.ts`, constructor comment above the gate state maps.)

- **Trust card** (`gateCard`, `codexScreen.ts:345`): on-screen options 1 and 2, plus a synthetic option 3 that means "yes, and remember for all projects".
- **Hooks card**: on-screen options 2 and 3, plus synthetic options 4 and 5 that are the "remember for all projects" variants. "1. Review hooks" is deliberately left off the card, because it opens a nested screen the card cannot drive.
- **Command approval card**: prompt "Codex requests command approval", options Yes and No with literal `answerKeys`.
- **Usage-limit card**: the same transport, and the runner also sets `failureReason` on the session and settles it to `waiting_input` so a client stops showing it as running (`handleBlockingPrompt`, `:1136`).
- **Picker card**: one option per row, `answerKeys` set to the bare digit.

Each is logged: `codex.gate_prompt`, `codex.command_approval`, `codex.picker_prompt`, `codex.usage_limit` (`src/codex-pty-runner.ts:1226`, `:1170`, `:1185`, `:1149`). **[code]**

### 3.6 How an answer is written back

| Prompt | Bytes | Source |
|---|---|---|
| Trust or hooks gate | real digit, then `\r` | `resolveGateAnswer`, `codex-pty-runner.ts:439` |
| Synthetic "remember" option | the real digit it stands for, then `\r`, after saving the choice | same |
| Command approval, Yes | `y` | `detectCodexCommandApproval` |
| Command approval, No | `\x1b` (Escape) | same |
| Generic picker | the bare digit, with no Enter | `detectCodexPicker`; `sendKeys` strips a trailing `\r` (`:392`) |
| Rate-limit menu | digit, then `\r` | `parseCodexNumberedOptions` |
| Usage limit with no menu | `\x1b` | `detectCodexBlockingPrompt` |

All **[code]**.

The server skips its screen re-scrape for Codex before writing a permission answer, because that check uses Claude Code's detectors and would refuse every Codex answer as `gate_closed` (`sessions.handlers.ts:1732`). **[code]**

### 3.7 Persistence or auto-answer

Codex is the only provider with a streamer-side answer store. **[code]**

- A "remember for all projects" answer is written to `gate-answers.json` in the streamer's config directory (`saveGateAnswer`, `src/services/questions/codexGateAnswers.ts:32`; path built in `gateAnswersPath`, `:18`).
- On the next matching gate, `rememberedGateDigit` (`:43`) returns the digit and `handleGate` (`codex-pty-runner.ts:1199`) writes it once without showing a card, logging `codex.gate_auto_answer`.
- Stored values: hooks `trust_all` → `2`, hooks `continue_untrusted` → `3`, trust `yes` → `1`.
- Command approvals, pickers and usage-limit screens are never remembered.

### 3.8 Known bugs and gaps

- **Structured questions are unreachable.** The model has a `request_user_input` tool, but in default mode the CLI answers the model itself with "request_user_input is unavailable in Default mode"; the feature flag `default_mode_request_user_input` is under development and off (`docs/plans/2026-08-prompt-contract-program/tracks/A-fable5-high/evidence/codex/STOP-T7.md:9`–`:15`, measured on codex-cli 0.150.1). The streamer has no detector for it, and `structuredQuestions` is `false` (`src/services/providers/capabilities.ts:116`). **[code]** for the absence; what the question looks like on screen when the flag is on is **[unknown]**.
- **Two comments disagree about the hooks gate.** `codexScreen.ts` (above `CODEX_HOOKS_GATE_REGEX`) says a digit selects and confirms instantly with no Enter, while `resolveGateAnswer` says the current pickers highlight on the digit and wait for Enter, and writes digit plus `\r`. Which is true on a current CLI is **[unknown]**.
- **Picker descriptions are discarded**, and a wrapped intro sentence yields a truncated prompt (3.4). **[code]**
- **Fixture provenance is uneven.** Only the sign-in picker and the hooks gate state a capture; the command-approval and usage-limit fixtures state none. A fixture copied from a blank-stripped print previously shipped an inert picker detector (`__tests__/detect-codex-picker.test.ts:39`–`:41`). **[code]**
- **Nested screens are not driven.** "Review hooks" is omitted from the card, and an API-key entry screen is a text field, not a picker. **[code]**

## 4. Copilot CLI

**Unmerged.**
Everything in this section describes the branch `feat/copilot-provider` (PR #1002, open, read at `abe0f7d4`), tagged **[branch]**, or the investigation report `docs/compatibility/copilot-cli-questions.md`, dated 2026-10-05 against Copilot CLI 1.0.91, tagged **[draft 2026-10-05]**.
The report's raw captures are not in the repository, and the report is a printed view, so blank-row fidelity of its examples is unverified.
None of it is on `main`.

### 4.1 Kinds of question the CLI asks

All **[draft 2026-10-05]**.

- **Boxed numbered cards**: folder trust, shell command, file write, URL fetch, path outside the project, MCP tool and plan approval.
- **`ask_user` forms**: unboxed and unnumbered, single-field or tabbed multi-field, with enum, boolean, checklist, integer and text widgets and an "Other (type your answer)" inline input.
- **Slash-command pickers**, such as the model list.
- Login or device flow, update prompts and quota or rate-limit screens: **[unknown]**, never captured.

### 4.2 What it looks like on screen

Shell command card, from the draft's capture (scratch path replaced with `<scratch>`):

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ Create a.txt and check Git status                                            │
│ ──────────────────────────────────────────────────────────────────────────── │
│ ╭──────────────────────────────────────────────────────────────────────────╮ │
│ │ touch a.txt && git status                                                │ │
│ ╰──────────────────────────────────────────────────────────────────────────╯ │
│                                                                              │
│ Do you want to run this command?                                             │
│                                                                              │
│ ❯ 1. Yes                                                                     │
│   2. Yes, and don't ask again for `touch` in this directory (<scratch>)      │
│   3. No, and tell Copilot what to do differently (Esc to stop)               │
│                                                                              │
│ ↑/↓ to navigate · enter to select · esc to cancel                            │
╰──────────────────────────────────────────────────────────────────────────────╯
```

An `ask_user` form has the header `Copilot needs information.` and the footer `↑/↓ select · enter accept · ctrl+d decline · esc cancel`; the plan card's footer adds `ctrl+e to show full plan`. **[draft 2026-10-05]**
No Copilot screen fixture exists in the repository on any branch read. **[branch]**

### 4.3 Detection trigger

None. **[branch]**

- The runner's header comment says so directly: "No trust bypass, Claude flags, TUI scraping, or borrowed transcript watcher" (`src/copilot-pty-runner.ts:30`).
- `COPILOT_CAPABILITIES` sets `structuredQuestions: false` and `permissionGates: false`, with the comment "No captured TUI yet" (`src/services/providers/capabilities.ts:154`).
- The runner registers no card callback.

Signals that exist but are unused: Copilot records `permission.requested` / `permission.completed` (with a `kind` of shell, write, read, url or mcp) and `tool.execution_start` for `ask_user` (with its JSON Schema) and for plan exit in its per-session event log; folder trust leaves no event. **[draft 2026-10-05]**

### 4.4 Parsing rules

None exist for Copilot. **[branch]**

Claude Code's detectors do not parse Copilot screens by accident either: all four returned null on all thirteen captured screens. **[draft 2026-10-05]**
The cause for the boxed cards is specific: their footer contains `enter to select`, which `detectGateScreen` and `detectPickerScreen` treat as the `AskUserQuestion` marker (`ASK_MENU_FOOTER_RE`, `detectPermissionGate.ts:259`); removing only that phrase made the shell card parse. **[draft 2026-10-05]** for the experiment, **[code]** for the regex.

### 4.5 The structured card produced

None; the streamer sends no card for a Copilot session. **[branch]**
The user sees the raw terminal.

### 4.6 How an answer is written back

- The streamer writes whatever it is given: `sendInput` writes the text plus `\r`, and `sendKeys` passes bytes through unchanged (`src/copilot-pty-runner.ts:132`, `:144`, `:148`). **[branch]**
- On the CLI side: arrows move the cursor, a digit jumps the cursor **without confirming**, Enter confirms, Escape denies and aborts the turn. **[draft 2026-10-05]**
- On an `ask_user` form: Enter submits a single-field form and advances a tab on a multi-field one, Space toggles a checklist item, Tab and Shift+Tab move between fields, and Ctrl+D declines. **[draft 2026-10-05]**
- Ctrl+D has no entry in `RAW_KEY_BYTES` (`sessions.handlers.ts:126`), so declining needs a literal `keys` write. **[code]**
- Digit followed by Enter, end to end through the streamer: **[unknown]**.

### 4.7 Persistence or auto-answer

Nothing in the streamer. **[branch]**
Copilot persists trusted folders and "don't ask again" choices in its own configuration files. **[draft 2026-10-05]**

### 4.8 Known bugs and gaps

- The provider is unmerged, and with it every statement here.
- No detector, no card, no fixture. **[branch]**
- The session never leaves `running` (no readiness signal), so nothing marks a Copilot session as waiting on a question. **[branch]**
- A Claude-style digit plus Enter would work only by coincidence of the two keys; an arrow-based encoding (as in `startupChoiceAnswerKeys`) matches the CLI's own model better. **[draft 2026-10-05]**, untested.
- Uncaptured: login, updates, quota, Escape on an `ask_user` form and on the trust card, narrow terminals, and the CLI's agent-protocol mode. **[unknown]**

## 5. Cursor

### 5.1 Kinds of question the CLI asks

**[unknown]**.
No Cursor question, approval or limit screen has been captured; the only Cursor fixtures are turn-signal captures (`__tests__/fixtures/turn-signals/cursor-2026.09.23-*.json`).
The workspace-trust prompt is known to exist only because the runner passes a flag to skip it.

### 5.2 What it looks like on screen

**[unknown]** — no fixture, so no example is given.

### 5.3 Detection trigger

None. **[code]**

- `src/cursor-pty-runner.ts` contains no reference to `onPermissionChange` or `onLiveQuestion`.
- `structuredQuestions` and `permissionGates` are both `false` (`src/services/providers/capabilities.ts:128`, `:129`), under a comment saying the TUI is not yet scraped for questions or permission cards.
- The only screen text the runner reads is the turn hint `ctrl+c to stop` (`CURSOR_TURN_BUSY_TEXT`, `:51`).

### 5.4 Parsing rules

None exist. **[code]**

### 5.5 The structured card produced

None. **[code]**

### 5.6 How an answer is written back

`sendKeys` and `sendRawKeys` write the given bytes to the PTY with no gate logic (`src/cursor-pty-runner.ts:207`, `:223`). **[code]**
Which keys Cursor's prompts accept is **[unknown]**.

### 5.7 Persistence or auto-answer

The workspace-trust prompt is avoided, not answered: every spawn passes `--workspace <path> --trust` (`src/cursor-pty-runner.ts:125`), and the comment there notes this is not permission-gate handling. **[code]**
Nothing is persisted by the streamer.

### 5.8 Known bugs and gaps

- Any approval Cursor asks for mid-turn is invisible to the streamer: no card, no state change, no push. **[code]**
- Whether such an approval leaves the `ctrl+c to stop` hint on screen (and so leaves the session `running`) is **[unknown]**.

## 6. Comparison matrix

| | Claude Code | Codex | Copilot CLI (unmerged) | Cursor |
|---|---|---|---|---|
| **Kinds of question** | Tool gate, `AskUserQuestion` (single, multi-select, multi-question, free text), submit confirm, startup choice, picker, shell prompt | Trust gate, hooks gate, command approval, usage and rate limit, numbered picker | Boxed numbered cards, `ask_user` forms, slash pickers | Unknown |
| **Screen example available** | Raw: gate, `AskUserQuestion` | Captured: sign-in picker, hooks gate; unprovenanced: approval, usage limit | Printed views in `docs/compatibility/copilot-cli-questions.md`; no raw capture in the repository | None |
| **Detection trigger** | OSC 777, paint-time scrape (300 ms throttle), `Enter to select` footer, transcript `tool_use` | Rendered-screen regexes only | None | None |
| **Options** | Last numbered block, bottom-up | Numbered rows; contiguous `1..N` for pickers | — | — |
| **Descriptions** | Transcript only; dropped from the screen path (PR #1012 open) | Skipped; transport has no field | — | — |
| **Multi-select** | Detected (`multiSelect`), not answerable by card | Not handled | — | — |
| **Multi-question** | One tab per screen card; all in the transcript card; not answerable by card | Not handled | — | — |
| **Wrapped question** | Rejoined, up to 6 rows | Not rejoined | — | — |
| **Free text** | Row carded as an option; no text answer path | Not handled | — | — |
| **Usage limit** | No detector | Card plus `failureReason` | Unknown | Unknown |
| **Card transport** | `permission` and `question` | `permission` only | None | None |
| **Answer encoding** | Digit + Enter; Down×N + Enter; arrows + Enter; `y`/`n` + Enter | Digit + Enter; bare digit; `y`; Escape | Raw passthrough | Raw passthrough |
| **Pre-write screen check** | Yes | Skipped | — | — |
| **Persistence / auto-answer** | None | `gate-answers.json`, auto-answers trust and hooks gates | None | None; trust skipped by flag |
| **Capability flags** (`structuredQuestions` / `permissionGates`) | `true` / `true` | `false` / `true` | `false` / `false` | `false` / `false` |

## 7. Streamer-sent card versus mobile-side scrape

The mobile client does not only render cards the streamer sends.
It also scrapes the terminal text itself, for any provider, so a card on the phone does not prove the streamer sent one.

### 7.1 What the mobile client does

Read from the mobile repository's `main` at `a82fbb2f` on 2026-10-06. **[code]**

- The scraper is `parseQuestionBlock` (`tb-mobile:utils/parseQuestionBlock.ts:211`), producing a block with `source: 'pty'`. There is no mobile function named `detectQuestionFromScreen`.
- It runs over the last terminal lines in `tb-mobile:components/terminal/TerminalOutput.tsx:335` and in `tb-mobile:components/conversation/ThinkingBubble.tsx`.
- It recognises four shapes: the Codex directory-trust gate (`parseCodexDirectoryTrust`, `:103`), an inquirer-style `? Question` list, a numbered menu under a line ending in `?` with a cursor or menu footer (`parseAskUserQuestionMenu`, `:140`), and a numbered list with a `❯` cursor.
- It rejects Claude Yes / No gates (`isClaudePermissionOption`, `:94`), carries no descriptions and never reports multi-select.
- A scraped card is answered with arrow keys from the detected cursor position plus Enter, sent as raw keys (`TerminalOutput.tsx:345`).
- **The server card wins**: the component renders the server-sent question when there is one and falls back to the scraped block otherwise (`TerminalOutput.tsx:483`–`:493`).
- Server cards arrive through `tb-mobile:hooks/useActiveQuestion.ts` and are mapped by `tb-mobile:utils/mapPermissionToBlock.ts` (source `'permission'`) and `tb-mobile:utils/mapPromptToBlock.ts` (source `'prompt'`, which renders no options for a form, multi or text shape).

### 7.2 Per provider

| Provider | Streamer sends | Mobile scrape | So a card on the phone is… |
|---|---|---|---|
| Claude Code | `permission` and `question` cards | Fallback for numbered `?` menus; rejects Yes / No gates | Normally the streamer's; a scrape only when no server card is active |
| Codex | `permission` cards for every detected prompt | Has its own trust-gate parser and can card numbered pickers | Either; check the log |
| Copilot CLI (unmerged) | Nothing | Whether any Copilot screen matches is **[unknown]**: the shell card has a `?` line and a matching footer, but its Yes / No labels hit the rejection rule | A mobile scrape, if anything |
| Cursor | Nothing | **[unknown]**, no screen captured | A mobile scrape, if anything |

### 7.3 How to tell which one you are looking at

Grep the streamer log before reasoning about a card. **[code]**

- `ws.broadcast_permission` and `ws.broadcast_question` (`sessions.handlers.ts:1455`, `:1310`) are logged for every card the streamer broadcasts, with the subscriber count.
- `ws.replay_permission` and `ws.replay_question` mark a card re-sent to a late subscriber.
- Codex adds `codex.gate_prompt`, `codex.command_approval`, `codex.picker_prompt`, `codex.usage_limit` and `codex.gate_auto_answer`.
- Claude Code's per-chunk decision is logged at debug level as `pty.prompt_detect`.

No such line for the session and time in question means the card was scraped on the device.

## 8. Gaps and open questions

Each item names the provider and the evidence.

1. **Claude Code — option descriptions missing from screen cards.** `detectQuestionFromScreen.ts:160` emits `description: ""`; PR #1012 is open. **[code]**
2. **Claude Code — multi-select, multi-question and free-text answers have no card path.** `answersToKeystrokes.ts:43` throws `UnsupportedPromptShapeError`; no producer emits `inputMode: "text"`. **[code]**
3. **Claude Code — multi-question screen cards show one tab.** `detectQuestionFromScreen.ts:206` always returns a single question with an empty header. **[code]**
4. **Claude Code — usage-limit screens are not detected.** No detector found; screen shape **[unknown]**.
5. **Claude Code — no raw fixture for the startup choice or the unboxed picker.** Both detectors rest on a measurement recorded only in comments. **[code]**
6. **Claude Code — transcript cards expire after 60 seconds.** `processJsonlQuestions`, `src/server.ts:3175`. Whether a question the user leaves open longer loses its card on the client is **[unknown]**.
7. **Codex — structured questions unreachable.** `STOP-T7.md:9`–`:15`; the CLI's flag is off and no detector exists. **[code]**
8. **Codex — contradictory comments on whether a hooks-gate digit needs Enter.** `codexScreen.ts` above `CODEX_HOOKS_GATE_REGEX` versus `resolveGateAnswer`. Current behaviour **[unknown]**.
9. **Codex — picker descriptions discarded and wrapped prompts truncated.** `detectCodexPicker`, `codexScreen.ts:184`; the sign-in test asserts the truncated prompt. **[code]**
10. **Codex — command-approval and usage-limit fixtures have no stated capture.** `__tests__/codex-pty-runner.test.ts:61`, `:743`. **[code]**
11. **Codex — server-side staleness check is skipped.** `sessions.handlers.ts:1732`; the runner is the only guard against answering a closed gate. **[code]**
12. **Copilot CLI — no detection at all, on an unmerged branch.** `src/copilot-pty-runner.ts:30`, `capabilities.ts:154` on `feat/copilot-provider`. **[branch]**
13. **Copilot CLI — its numbered cards collide with the `AskUserQuestion` footer marker.** `ASK_MENU_FOOTER_RE`, `detectPermissionGate.ts:259`; a Copilot detector cannot reuse `detectGateScreen` unchanged. **[draft 2026-10-05]**
14. **Copilot CLI — a structured source exists and is unused.** Permission and `ask_user` events in the CLI's session event log. **[draft 2026-10-05]**
15. **Copilot CLI — login, update, quota and Escape behaviours uncaptured.** **[unknown]**
16. **Cursor — nothing known about its prompts.** No fixture; `capabilities.ts:128`. **[unknown]**
17. **All providers — a card on the phone can be a device-side scrape.** `tb-mobile:utils/parseQuestionBlock.ts:211`. **[code]**
18. **Mobile — a status flip may replace the server card with a scraped one and re-enable sending, so text is typed into an open menu.** Filed in the mobile repository as issue #1248 (P3, unconfirmed). **[transcript 2026-10-04]**
19. **Mobile — whether Copilot or Cursor screens scrape into a card at all.** **[unknown]**
