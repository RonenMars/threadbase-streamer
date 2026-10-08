# GitHub Copilot CLI — how it asks questions

Investigated 2026-10-05 against **GitHub Copilot CLI 1.0.91** (installed at `/opt/homebrew/bin/copilot`; the Homebrew cask directory is 1.0.88 and the CLI self-updated to 1.0.91, while the vendor-intake note for PR #1002 says 1.0.88, so intake predates the version measured here).
Every claim below is tagged **LIVE** (captured by driving a real `copilot` in a PTY and reading the rendered screen and `~/.copilot` on disk), **DOCUMENTED** (`copilot --help` / `copilot help permissions` only) or **UNPROVEN**.

## 1. Summary

1. Copilot asks in **three visually different families**, all drawn by one Ink TUI in the alternate screen:
   - **Boxed numbered cards** — folder trust, shell, file write, URL, path outside the project, MCP tool, plan approval. Footer is `↑/↓ to navigate · enter to select · esc to cancel` (plan card swaps in `ctrl+e to show full plan`).
   - **`ask_user` forms** — an *unboxed, unnumbered* picker or text box with a header `Copilot needs information.`, a possibly **tabbed multi-field** layout, and the footer `↑/↓ select · enter accept · ctrl+d decline · esc cancel`.
   - **Slash-command pickers** (`/model`) — a searchable list. Not an agent question, but a phone user can land in one.
2. **None of the streamer's four existing screen detectors recognises any of them** (0 of 52 detector×screen pairs fire; positive control passes). `COPILOT_CAPABILITIES` has `structuredQuestions: false, permissionGates: false`, so today the phone shows raw terminal text, exactly as in the screenshot that started this investigation (the trust card, with the session labelled "Working").
3. **The permission cards fail for one specific, fixable reason**: their footer contains the phrase `enter to select`, which `detectGateScreen` and `detectPickerScreen` treat as the marker of Claude's AskUserQuestion menu and refuse. Removing only that phrase from the captured footer makes the existing parser return the correct prompt and options (§7). The `ask_user` forms and the plan card are a different story: they need new detectors.
4. **Copilot writes the question to disk**, which is a much better source than the screen for everything except folder trust:
   - permissions → `permission.requested` / `permission.completed` in `~/.copilot/session-state/<id>/events.jsonl`, with a typed `kind` (`shell`, `write`, `read`/`path`, `url`, `mcp`);
   - `ask_user` → a `tool.execution_start` whose `arguments.requestedSchema` is the **full JSON-Schema form** (enums, defaults, booleans, multi-select, integers), answered by a `tool.execution_complete`;
   - plan approval → `tool.execution_start` with `toolName: "exit_plan_mode"`.
   - Folder trust leaves no event (it is asked before the session exists).
5. `copilot --acp` (Agent Client Protocol over stdio) answers `initialize` and is the vendor-supported structured route, but the shared-writer problem the Group A gate found for Claude and Codex has not been evaluated for it (§9).

## 2. Method and controls

| Item | Detail |
|---|---|
| Harness | Throwaway Node script: `node-pty` spawns `copilot --session-id <uuid>` at **120×40** (the streamer's `PTY_COLS`×`PTY_ROWS`), output is fed to `@xterm/headless`, and the rendered screen is snapshotted. A separate write for the submit `\r`, as the streamer does. |
| Isolation | Each probe ran in its own scratch cwd (never `tb-streamer`), with its own explicit session id. The real `~/.copilot` was used because auth lives there; see §10 for the side effects. |
| Disk evidence | `events.jsonl`, `workspace.yaml` per session in `~/.copilot/session-state/<id>/`, read after each probe. |
| Detector test | `detectGateScreen`, `detectPickerScreen`, `detectStartupChoiceGate`, `detectQuestionFromScreen` run (via `tsx`) on the snapshots. |
| Positive control | A Claude-style gate fed to `detectGateScreen` returns a parsed gate. So an all-`null` result on Copilot screens is the detector refusing, not the harness failing. |
| Mutation | Real Copilot shell card with `enter to select · ` removed from the footer → parses. Gutter stripped but footer left alone → still `null`. This isolates the footer as the cause. |
| Prior art searched | Claude Code, Codex and Cursor histories on this Mac, plus `docs/`. See §8. |

Evidence (not committed; contains local paths): `…/scratchpad/probe/evidence/<probe>/{snapshots.txt,raw.log,session-id.txt}`, harness `drive.mjs`, `batch.mjs`, `batch2.mjs`, `detect.ts`, `detect-controls.ts`.

### Probe index

| Probe | What it exercised | Session |
|---|---|---|
| P01 | Folder trust → shell card → Esc | `ca73b84e` |
| P02 | Compound shell (`touch … && git status`) | `a5882cc5` |
| P03 | File create | `fe257a46` |
| P04 | URL fetch | `e7e54579` |
| P05 | Read outside the project (`/etc/hosts`) | `e9a84a0e` |
| P06 / P07 | `ask_user` single enum / free text | `06dc99a6` / `0702a872` |
| P08 / P13 | Plan mode → `ask_user` → plan approval card | `0a03c86a` / `88dea479` |
| P09 | GitHub MCP tool (server had no `get_me`: no gate, not counted) | `f3c6025a` |
| P10 / P10b | `ask_user` with 5 fields: explore, then fill and submit | `28ced3ae` / `6875c63b` |
| P11 / P11b | Pick default; "Other" typed answer | `47cecbb9` / `3b7f58de` |
| P12 | `ask_user` decline (Ctrl+D) | `0cf33346` |
| P14 / P14b | "No, and tell Copilot…" (P14 was a script error, see §10) | `1cdd5380` / `660c4efd` |
| P15 | Trust → "No" | `d6a158d0` |
| P16 | `/model` picker | `e862382f` |
| P17 | Local stdio MCP server tool | `3c5d5aca` |
| P18 | Digit key on a card | `7fa55916` |

## 3. Taxonomy at a glance

| # | Kind | Triggered by | Screen family | Options (verbatim) | On disk | Tag |
|---|---|---|---|---|---|---|
| 1 | Folder trust | Launching in an untrusted cwd | Boxed numbered | `1. Yes` · `2. Yes, and remember this folder for future sessions` · `3. No (Esc)` | **Nothing** in `events.jsonl`; option 2 writes `trustedFolders` in `~/.copilot/config.json` | LIVE (P01, P15) |
| 2 | Shell command | `bash` tool | Boxed numbered | `1. Yes` · `2. Yes, and don't ask again for \`<cmd>\` in this directory (<cwd>)` · `3. No, and tell Copilot what to do differently (Esc to stop)` | `permission.requested` `kind:"shell"` | LIVE (P01, P02, P14b, P18) |
| 3 | File write | `apply_patch`/create | Boxed numbered, shows diff | `1. Yes` · `2. Yes, and don't ask again for file operations when in this directory (<cwd>)` · `3. No, and tell Copilot what to do differently (Esc to stop)` | `kind:"write"` with `fileName`, `diff`, `newFileContents` | LIVE (P03) |
| 4 | URL | `web_fetch` | Boxed numbered | `1. Yes` · `2. Yes, and approve all URLs from "<origin>" for the rest of the running session` · `3. Yes, and approve all URLs from "<origin>" permanently` · `4. No, and tell Copilot what to do differently (Esc to stop)` | `kind:"url"` | LIVE (P04) |
| 5 | Path outside project | `view` on a path outside cwd | Boxed numbered | `1. Yes` · `2. Yes, and remember this path for this session` · `3. Yes, allow file-tool read-only access to the listed directory for this session` · `4. No (Esc)` | `permissionRequest.kind:"read"`, `promptRequest.kind:"path"` + `readOnlyDirectories` | LIVE (P05) |
| 6 | MCP tool | Any non-allow-listed MCP tool | Boxed numbered | `1. Yes` · `2. Yes, and don't ask again for tool "<tool>" from "<server>" in this directory (<cwd>)` · `3. No, and tell Copilot what to do differently (Esc to stop)` | `kind:"mcp"` with `serverName`, `toolName`, `args`, `readOnly` | LIVE (P17) |
| 7 | Plan approval | `--plan` / plan mode, `exit_plan_mode` tool | Boxed numbered, **wrapped options** | `1. Accept plan and continue in Interactive execution mode (Manual Approval for this session; future defaults unchanged) (recommended)` · `2. Accept plan and continue in Autopilot execution mode` · `3. Exit to Interactive execution mode without running the plan (…)` · `4. Suggest changes` | `tool.execution_start` `toolName:"exit_plan_mode"` (`summary`, `recommendedAction`); on accept a `session.mode_changed` `plan → interactive` | LIVE (P13) |
| 8 | `ask_user`, single field | Model calls `ask_user` | Unboxed picker or text box | enum: values + `Other (type your answer)`; free text: bare input box | `tool.execution_start` with `requestedSchema` | LIVE (P06, P07, P11b) |
| 9 | `ask_user`, multi-field | Same, several properties | Unboxed, **tab bar** `[Color] Confirm Toppings Age Name` | per field: enum / `Yes`·`No`·`Other` / checklist / numeric input / text input | `requestedSchema` with 5 properties | LIVE (P10, P10b) |
| 10 | `/model` picker | User types `/model` | Unboxed searchable list | model names + `Search models…` | none | LIVE (P16) |
| — | Login/device-flow, update prompt, quota/rate-limit, assisted-approval judge | — | — | — | — | **UNPROVEN** (§9) |

## 4. The boxed numbered cards (kinds 1–7)

Real capture, shell command (P02; local path shortened):

```
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

Plan approval card (P13) — the one with wrapped, multi-line options and a different footer:

```
│ Plan Ready for Review                                                         │
│  - Add  README.md  at the root of the currently empty target folder …         │
│ ❯ 1. Accept plan and continue in Interactive execution mode (Manual Approval  │
│   for this session; future defaults unchanged) (recommended)                  │
│   2. Accept plan and continue in Autopilot execution mode                     │
│   3. Exit to Interactive execution mode without running the plan (Manual …    │
│   unchanged)                                                                  │
│   4. Suggest changes                                                          │
│ ↑/↓ to navigate · enter to select · ctrl+e to show full plan · esc to cancel  │
```

Structural facts (all LIVE):

- Round-box border `╭╮╰╯│`, a title line (the model's `intention`, or `Confirm folder trust`, `Allow path access`, `Plan Ready for Review`), a rule, a body, a question line, then options. Some bodies nest a second box (the command, the URL, the path).
- Options are `N.`-numbered; the cursor is `❯` and is **on option 1 at paint time**, with no preselection beyond that.
- The option text is **dynamic**: it embeds the command identifier (`touch`, `rm and mkdir`), the cwd, the URL origin, the tool and server name. A UI must not key on option text. It can key on position and on the `Yes`/`No` prefix.
- Option counts differ by kind: 2 (shell with a read-only command, P01), 3, 4. A plain `echo` shell card had **only two options** (`Yes` / `No, and tell…`), no "don't ask again".
- The card replaces the composer. While it is open the bottom footer (`← open sidebar · Interactive · Manual Approval …`) is gone.
- A `┃` scrollbar glyph sits in the right margin of the transcript region above the card in plan mode (P13); expect it in scraped lines.

### Keystroke contract

| Key | Effect | Evidence |
|---|---|---|
| `↓` / `↑` | Move the `❯` cursor one option | P14b, P15 |
| digit `N` | **Jumps the cursor to option N but does not confirm** | P18: pressed `3`, cursor moved to 3, card stayed open, no `permission.completed` until teardown |
| `Enter` | Confirms the option under the cursor | P01–P05, P13, P17 |
| `Esc` | Denies and **aborts the turn** | P01: `permission.completed {kind:"cancelled", reason:"Session aborted"}` then an `abort {reason:"user_initiated"}` event |
| Enter on option 3 ("No, and tell Copilot…") | The option label becomes an **inline text field**; typing replaces the label (`3. use mkdir instead (Esc to stop)`), Enter sends it | P14b |
| Enter on "No" in trust | Copilot **exits** (alternate screen torn down, process ends) | P15; the session dir is left with `checkpoints files research` and no `events.jsonl` |

A phone answer for card option *k* from cursor *c* is therefore `(k-c)` arrow presses then `\r`, or digit `k` then `\r`. Either is LIVE-supported by the cursor behaviour; the end-to-end "send digit+`\r` and see the action execute" was not run for the digit form (only the cursor move was).

### What the answer does (`permission.completed.result.kind`)

| User action | `result` | Evidence |
|---|---|---|
| Option 1 | `{kind:"approved"}` | P02–P05, P17 |
| "Don't ask again…" | `{kind:"approved-for-location", approval:{kind:"commands", commandIdentifiers:["touch"]}, locationKey:"<cwd>"}`; **persisted** to `~/.copilot/permissions-config.json` under `locations.<cwd>.tool_approvals` | P14 |
| "No, and tell Copilot…" + text | `{kind:"denied-interactively-by-user", feedback:"use mkdir instead"}`; the model continues **in the same turn** and raised a new `mkdir` card | P14b |
| Esc / Ctrl+C | `{kind:"cancelled", reason:"Session aborted"}` | P01, P18 teardown |

`decisionSource` is `"human_response"` for all of the above.

## 5. `ask_user` forms (kinds 8–9)

`ask_user` is a built-in tool whose system-prompt block says to use it for clarifying questions instead of plain text (LIVE: every `system.message` carries an `<ask_user>` block). It takes `message` + `requestedSchema` (a JSON-Schema object). `--no-ask-user` removes the tool (DOCUMENTED).

Single enum (P06, the model supplied `default: "blue"`, and the cursor started on `blue`):

```
 ○ Asking user  Waiting for response                                  1m 56s
────────────────────────────────────────────────────────────────────────────
 Copilot needs information.
 Choose your preferred color before we continue.
 Favorite color:
 Pick one color.
   red
   green
 ❯ blue
   Other (type your answer)
 ↑/↓ select · enter accept · ctrl+d decline · esc cancel
────────────────────────────────────────────────────────────────────────────
```

Free text (P07) is the same header with a bare input between two rules and the footer `enter accept · ctrl+d decline · esc cancel`.

Multi-field (P10b) adds a **tab bar** and per-field widgets:

```
  Color   Confirm  [Toppings]  Age   Name
 Toppings:
   ✓ cheese
 ❯ ✓ ham
   • olives
   • Other (type your answer)
 ↑/↓ select · space toggle · enter accept · tab next · shift+tab prev · ctrl+d decline · esc cancel
```

| Schema property | Widget | Footer additions |
|---|---|---|
| `string` + `enum` (or `oneOf:[{const,title}]`) | Option list + `Other (type your answer)` | — |
| `boolean` | `Yes` / `No` / `Other (type your answer)` | — |
| `array` of enum | Checklist: `•` unchecked, `✓` checked, `Other` | `space toggle` |
| `integer` | Text input with `↑/↓ adjust` | — |
| `string` | Text input | — |

Behaviour (all LIVE unless noted):

- **Footer tokens vary with state**, so match the stable `ctrl+d decline` token, not the whole line. `tab next` appears only with more than one field; `shift+tab prev` only after the first; `space toggle` only on a multi-select; `↑/↓ adjust` on a number.
- **Enter on a single-field form submits at once.** P11: Enter on the default `blue` accepted `blue` immediately.
- **Enter on a field in a multi-field form advances to the next tab**; Enter on the last field submits. P10b submitted with the final Enter and the model replied with all five values.
- **Cursor `❯` and selection `✓` are different things.** The first `↓` from the default `blue` moved the cursor to `Other` and left a `✓` on `blue` (P11 snapshot).
- **"Other" reveals an inline input**: the row relabels to `Other (type your answer below)` and a line `❯ Type your answer...` appears *below the footer*. Typing goes straight into it; Enter submits (P11b: answered `purple`, `User responded: purple`).
- **The cursor starts on `default`** when the schema has one, otherwise on the first option (P06 vs P10).
- **Space does nothing on a single-select** (P10).
- Spacing and rule layout differ between forms; only `Copilot needs information.` and the footer were present in every capture.
- Above the form the transcript shows `○ Asking user  Waiting for response  <elapsed>`, the same line for every `ask_user`.

### Answer results (`tool.execution_complete`)

| Action | `result.content` | `toolTelemetry.properties.elicitation_action` |
|---|---|---|
| Submit | `User responded: color=green, confirm=true, toppings=cheese, ham, age=42, name=Alex` (+ `detailedContent` one field per line) | `accept` |
| Ctrl+D | `The user is not available to respond and will review your work later. Work autonomously and make good decisions…` — the model is told the user is **unavailable**, not that they refused | `decline` |
| Session abort (my Ctrl+C teardown) | `User cancelled the request.` | `cancel` |

`elicitation_field_types` lists the widgets used (`boolean`, `enum`, `integer`, `multi-enum`, `string`), which is a free classifier.
`Esc` on an `ask_user` form was **not** exercised on its own (UNPROVEN); the `cancel` result above came from aborting the session.

### Plan mode also asks through `ask_user`

In `--plan` mode (P08) the agent explored the folder and then raised an `ask_user` with a `oneOf` enum ("What should the README explain?") before ever presenting a plan. With "do not ask me any questions" in the prompt (P13) it skipped straight to the plan card. So the plan card (kind 7) can be preceded by any number of `ask_user` forms.

## 6. Where Copilot keeps the history

`~/.copilot/` (LIVE; `COPILOT_HOME` overrides it, DOCUMENTED):

| Path | Content | Useful for questions |
|---|---|---|
| `session-state/<uuid>/events.jsonl` | One JSON event per line | **Yes — primary source** |
| `session-state/<uuid>/workspace.yaml` | `id, cwd, client_name, name, created_at, updated_at` | Maps session to cwd |
| `session-state/<uuid>/inuse.<pid>.lock` | Live-process marker | Tells a running session from a dead one |
| `session-store.db` (SQLite) | `sessions, turns, assistant_usage_events, …` + FTS | No question data |
| `config.json` | `trustedFolders` (written by trust option 2 only) | Trust state |
| `permissions-config.json` | Persisted "don't ask again" approvals, keyed by cwd | Standing approvals |
| `logs/process-<epoch>-<pid>.log` | Plain-text process log | Nothing beyond one `Ignoring duplicate permission response for completed request` line |

Relevant event types in `events.jsonl`:

| Event | Meaning |
|---|---|
| `permission.requested` | `data.requestId`, `data.permissionRequest` (rich: command segments, diff, url, mcp args), `data.promptRequest` (the trimmed UI payload), `agentMode`, `permissionMode` |
| `permission.completed` | `requestId`, `result.kind`, `decisionSource` |
| `tool.execution_start` | For `ask_user` and `exit_plan_mode` this **is** the pending question; `arguments` holds the schema/summary |
| `tool.execution_complete` | Same `toolCallId`; carries the answer |
| `session.mode_changed` | `interactive`/`plan`/`autopilot` transitions |
| `session.permissions_changed` | The allow-all toggle |
| `abort` | `reason:"user_initiated"` |

**Pending detection from disk**: a `permission.requested` with no `permission.completed` for the same `requestId`, or a `tool.execution_start` for `ask_user`/`exit_plan_mode` with no `tool.execution_complete` for the same `toolCallId`.
The `toolCallId` links the question to the earlier assistant turn (`tool.execution_start` precedes `permission.requested` for shell).

What disk does **not** give: folder trust (asked before the session exists), the exact option wording and count (derived inside the TUI), the cursor position, and any signal that the TUI is in a slash picker.

## 7. What the streamer does with these today

`src/copilot-pty-runner.ts` header: *"No trust bypass, Claude flags, TUI scraping, or borrowed transcript watcher… users handle trust/auth prompts in the terminal."*
`COPILOT_CAPABILITIES` (`src/services/providers/capabilities.ts`): `structuredQuestions: false`, `permissionGates: false`, "No captured TUI yet" — this report is that capture.

Detector results on the 13 captured screens (trust, two shell cards, file write, URL, path, MCP, plan, four `ask_user` shapes, `/model`): **every detector returned `null` on every screen, 52 of 52.**

| Detector | Why it refuses Copilot |
|---|---|
| `detectGateScreen` | Bails when any line matches `/Enter to select/i` (its AskUserQuestion exclusion). **Copilot's own footer contains `enter to select`.** Confirmed by mutation: with only `enter to select · ` removed from the footer the real shell card parses to `prompt: "Do you want to run this command?"` and the three options. |
| `detectPickerScreen` | Same `ASK_MENU_FOOTER_RE` bail; also rejects a `❯` row inside a `│` box. |
| `detectStartupChoiceGate` | Requires the footer `enter to confirm`; Copilot says `enter to select`. Its unnumbered-row logic would not match the numbered trust card anyway. |
| `detectQuestionFromScreen` | Built for Claude's AskUserQuestion layout; `ask_user` has a different header, footer and tab bar. |

Consequences for a mobile client: a Copilot session shows `Working` (no readiness signal, see the runner header) while it is blocked on any of the above, and the only way to answer is raw keys. That is exactly the screenshot.

## 8. Comparison with the other agents (from existing evidence)

| | Claude Code | Codex | Cursor | **Copilot** |
|---|---|---|---|---|
| Permission card | Numbered options, **unboxed**, footer `Esc to cancel · Tab to amend` (`detectPermissionGate.ts`) | Question cards over the `permission` WS transport; trust and hook-review gates (`codexScreen.ts`, `codexGateAnswers.ts`) | Not investigated for gates here | **Boxed**, numbered, footer `enter to select · esc to cancel` |
| Trust prompt | Unnumbered list, footer `Enter to confirm · Esc to cancel` (`detectStartupChoiceGate.ts`) | Directory-trust gate, "remember" persisted by the streamer | — | Numbered, boxed; option 2 persists in Copilot's own config |
| Structured question | `AskUserQuestion` — footer `Enter to select`; also a `tool_use` line in the JSONL (`detectAskUserQuestion.ts`) | `requestUserInput`, hidden/default-off in 0.150.1 (Group A GO/NO-GO, T7) | — | `ask_user` JSON-Schema form; question on disk as `tool.execution_start` + `requestedSchema` |
| Question visible on disk while pending | Yes for AskUserQuestion (JSONL), but a parked prompt is persisted *unsettled* and not re-armed on resume | Rollout JSONL | — | Yes, permission **and** ask_user, with explicit `requestId` |
| Digit keys | Not measured for numbered gates (on the unnumbered trust gate a digit does nothing) | — | — | **Move the cursor only**; Enter confirms |

Claude and Codex cells are taken from the repo's own detector comments and the Group A evidence (`docs/plans/2026-08-prompt-contract-program/tracks/A-fable5-high/evidence/GO-NO-GO.md`), not re-measured today.
Cursor's question surface was not investigated here: the Cursor history search found only code listings that mention an `AskQuestion` tool (nothing about Copilot).

### Prior investigations found

- This repo's `docs/plans/2026-08-prompt-contract-program/` — Claude and Codex gate probes (`PROTOCOL.md` evidence units, controls, tags). This report borrows its tags and control discipline.
- An earlier investigation (2026-09-05/06) into question handling for Claude and Codex, including the note that no login-picker detector exists.
- An earlier investigation into session sub-status: a method for capturing a live session's `terminal_output` over WebSocket and replaying it through headless xterm. Contains no Copilot content. Its method is what the harness here reproduces directly on the PTY.
- Streamer PR #1002 vendor-intake note quoting "No … structured questions, or permission-gate pars[ing]" for Copilot.
- No earlier investigation captured Copilot's TUI questions; the only earlier Copilot evidence was permission events in `~/.copilot` from unrelated sessions.

## 9. Gaps and what was not proven

- **Never exercised**: login/device-flow, "update available" prompts, quota or rate-limit screens, the `--assisted-approval` judge (needs `--experimental`), fleet/sub-agent prompts, two cards open at once, a card still open after the phone reconnects.
- **Esc on an `ask_user` form** (only session-abort was measured), and **Esc on the trust card** (P15 used "No" via Enter; the label says `No (Esc)`).
- **Validation**: typing letters into an integer field, leaving a required field empty, `Other` on a multi-select, `minItems`/`maxItems`.
- **End-to-end digit answer** (digit then `\r`) was not run; only the digit's cursor move was.
- **Narrow terminals**: all probes ran at 120 columns. Phones render wider-than-screen text via the streamer's own virtual screen, but wrapping of dynamic option text at other widths is unmeasured.
- **ACP** (`copilot --acp`): only `initialize` was sent. It returned `loadSession`, `sessionCapabilities {close, list}`, `mcpCapabilities`, and `authMethods`. Whether it raises permission requests as `session/request_permission`, whether it can *share* a session with a terminal, and how it handles `ask_user`, are all UNPROVEN. The Group A evidence shows the single-writer question decides viability for Claude and Codex and would need the same probes here.
- **Model variance**: the CLI auto-routes models (`mai-code-1.1-flash`, `gpt-6-luna` appeared), and the model decides the `ask_user` schema, so field titles, defaults and counts are not stable.

## 10. Side effects of the investigation on this machine

- Roughly two dozen throwaway sessions were created under `~/.copilot/session-state/` (all started by the harness with explicit ids, listed in §2). Nothing was done to the existing sessions, including the live one visible on the phone.
- **`~/.copilot/permissions-config.json` gained one entry** from probe P14 (a mis-keyed script pressed `↓` once and so chose option 2): `locations."<scratch>/evidence/P14-no-tell-copilot-cwd".tool_approvals = [{kind:"commands", commandIdentifiers:["touch"]}]`.
  It only approves `touch` inside a scratch directory that no longer matters. It was left in place because the file is outside this project. Remove that key to restore the file exactly.
- `config.json` `trustedFolders` was **not** changed: every trust prompt was answered with option 1 or "No", never "remember".
- Scratch cwds are under the session scratchpad and carry no repo state. A tiny stdio MCP server (`probesrv`) was passed per-run via `--additional-mcp-config`; it is not installed.

## 11. Recommendations (not implemented)

1. **Permission and trust cards first.** The cheapest win: let the gate detector accept Copilot's footer. Either narrow the AskUserQuestion exclusion so it only fires when the footer lacks `esc to cancel` *and* the options are not boxed, or add a Copilot-specific signature (boxed card + `↑/↓ to navigate · enter to select · esc to cancel` + numbered `Yes`/`No` options). Pin it with fixtures cut from the real snapshots (raw bytes, not printed views).
2. **Answer by position, never by text.** Option wording embeds the command, cwd, origin and server, so build `answerKeys` from `(target - cursor)` arrows plus `\r`. For "No, and tell Copilot…", send arrows + `\r`, then the text, then `\r` (§4).
3. **`ask_user` needs its own detector and answer encoder.** Signature: `Copilot needs information.` plus the `ctrl+d decline` footer token. Parse the tab bar for field names, and prefer `requestedSchema` from disk over the screen so the card gets real types, enums, defaults and multi-select. Encoder per widget: enum → arrows + `Enter`; boolean → same; multi-select → arrows + `Space` per choice + `Enter`; numbers/text → type + `Enter`; `Other` → arrow to the row, type, `Enter`.
4. **Use `events.jsonl` as the readiness and pending signal** for everything except folder trust. It gives an exact open/closed state per `requestId`/`toolCallId`, which fixes the "stuck on `Working` while blocked" symptom without a screen scrape. Folder trust still needs the screen (or `trustedFolders` in `config.json` as a pre-flight, which the streamer should *read*, not write).
5. **Flip `structuredQuestions`/`permissionGates` only after** 1–3 land with fixtures for version 1.0.91, following `docs/compatibility/adding-a-provider.md` ("Update the constants and add a fixture for that version").
6. **Decide separately on ACP.** It could replace scraping entirely, but it is a different transport and needs the Group A single-writer probes before it is a candidate.

Open an issue per `docs/` convention before implementing; this report is the `## Verified state` evidence for it (2026-10-05, Copilot CLI 1.0.91).
