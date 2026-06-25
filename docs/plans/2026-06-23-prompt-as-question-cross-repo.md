# Promote blocked PTY prompts into structured questions; remove RawKeyBar (streamer + mobile)

Run from `/Users/ronenmars/Desktop/dev/ai-tools/` (parent of both repos). Work in BOTH worktrees:
- **Streamer:** `tb-streamer/.worktrees/feat/structured-askuserquestion` (branch `feat/structured-askuserquestion`)
- **Mobile:** `tb-mobile/.worktrees/fix/chat-flow-states` (branch `feat/live-chat-with-flow-fixes`)

## Goal

Drop `RawKeyBar` (manual raw-keystroke buttons) entirely. Instead, whenever the PTY is blocked on a
prompt — including UNSTRUCTURED ones (shell `[y/N]`, plugin/CLI pickers) that aren't AskUserQuestion
or OSC-777 permission gates — the streamer scrapes the prompt into the existing structured event
shape and broadcasts it, so mobile renders a normal `QuestionCard` with tappable options. A `y/N`
prompt shows "Yes"/"No"; anything else shows the scraped option labels as-is.

Net: ONE UI for all blocking prompts (QuestionCard); no raw-key bar.

## What ALREADY exists on this branch (do NOT rebuild — verified)

Commit `f4a636e` already implements live-stream prompt detection:
- `detectLivePrompts` (`pty-manager.ts:627`) scrapes the rendered headless screen and broadcasts,
  from the LIVE stream (not JSONL): `question` (AskUserQuestion) and `permission` /
  `permission_cancelled` (OSC-777 gates, shape `{prompt, options:[{index,label}]}`, `types.ts:115-126`).
- `permissionAnswerKeys(index)` → `"${index}\r"` (answer by ON-SCREEN number, not 1-based) —
  `services/questions/permissionAnswerKeys.ts`.
- Services: `detectPermissionGate.ts` (`scrapePermissionGate`, `hasPermissionOsc`),
  `detectQuestionFromScreen.ts`.
- Mobile ALREADY consumes both: `hooks/useActiveQuestion.ts:27,51` folds `question` + `permission`
  into one `QuestionCard`-renderable block with a `source` discriminant; `components/terminal/QuestionCard.tsx`
  renders `{question, options[{label}]}` as tappable rows; answered via `/input { keys }`.
- (There may be an uncommitted temp diagnostic log in `detectLivePrompts` — harmless; leave it.)

**The ONLY net-new detection is the unstructured shell prompt.** Everything else (event shapes,
mobile rendering, answer-by-keystroke) is built. Reuse it.

---

## PART A — STREAMER: scrape unstructured prompts into a structured event (do first)

1. **New detector `src/services/questions/detectShellPrompt.ts`** — a PURE function over the
   rendered tail (`getOutputLines`) returning `{ prompt, options:[{index,label, answerKeys}] } | null`.
   - Conservative / false-positive-tolerant (a spurious card is recoverable; a missing one strands
     the user — matches existing code philosophy). Detect only when the last non-blank rendered line
     matches a tight pattern: `[y/N]`, `(y/n)`, `[Y/n]`, `Press enter`, `Continue?`, a numbered CLI
     menu, trailing `❯`/`>` with NO Claude box, etc. Unit-test the matcher hard.
   - y/N family → options `[{label:"Yes", answerKeys:"y\r"}, {label:"No", answerKeys:"n\r"}]`.
   - Numbered prompts → scrape on-screen numbers like `scrapePermissionGate`; answer via
     `permissionAnswerKeys(index)`.
   - Otherwise → present the raw prompt line(s) as labels with their literal answer key.

2. **Wire into `detectLivePrompts` (`pty-manager.ts:627`)** — after the existing permission +
   AskUserQuestion branches: if neither `oscPermission` nor `hasAskFooter` fired but the shell-prompt
   detector matches, broadcast it REUSING the existing transport. **Prefer emitting the existing
   `question`/`permission`-shaped event** so mobile renders it with zero new event handling. Track
   open/close like `permissionOpen` (add a `shellPromptOpen` set; clear on resolve / marker-return /
   input). De-dupe by content key (mirror `lastScreenQuestionKey`).

