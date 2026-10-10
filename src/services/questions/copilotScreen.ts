import type { PermissionOption } from "../../types";

/**
 * Copilot CLI's blocking cards, read off the rendered screen (verified on
 * Copilot CLI 1.0.92; captures in `__tests__/fixtures/turn-signals/`).
 *
 * Two shapes, told apart by their footer:
 *
 * - Folder trust and tool permission: a box with numbered rows and the footer
 *   `↑/↓ to navigate · enter to select · esc to cancel`. Claude's gate detector
 *   treats that footer as an AskUserQuestion menu and declines it, so these get
 *   their own reader.
 * - An `ask_user` form: unboxed, under the header `Copilot needs information.`,
 *   with unnumbered rows and the footer `enter accept · ctrl+d decline · esc
 *   cancel`.
 *
 * Both go out over the `permission` transport as a single-select card.
 */

// Either footer on screen means Copilot is waiting on the user.
export const COPILOT_SELECT_FOOTER_RE = /enter to select\b.*\besc to cancel/;
export const COPILOT_FORM_FOOTER_RE = /enter accept\b.*\besc cancel/;
// A card owns the bottom of the screen: its footer sits just above the bottom
// border (or the rule under a form), so a footer quoted in a reply further up
// is not one.
export const COPILOT_FOOTER_ROWS = 3;

const FORM_HEADER = "Copilot needs information.";
// The form's last row opens a text field instead of answering.
const FORM_FREE_TEXT_RE = /^Other \(type your answer\)$/;
const BOX_TOP_RE = /^╭─+╮$/;
const BOX_EDGE_RE = /^[╭╰]─+[╮╯]$/;
const RULE_RE = /^─+$/;
const NUMBERED_ROW_RE = /^(\s*)(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
const FORM_CURSOR_ROW_RE = /^(\s*)❯\s+(\S.*?)\s*$/;
const DOWN = "\x1b[B";
const UP = "\x1b[A";

export interface CopilotCard {
  prompt: string;
  detail?: string;
  options: PermissionOption[];
  /** `index` of the highlighted option, when it is one the card offers. */
  cursor?: number;
}

/** Row of the card footer, or -1: only the last rows painted can hold one. */
function footerRow(lines: string[], footer: RegExp): number {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < COPILOT_FOOTER_ROWS; i--) {
    if (seen === 0 && lines[i].trim() === "") continue;
    if (footer.test(lines[i])) return i;
    seen++;
  }
  return -1;
}

/** What is inside a box row's `│ … │` gutter, or null for a row with none. */
function insideBox(line: string): string | null {
  const m = /^\s*│ ?(.*?) ?│\s*$/.exec(line);
  return m ? m[1].trimEnd() : null;
}

/**
 * Keys that answer the row `row` of a list whose highlight is on `highlighted`:
 * arrows to it, then Enter, in one write (verified live on 1.0.92 and 1.0.95).
 * Not the row's digit: on 1.0.92 a digit selects and confirms, on 1.0.91 it was
 * recorded as only moving the highlight, and an `ask_user` row has no digit.
 * Arrows and Enter mean the same on every build seen. The keys count from the
 * highlight, so a card is rebuilt whenever it moves.
 */
function keysFrom(highlighted: number, row: number): string {
  return `${(row > highlighted ? DOWN : UP).repeat(Math.abs(row - highlighted))}\r`;
}

