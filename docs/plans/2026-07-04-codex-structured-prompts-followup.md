# Follow-up: Codex Structured Prompt Cards (Permission Gates + AskUserQuestion)

## Context

`2026-07-03-codex-live-session-support.md` shipped Codex CLI live-session
support end-to-end: a user can start, watch, and interact with a Codex
session from `tb-mobile` (tb-streamer PR #159, tb-mobile PR #263). While
verifying that end-to-end claim, two gaps were identified in the mobile
experience relative to Claude Code sessions. This document scopes the one
gap that still needs work; the other turned out to already be closed.

**Already shipped — not part of this follow-up:** a Codex provider badge on
session rows. [tb-mobile#08fee20](https://github.com/RonenMars/threadbase-mobile/commit/08fee20f074552bcc085e64c546df7cf409dbd4b)
added a `Codex` badge to `ConversationListItem`/`ConvRow` for historical
conversations. Since `ConvRow` reads `conv.provider` generically and live
Codex sessions already carry `provider: "codex-cli"` (from the live-session
support plan's Phase 1 plumbing), the badge renders for live Codex sessions
too — no additional mobile work needed here.

**Actual gap — scope of this document:** structured prompt cards. Claude
Code sessions get a native `QuestionCard` UI for permission gates (`Claude
needs permission to run X`) and `AskUserQuestion` menus. Codex sessions do
not — `CodexPtyRunner` never emits the `permission`/`question` WebSocket
events, so any Codex-side approval or choice prompt only appears as raw
terminal text the user has to type into manually, with no tappable card.

## How Claude's implementation works today

All permalinks below are pinned to `threadbase-streamer` `main` @
[`a375b6d8`](https://github.com/RonenMars/threadbase-streamer/commit/a375b6d8032662e515b9ba35e354ce5b8a464486)
and `threadbase-mobile` `main` @
[`aec6e746`](https://github.com/RonenMars/threadbase-mobile/commit/aec6e7462daaeb8239cc48b46d45abdaf3c0dbdf) —
both confirmed to contain every referenced file at the time of writing.

### Server side (tb-streamer) — where the Codex-specific work would go

- [`src/pty-manager.ts` lines 641-774](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/pty-manager.ts#L641-L774)
  (`detectLivePrompts`) — the orchestrator. Cheap raw-chunk triggers (an OSC
  777 test, an `Enter to select` footer substring test, and a shell-prompt
  regex hint) gate an expensive rendered-screen read (`getOutputLines`),
  then three detectors run in priority order: permission gate >
  AskUserQuestion menu > unstructured shell prompt. Each open prompt's
  *closure* is detected by watching for `CLAUDE_PROMPT_MARKERS` (`╭`, `❯`)
  to reappear on screen.
  **Not directly reusable** — the closure signal is Claude-specific. Codex's
  own readiness signal is the literal string `"Ready"` in its status bar,
  already captured as `CODEX_PROMPT_READY_TEXT` in
  [`src/codex-pty-runner.ts:32`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/codex-pty-runner.ts#L32) —
  a Codex orchestrator would key closure off that instead.

- [`src/services/questions/detectPermissionGate.ts`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/detectPermissionGate.ts) —
  keyed on a **Claude-specific OSC 777 escape**
  (`\x1b]777;notify;Claude Code;...`, line 41) as the deterministic
  open-trigger, then scrapes numbered options + a `❯` cursor from the
  rendered screen.
  **Not reusable as-is** — the OSC signal is Claude Code's own notify
  escape. Whether Codex emits any analogous deterministic marker for its
  `--ask-for-approval` gate is unverified (see Open Questions below). The
  rendered-screen option-scraping technique (regex over "N. label" rows)
  is a reusable *pattern*, not reusable code, since Codex's box-drawing and
  option wording differ.

- [`src/services/questions/detectQuestionFromScreen.ts`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/detectQuestionFromScreen.ts) —
  detects Claude's `AskUserQuestion` tool menu via a specific footer string
  (`"Enter to select · Tab/Arrow keys to navigate · Esc to cancel"`, lines
  27-28) plus numbered options ending in `?`.
  **Not reusable** — tied to Claude's exact footer wording. No confirmed
  Codex equivalent; Codex's interaction model appears to be more
  shell-command-approval-centric than multi-choice-tool-centric, but this
  is unverified, not an assumption to build on.

- [`src/services/questions/detectShellPrompt.ts`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/detectShellPrompt.ts) —
  **already provider-agnostic by design**. It explicitly bails via
  `CLAUDE_CHROME_RE`
  ([line 52](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/detectShellPrompt.ts#L52))
  when Claude's own box-drawing/footer chrome is on screen, then recognizes
  three generic patterns anchored on the last non-blank rendered line: a
  y/N hint, a numbered menu, or a bare "press enter to continue."
  **This is the most promising reusable building block** — but with a real
  caveat: Codex's own banner also uses box-drawing characters
  (`╭─╮`/`│`/`╰─╯`, confirmed in the live-session-support plan's Phase 0
  probe), so `CLAUDE_CHROME_RE`'s box-glyph members would falsely suppress
  detection on a Codex screen. A Codex variant needs its own
  chrome-exclusion pattern, not a literal reuse of this file's constant.

- [`src/services/questions/resolveAnswer.ts`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/resolveAnswer.ts)
  and [`answersToKeystrokes.ts`](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/services/questions/answersToKeystrokes.ts) —
  pure keystroke-resolution logic once a question/gate is already detected,
  with zero provider assumptions.
  **Fully reusable as-is.**

- `PTYManagerOptions` callbacks (`onPermissionChange`, `onLiveQuestion`,
  `onLiveQuestionGone`) are already declared on `CodexPtyRunner`'s
  constructor for shape-compatibility
  ([`src/codex-pty-runner.ts` ~101-105](https://github.com/RonenMars/threadbase-streamer/blob/a375b6d8032662e515b9ba35e354ce5b8a464486/src/codex-pty-runner.ts#L101-L105))
  but are never invoked. **The wiring target already exists** — only the
  Codex-side detection logic that calls them is missing.

### Client side (tb-mobile) — no changes needed here

- [`hooks/useActiveQuestion.ts`](https://github.com/RonenMars/threadbase-mobile/blob/aec6e7462daaeb8239cc48b46d45abdaf3c0dbdf/hooks/useActiveQuestion.ts) —
  listens for the generic WebSocket event types `question`,
  `question_cancelled`, `permission`, `permission_cancelled`. Zero
  Claude-specific logic; works for any provider that emits these events.
- [`utils/mapPermissionToBlock.ts`](https://github.com/RonenMars/threadbase-mobile/blob/aec6e7462daaeb8239cc48b46d45abdaf3c0dbdf/utils/mapPermissionToBlock.ts)
  / `mapAskQuestionToBlock.ts` — pure wire-shape → `QuestionBlock` mapping.
  The only Claude-specific string is a cosmetic fallback label
  (`'Claude needs your permission'`, used only when `prompt` is undefined)
  — trivial to genericize later, not a blocker.

**Conclusion:** the entire mobile-side rendering pipeline (WS events →
`QuestionCard`) is already provider-agnostic. All required work for this
follow-up is server-side, in tb-streamer: build a Codex-specific detection
layer (following `detectShellPrompt.ts`'s reusable pattern-matching
approach, not `detectPermissionGate.ts`'s Claude-OSC-only approach) and wire
it into `CodexPtyRunner`'s existing, currently-unused callback slots.

## Open questions — require a live Codex probe before implementation

These are unresolved and should not be assumed one way or the other. The
original live-session-support plan's Phase 0 explicitly scoped a Codex
approval-flow probe as out of scope; that probe needs to happen first here:

1. Does Codex emit any OSC-style escape or other deterministic marker when
   a command needs approval under `--ask-for-approval`, or is the gate
   rendered-screen-only with no cheap trigger available?
2. What does Codex's `--ask-for-approval on-request` gate actually look
   like on screen — box shape, option wording, footer text? Needs a
   disposable PTY probe (same technique as the live-session-support plan's
   Phase 0: real `node-pty` spawn rendered through `@xterm/headless`,
   `codex --cd <tmp-project> --ask-for-approval on-request` with a prompt
   that triggers a shell command).
3. Does Codex have any multi-choice "pick one of several options" UI
   analogous to `AskUserQuestion`, or does its model only ever ask
   yes/no-style approval questions?

## Proposed shape of the work (once probed)

- A new `detectCodexApproval.ts` (naming TBD) module, structurally modeled
  on `detectShellPrompt.ts`'s provider-agnostic pattern-matching style —
  not on `detectPermissionGate.ts`'s Claude-OSC-only trigger.
- A Codex-appropriate prompt-closure signal, reusing
  `CODEX_PROMPT_READY_TEXT` the same way Claude's orchestrator reuses
  `CLAUDE_PROMPT_MARKERS` to detect a gate closing.
- Wiring into `CodexPtyRunner`'s existing `onPermissionChange` /
  `onLiveQuestion` / `onLiveQuestionGone` callback slots — no new callback
  shape needed, since `PTYManagerOptions` already declares them.
- **No tb-mobile changes required** — the WS event types and rendering
  pipeline are already generic.

This document is scoping/research only. No code changes are proposed or
made here; implementation is future work gated on the open questions above.
