import type { PermissionGate, PermissionOption } from "./detectPermissionGate";

// Claude Code's blocking startup choices — the workspace-trust gate above all —
// are a vertical list with NO leading numbers:
//
//   Accessing workspace:
//   C:\Users\PC\Desktop\dev\autokitteh
//   Quick safety check: Is this a project you created or one you trust? …
//   Security guide
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
//
// `scrapePermissionGate` requires `N.` on every row, so it returns null here and
// every detector built on it refuses the screen. Nothing broadcasts a card, the
// raw text falls through to the transcript, and the only way to answer from a
// phone is raw keys — on a prompt that grants read, edit and execute rights over
// a directory. Codex already raises its equivalent as a card
// (`codexGateAnswers.ts`); this is the Claude side of that.
//
// Measured against Claude Code v2.1.278 by clearing `hasTrustDialogAccepted` for
// a scratch project: the cursor starts on the FIRST option, `\x1b[B` moves it
// down one row and `\x1b[A` moves it back up, and `\r` confirms whatever the
// cursor is on. A digit does nothing — which is why these options carry explicit
// `answerKeys` rather than relying on the index.

/** Footer unique to this family. "Enter to select" is an AskUserQuestion menu. */
const CONFIRM_FOOTER_RE = /enter to confirm/i;
const ASK_MENU_FOOTER_RE = /Enter to select/i;

/** A row carrying the selection cursor, in either the Unicode or ASCII form. */
const CURSOR_ROW_RE = /^(\s*)([❯›>])(\s+)(\S.*?)\s*$/;
/** Any numbered row — those belong to `detectGateScreen`, not here. */
const NUMBERED_RE = /^\s*(?:[❯›>]\s*)?\d+\.\s+\S/;

const DOWN = "\x1b[B";
const UP = "\x1b[A";

/**
 * Keystrokes that move the selection from `cursor` to `target` and confirm.
 * Pure arithmetic on row offsets — the list is vertical and wraps nowhere that
 * matters, so the shortest path is a straight run of arrows.
 */
export function startupChoiceAnswerKeys(cursor: number, target: number): string {
  const delta = target - cursor;
  const step = delta > 0 ? DOWN : UP;
  return `${step.repeat(Math.abs(delta))}\r`;
}

/**
 * Claim an unnumbered startup choice from rendered screen lines.
 *
 * The block is anchored on the cursor row: options are the contiguous rows whose
 * text begins at exactly the cursor row's text column. That column test is what
 * separates the options from the prose above them — "Security guide" sits one
 * column to the left of "No, exit", because the cursor glyph and its trailing
 * space are what indent the labels. Returns null unless the confirm footer is
 * present and at least two options share that column. Pure — no I/O.
 */
export function detectStartupChoiceGate(lines: string[]): PermissionGate | null {
  if (lines.some((l) => ASK_MENU_FOOTER_RE.test(l))) return null;

  const footer = lines.findIndex((l) => CONFIRM_FOOTER_RE.test(l));
  if (footer < 0) return null;

  // Exactly one cursor row, and it must be above the footer.
  const cursorRows = lines
    .map((l, i) => (i < footer && CURSOR_ROW_RE.test(l) ? i : -1))
    .filter((i) => i >= 0);
  if (cursorRows.length !== 1) return null;
  const cursorRow = cursorRows[0];

  const m = CURSOR_ROW_RE.exec(lines[cursorRow]);
  if (!m) return null;
  // Numbered blocks are detectGateScreen's; never claim one here.
  if (NUMBERED_RE.test(lines[cursorRow])) return null;

  const labelColumn = m[1].length + m[2].length + m[3].length;
  const rowLabel = (line: string): string | null => {
    if (NUMBERED_RE.test(line)) return null;
    const indent = line.length - line.trimStart().length;
    if (indent !== labelColumn) return null;
    const label = line.trim();
    return label.length > 0 ? label : null;
  };

  // Walk out from the cursor row while rows keep starting at the label column.
  const rows: { row: number; label: string }[] = [{ row: cursorRow, label: m[4] }];
  for (let i = cursorRow - 1; i >= 0; i--) {
    const label = rowLabel(lines[i]);
    if (label === null) break;
    rows.unshift({ row: i, label });
  }
  for (let i = cursorRow + 1; i < footer; i++) {
    const label = rowLabel(lines[i]);
    if (label === null) break;
    rows.push({ row: i, label });
  }
  if (rows.length < 2) return null;

  const cursorIndex = rows.findIndex((r) => r.row === cursorRow) + 1;
  const options: PermissionOption[] = rows.map((r, i) => ({
    index: i + 1,
    label: r.label,
    answerKeys: startupChoiceAnswerKeys(cursorIndex, i + 1),
  }));

  // Prompt = nearest non-empty line above the block that is not the frame.
  let prompt: string | undefined;
  for (let i = rows[0].row - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    if (/^[\s─━-]+$/.test(t)) continue;
    prompt = t;
    break;
  }

  return {
    ...(prompt ? { prompt } : {}),
    options,
    cursor: cursorIndex,
  };
}