/** The trust and permission cards. */
function detectSelectCard(lines: string[]): CopilotCard | null {
  const footer = footerRow(lines, COPILOT_SELECT_FOOTER_RE);
  if (footer < 0 || insideBox(lines[footer]) === null) return null;
  let top = footer - 1;
  while (top >= 0 && !BOX_TOP_RE.test(lines[top].trim())) top--;
  if (top < 0) return null;

  // Paragraphs above the options, in order. A blank row, a rule and the inner
  // box's border each end one; rows of one paragraph are a wrapped sentence,
  // rows of the inner box (the command, the folder) keep their line breaks.
  const paragraphs: string[] = [];
  let open: { text: string[]; boxed: boolean } | null = null;
  const close = () => {
    if (open) paragraphs.push(open.text.join(open.boxed ? "\n" : " "));
    open = null;
  };
  const options: PermissionOption[] = [];
  let cursor: number | undefined;
  let cursorRows = 0;
  let labelColumn = 0;

  for (let i = top + 1; i < footer; i++) {
    const row = insideBox(lines[i]);
    if (row === null) return null;
    const numbered = NUMBERED_ROW_RE.exec(row);
    if (numbered) {
      close();
      const index = Number(numbered[3]);
      // Rows count up from 1: anything else is a list in the card's own text.
      if (index !== options.length + 1) return null;
      if (numbered[2]) {
        cursor = index;
        cursorRows++;
      }
      labelColumn = row.indexOf(numbered[4]);
      options.push({ index, label: numbered[4] });
      continue;
    }
    if (options.length > 0) {
      if (row.trim() === "") continue;
      // A long label wraps under its own text, never back to the gutter.
      if (row.length - row.trimStart().length < labelColumn) return null;
      options[options.length - 1].label += ` ${row.trim()}`;
      continue;
    }
    const inner = insideBox(row);
    const text = (inner ?? row).trim();
    if (text === "" || RULE_RE.test(text) || BOX_EDGE_RE.test(text)) {
      close();
      continue;
    }
    const boxed = inner !== null;
    if (open && open.boxed !== boxed) close();
    open ??= { text: [], boxed };
    open.text.push(text);
  }

  const prompt = paragraphs.pop();
  if (!prompt || options.length < 2 || cursor === undefined || cursorRows !== 1) return null;
  const highlighted = cursor;
  return {
    prompt,
    ...(paragraphs.length > 0 ? { detail: paragraphs.join("\n") } : {}),
    options: options.map((o) => ({ ...o, answerKeys: keysFrom(highlighted, o.index) })),
    cursor,
  };
}

/**
 * An `ask_user` form with one choice field. The free-text row is not offered:
 * a card option cannot carry typed text.
 */
function detectFormCard(lines: string[]): CopilotCard | null {
  const footer = footerRow(lines, COPILOT_FORM_FOOTER_RE);
  if (footer < 0) return null;
  let header = footer - 1;
  while (header >= 0 && lines[header].trim() !== FORM_HEADER) {
    if (RULE_RE.test(lines[header].trim())) return null;
    header--;
  }
  if (header < 0) return null;

  // The choice rows: the highlighted one, and its neighbours whose text starts
  // in the same column. The field's own label and description sit above them,
  // further left, which is where the block ends.
  const highlightedRows = [];
  for (let i = header + 1; i < footer; i++) {
    if (FORM_CURSOR_ROW_RE.test(lines[i])) highlightedRows.push(i);
  }
  if (highlightedRows.length !== 1) return null;
  const at = highlightedRows[0];
  const column = lines[at].indexOf("❯") + 2;
  const isChoice = (i: number) =>
    lines[i].trim() !== "" && lines[i].length - lines[i].trimStart().length === column;
  let first = at;
  while (first - 1 > header && isChoice(first - 1)) first--;
  let last = at;
  while (last + 1 < footer && isChoice(last + 1)) last++;
  // Anything between the choices and the footer is a form this does not know.
  if (lines.slice(last + 1, footer).some((line) => line.trim() !== "")) return null;
  const highlighted = at - first;
  const rows = lines
    .slice(first, last + 1)
    .map((line, i) => (i === highlighted ? line.replace("❯", " ") : line).trim());

  // Between the header and the choices: the question, a blank row, then the
  // field's label and description.
  const above: string[][] = [[]];
  for (let i = header + 1; i < first; i++) {
    const text = lines[i].trim();
    if (text === "") above.push([]);
    else above[above.length - 1].push(text);
  }
  const [question, ...field] = above.filter((block) => block.length > 0);
  if (!question) return null;
  const detail = field.flat().join("\n");

  const options = rows
    .map((label, row) => ({
      index: row + 1,
      label,
      answerKeys: keysFrom(highlighted, row),
    }))
    .filter((option) => !FORM_FREE_TEXT_RE.test(option.label));
  if (options.length === 0) return null;
  const cursor = options.find((o) => o.index === highlighted + 1)?.index;
  return {
    prompt: question.join(" "),
    ...(detail ? { detail } : {}),
    options,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** The card Copilot is waiting on, or null. Pure: `lines` is the rendered viewport. */
export function detectCopilotCard(lines: string[]): CopilotCard | null {
  return detectSelectCard(lines) ?? detectFormCard(lines);
}
