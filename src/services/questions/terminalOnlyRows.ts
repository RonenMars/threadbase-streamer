import type { AskOption } from "../../types";

// Claude Code's AskUserQuestion menu always appends two rows of its own after
// the model's options: a free-text field and an escape hatch. They are terminal
// affordances, not choices the model offered, so a screen-scraped card carries
// them in `options` while a structured (JSONL) card does not.
const TYPE_ROW_RE = /^type something\.?$/i;
const TERMINAL_ONLY_ROW_RE = /^(type something\.?|chat about this)$/i;

/** The free-text field row, as opposed to "Chat about this". */
export const isTypeRow = (label: string): boolean => TYPE_ROW_RE.test(label.trim());

export const isTerminalOnlyRow = (label: string): boolean =>
  TERMINAL_ONLY_ROW_RE.test(label.trim());

/** How many options the model actually offered. */
export const countRealOptions = (options: AskOption[]): number =>
  options.filter((o) => !isTerminalOnlyRow(o.label)).length;