3. **Answer mapping** — numbered → `permissionAnswerKeys(index)` (`"${index}\r"`); y/N → `y\r`/`n\r`.
   Encode the literal answer keystroke in the broadcast option so mobile sends correct bytes via
   `/input { keys }` without special-casing. **Own the y/N→Yes/No label + answer-key mapping on the
   streamer** (so all clients benefit; mobile stays dumb).

4. **Types (`src/types.ts`)** — if reusing `question`/`permission` shapes verbatim, NO new type. If a
   distinct `prompt` event is cleaner, mirror the `permission` shape (additive only;
   `docs/compatibility/tb-mobile.md`). Prefer reuse → smallest diff.

5. **Tests (`__tests__/`, vitest):** `detectShellPrompt` matches `[y/N]`/`(y/n)`/numbered menus,
   returns `null` for prose / Claude's own box; y/N → Yes/No options w/ correct answer keys;
   numbered → on-screen indices. Integration: rendered tail with a shell prompt → broadcast carries
   the structured shape; input clears it. `npm run lint && npm test` green.

---

## PART B — MOBILE: remove RawKeyBar; render the prompt as a QuestionCard (after streamer)

1. **Delete RawKeyBar** — remove `<RawKeyBar .../>` from `components/conversation/LiveConversationView.tsx:245`
   and `components/terminal/TerminalView.tsx:65`; remove the imports; delete
   `components/terminal/RawKeyBar.tsx`. Keep the underlying `/input { keys }` mutation if QuestionCard
   answers share it.

2. **Consume the new prompt as a question** — `hooks/useActiveQuestion.ts` already folds `question` +
   `permission` into one block. If the streamer emits the unstructured prompt as `question`/`permission`-shaped,
   it flows to `QuestionCard` automatically — verify. y/N → "Yes"/"No": if the streamer already mapped
   labels, render as-is; otherwise show labels as-is (the Yes/No prettifier is NOT critical — do the
   simple as-is render first). Tapping an option sends its answer keystroke via the existing
   `/input { keys }` mutation (same path permission answers use).

3. **Tests (jest; run with `--testPathIgnorePatterns="/node_modules/"`):** RawKeyBar no longer
   rendered anywhere (file removed); an incoming shell-prompt event renders a QuestionCard; tapping
   sends the correct keys. `tsc --noEmit` + eslint clean on touched files.

---

## Cross-repo constraints

- Reuse the existing `question`/`permission` WS shapes for the unstructured prompt (prefer no new
  event). Additive only — no renamed/removed endpoints, fields, status strings, WS types
  (`docs/compatibility/tb-mobile.md`). **Streamer first, then mobile.**
- ONE place owns the y/N→Yes/No label + answer-key mapping (streamer recommended).
- Mobile degrades gracefully against an older streamer that doesn't emit the prompt (simply no card —
  same as today minus RawKeyBar).
- Minimum viable change; reuse `detectLivePrompts`, `scrapePermissionGate`, `permissionAnswerKeys`,
  `useActiveQuestion`, `QuestionCard`. Do NOT commit — leave changes in both worktrees for review;
  report file:line diffs + test results.

## End-to-end verification

1. Build + run the streamer: `node dist/cli.cjs serve --port 8766 --verbose` (from its worktree).
2. From the app, in BOTH chat and terminal view:
   - Run a Bash command that does `read -p "Continue? [y/N] "` → a **QuestionCard with Yes/No**
     appears (THE win — previously needed RawKeyBar); tapping Yes sends `y\r` and unblocks; card clears.
   - A numbered CLI picker → QuestionCard with the scraped numbered options; tapping sends the
     on-screen number.
   - Structured AskUserQuestion / OSC-777 permission gate → unchanged (already worked); RawKeyBar gone.
   - Claude mid-response → no card. Idle → no card.
3. RawKeyBar is absent from the UI everywhere.
