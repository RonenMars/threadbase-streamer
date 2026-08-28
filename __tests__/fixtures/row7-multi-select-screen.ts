// Rendered screens captured from a live Claude Code 2.1.247 rig (#721 row 7),
// replayed through the same headless terminal getOutputLines() reads
// (pty-shared: 120x40, scrollback 1000) and stored as the line arrays the
// detector actually receives — not raw PTY bytes.
//
// The form is a multi-select AskUserQuestion: each selectable option carries a
// "[ ]" checkbox, the escape hatch ("Chat about this") does not, and the tab
// strip above the question shows the form has two questions. Before the fix the
// detector published this as a single-select menu and the answer route wrote a
// bare "\r" into it, toggling a checkbox instead of submitting.

// row 7, before the answer: every option unticked.
export const MULTI_SELECT_SCREEN: string[] = [
  " ▐▛███▛█   Claude Code v2.1.247",
  "▝▜██████▀  Sonnet 5 with low effort · Claude Max",
  "  ▝▝ ▝▝    /…/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad/proj-170",
  "",
  " ⚠ 2 MCP servers need authentication · run /mcp",
  "",
  "❯ Use the AskUserQuestion tool right now to ask me TWO questions in a single call. Set multiSelect true on both. Give   ",
  "  each question two options. Do not do anything else first.                                                             ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☐ Languages  ☐ Environments  ✔ Submit  →",
  "",
  "Which languages should be used?",
  "",
  "❯ 1. [ ] Python",
  "  Use Python",
  "  2. [ ] JavaScript",
  "  Use JavaScript",
  "  3. [ ] Type something",
  "     Next",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

// row 7, after the answer: option 1 ticked, menu still up.
export const MULTI_SELECT_SCREEN_TOGGLED: string[] = [
  " ▐▛███▛█   Claude Code v2.1.247",
  "▝▜██████▀  Sonnet 5 with low effort · Claude Max",
  "  ▝▝ ▝▝    /…/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad/proj-170",
  "",
  " ⚠ 2 MCP servers need authentication · run /mcp",
  "",
  "❯ Use the AskUserQuestion tool right now to ask me TWO questions in a single call. Set multiSelect true on both. Give   ",
  "  each question two options. Do not do anything else first.                                                             ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Languages  ☐ Environments  ✔ Submit  →",
  "",
  "Which languages should be used?",
  "",
  "❯ 1. [✔] Python",
  "  Use Python",
  "  2. [ ] JavaScript",
  "  Use JavaScript",
  "  3. [ ] Type something",
  "     Next",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

// row 7b, a second run of the same form.
export const MULTI_SELECT_SCREEN_B: string[] = [
  " ▐▛███▛█   Claude Code v2.1.247",
  "▝▜██████▀  Sonnet 5 with low effort · Claude Max",
  "  ▝▝ ▝▝    /…/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad/proj-170",
  "",
  " ⚠ 2 MCP servers need authentication · run /mcp",
  "",
  "❯ Use the AskUserQuestion tool right now to ask me TWO questions in a single call. Set multiSelect true on both. Give   ",
  "  each question two options. Do not do anything else first.                                                             ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☐ Languages  ☐ Platforms  ✔ Submit  →",
  "",
  "Which languages do you want to use?",
  "",
  "❯ 1. [ ] Python",
  "  General-purpose scripting language",
  "  2. [ ] JavaScript",
  "  Web and Node.js scripting language",
  "  3. [ ] Type something",
  "     Next",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

// row 7b, after the answer.
export const MULTI_SELECT_SCREEN_B_TOGGLED: string[] = [
  " ▐▛███▛█   Claude Code v2.1.247",
  "▝▜██████▀  Sonnet 5 with low effort · Claude Max",
  "  ▝▝ ▝▝    /…/5a89c66b-099c-4812-a0d1-8d11845903b3/scratchpad/proj-170",
  "",
  " ⚠ 2 MCP servers need authentication · run /mcp",
  "",
  "❯ Use the AskUserQuestion tool right now to ask me TWO questions in a single call. Set multiSelect true on both. Give   ",
  "  each question two options. Do not do anything else first.                                                             ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Languages  ☐ Platforms  ✔ Submit  →",
  "",
  "Which languages do you want to use?",
  "",
  "❯ 1. [✔] Python",
  "  General-purpose scripting language",
  "  2. [ ] JavaScript",
  "  Web and Node.js scripting language",
  "  3. [ ] Type something",
  "     Next",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];
