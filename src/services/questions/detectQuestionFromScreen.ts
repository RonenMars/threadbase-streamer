import type { AskOption, AskQuestion } from "../../types";

// Detect a structured AskUserQuestion menu from the RENDERED screen lines
// (getOutputLines), not JSONL. The JSONL path (detectAskUserQuestion) is
// structurally late — the question is painted in the TUI before the tool_use
// block flushes to disk, and a backgrounded sub-agent may write to a different
// JSONL than the watched session. Scraping the rendered screen fires the moment
// the menu is on screen.
//
// The on-screen AskUserQuestion menu looks like:
//
//     Which area are you focused on?
//     ❯ 1. macOS / Chrome
//       2. iOS / Safari
//       …
//       6. Chat about this
//     Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// Differences from the JSONL form: no header or preview, and the leading number
// is the on-screen index. An option's description is the indented row(s) the TUI
// paints under it; header defaults to "" and an option with no rows gets "". We
// map it to the AskQuestion shape so the existing `question` WS event and
// QuestionCard render path are reused unchanged.

// The footer that terminates an AskUserQuestion menu — its presence is the
// positive signal that this block IS a structured picker (vs a permission gate,
// which uses a different footer and y/n phrasing).
const ASK_FOOTER_RE = /Enter to select/i;
const ASK_FOOTER_ROW_RE = /^\s*Enter to select/i;
// Generous bound on rows between a menu's first option and its footer
// (options + wrapped descriptions + borders).
const MENU_WINDOW_ROWS = 30;
const ESC_FOOTER_RE = /Esc to cancel|to navigate/i;

// An option row: optional `❯` cursor + "N. label". Tolerates the box indent.
const OPTION_RE = /^\s*(?:❯)?\s*(\d+)\.\s+(.+?)\s*$/;

// A question header ends with "?" (AskUserQuestion questions are interrogative).
const QUESTION_RE = /\?\s*$/;
const MID_QUESTION_RE = /\?\s/;

const BOX_ONLY_RE = /^[\s│─┌┐└┘├┤┬┴┼╭╮╰╯╱╲=_-]+$/;

// Reject permission-gate option labels so a gate (caught separately via OSC 777)
// never doubles as a structured question. Exact Yes/No only — AskUserQuestion
// options like "Yes, commit (Recommended)" must stay on this path (`^(Yes|No)\b`
// discarded every commit-approval menu).
const PERMISSION_LABEL_RE = /^(Yes|No)$/i;

// The checkbox a multi-select picker paints beside each selectable option
// ("[ ] Python" before a toggle, "[✔] Python" after). Its presence is the ONLY
// on-screen evidence that a picker is multi-select: the TUI draws a
// multi-select form and a single-select menu with the same footer, the same
// "N." numbering and the same ❯ cursor, so nothing else here distinguishes
// them. `Chat about this` — the escape hatch — carries no checkbox, so ANY
// marked option means multi-select; requiring all of them would miss every
// real form.
const KNOWN_STATE_MARKER_RE = /^(?:\[(?:[ xX*]|✓|✔)\]|[☐☑☒])\s*/;

// A short bracketed token we do NOT recognise, treated as a state marker we
// cannot read rather than as label text. This is what makes the classifier fail
// towards unanswerable: without it, an unfamiliar marker (a future TUI painting
// "( )" radios, say) would fall through to single-select and the answer route
// would write a keystroke for a shape it never understood. The ≤3-character
// bound is deliberate — real markers are one or two glyphs, while a longer
// bracketed token ("[draft] …") is far more likely to be genuine label text.
const UNKNOWN_STATE_MARKER_RE = /^(?:\[[^\]]{0,3}\]|\([^)]{0,3}\))\s*/;

// Split a rendered option label into its state marker (if any) and the label
// proper. A recognised marker is stripped — it is presentation, and leaving it
// in the payload both ships "[ ]" to clients as if it were part of the option
// text and makes questionContentKey unstable, so merely ticking a box on screen
// reads as a different question and mints a new prompt.
function stripStateMarker(label: string): { label: string; marked: boolean; known: boolean } {
  if (KNOWN_STATE_MARKER_RE.test(label)) {
    return { label: label.replace(KNOWN_STATE_MARKER_RE, ""), marked: true, known: true };
  }
  // Unrecognised: flag it, but leave the text alone — we do not know that the
  // token is a marker, only that we cannot rule it out.
  if (UNKNOWN_STATE_MARKER_RE.test(label)) return { label, marked: true, known: false };
  return { label, marked: false, known: false };
}

// The final confirmation screen of a multi-question AskUserQuestion TUI:
//   Ready to submit your answers?
//   ❯ 1. Submit answers
//     2. Cancel
//   Enter to select · …
// The user already answered each question via cards, so this internal step is
// auto-confirmed by the PTY layer and must never render as its own card.
const SUBMIT_QUESTION_RE = /ready to submit your answers\?/i;
const SUBMIT_OPTION_RE = /^submit answers?$/i;

// Strip leading AND trailing box-drawing gutters ("│ … │") so a menu drawn
// inside a box parses the same as an unboxed one (the trailing gutter matters
// for the "?"-suffix question test).
function stripBoxGutter(line: string): string {
  return line.replace(/^\s*[│|]\s?/, "").replace(/\s*[│|]\s*$/, "");
}

// The "☐ Header" chip AskUserQuestion paints beside a question, and the
// "← ☒ Scope ☐ Transcript ✔ Submit →" tab bar a multi-question form paints
// directly above it with no blank line between. Neither is question text, so
// either ends the upward walk in joinWrappedQuestion.
const HEADER_CHIP_RE = /^[☐☑☒←→]/;

// A long question wraps across terminal rows and only the LAST one ends in "?",
// so taking that row alone drops the beginning of the question (a phone card
// read "smallest fix with a test and all three suites?"). Join the rows above
// it, stopping at a blank line, a box border or the header chip. Capped so a
// screen with prose directly above the question cannot be swallowed whole.
const MAX_WRAPPED_QUESTION_ROWS = 6;

export function joinWrappedQuestion(lines: string[], questionIdx: number, last: string): string {
  const rows = [last];
  for (let i = questionIdx - 1; i >= 0 && rows.length < MAX_WRAPPED_QUESTION_ROWS; i--) {
    const trimmed = stripBoxGutter(lines[i]).trim();
    if (trimmed.length === 0 || BOX_ONLY_RE.test(lines[i].trim())) break;
    if (HEADER_CHIP_RE.test(trimmed)) break;
    rows.unshift(trimmed);
  }
  return rows.join(" ");
}

/**
 * Detect an AskUserQuestion menu in rendered screen lines. Returns the question
 * set (single-question; the TUI shows one picker at a time) or null.
 * Pure — no I/O.
 */
export function detectQuestionFromScreen(lines: string[]): { questions: AskQuestion[] } | null {
  // Find the footer that closes the menu; scan upward from it.
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ASK_FOOTER_RE.test(lines[i])) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx === -1) return null;

  // Collect option rows above the footer. Real menus interleave each "N. label"
  // row with wrapped DESCRIPTION lines and may insert a box border between
  // options, so a non-option line is NOT a hard stop — it's skipped as long as
  // we haven't reached the question line yet. We stop at: the question line (ends
  // with "?"), a blank gap once options have started, or the top of the window.
  const options: AskOption[] = [];
  let firstOptionIdx = -1;
  let sawStateMarker = false;
  let sawKnownMarker = false;
  let pendingDescription: string[] = [];
  for (let i = footerIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const inner = stripBoxGutter(line);
    const trimmed = inner.trim();
    if (trimmed.length === 0) {
      if (options.length === 0) continue; // gap between footer and options
      break; // blank line above the option block ends it
    }
    if (BOX_ONLY_RE.test(line.trim())) continue; // box border between/around options
    if (ESC_FOOTER_RE.test(line) && options.length === 0) continue;
    // The question line terminates the option block (it's the row right above
    // the first option, after any descriptions). Stop before consuming it.
    if (options.length > 0 && QUESTION_RE.test(trimmed) && !OPTION_RE.test(inner)) break;
    const m = OPTION_RE.exec(inner);
    if (m) {
      const rendered = m[2].trim();
      if (PERMISSION_LABEL_RE.test(rendered)) return null; // it's a permission gate
      const { label, marked, known } = stripStateMarker(rendered);
      if (marked) sawStateMarker = true;
      if (known) sawKnownMarker = true;
      options.unshift({ label, description: pendingDescription.join(" ") });
      pendingDescription = [];
      firstOptionIdx = i;
    } else {
      // A description row (wrapped ones span several) belongs to the option ABOVE
      // it, which this upward scan has not reached yet. Rows left over once the
      // first option is found are the question/header and are dropped.
      pendingDescription.unshift(trimmed);
    }
  }

  if (options.length < 2 || firstOptionIdx === -1) return null;

  // Question = nearest "?" line above the first option. AskUserQuestion paints
  // its `header` (e.g. "☐ Commit approval") between the question and the
  // options, so allow skipping a single non-"?" line before requiring "?".
  // A status line with no "?" above it still fails (see tests).
  let question: string | undefined;
  let skippedHeader = false;
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const raw = stripBoxGutter(lines[i]);
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (BOX_ONLY_RE.test(lines[i].trim())) continue;
    // The last row of a multi-sentence question can end in "." with the "?" mid-text
    // ("...shows? It would be a small change in `x.ts`, with tests."), so a wrapped
    // block that asks anywhere counts, not only a "?"-terminated last row.
    const joined = joinWrappedQuestion(lines, i, trimmed);
    const asks =
      QUESTION_RE.test(trimmed) || (!HEADER_CHIP_RE.test(trimmed) && MID_QUESTION_RE.test(joined));
    if (asks) {
      question = joined;
      break;
    }
    if (!skippedHeader) {
      skippedHeader = true;
      continue;
    }
    break;
  }

  if (!question) return null;

  // The multi-question "Ready to submit your answers?" confirmation IS surfaced
  // as a real card (Submit answers / Cancel) so the user can tap to confirm —
  // the multi-question carousel doesn't reliably auto-submit. (Roadmap: robust
  // auto-submit.) So we no longer reject it here.

  // multiSelect carries two cases that must land in the same place: a picker we
  // positively recognised as multi-select, and one whose option markers we could
  // not read. The contract publishes inputMode "multi" for both, and has no
  // third value for "shape unknown". They differ in what the answer route may
  // write: a readable checkbox is answered by toggling, an unreadable marker
  // (`multiSelectUnverified`) makes answersToKeystrokes throw
  // UnsupportedPromptShapeError before building a keystroke — the bucket that
  // writes zero bytes.
  return {
    questions: [
      {
        question,
        header: "",
        multiSelect: sawStateMarker,
        ...(sawStateMarker && !sawKnownMarker ? { multiSelectUnverified: true } : {}),
        options,
      },
    ],
  };
}

/**
 * True when the rendered screen is the AskUserQuestion "Ready to submit your
 * answers?" confirmation (a question line + a "Submit answers" option under the
 * Ask footer). Pure — no I/O. Retained as a classifier (e.g. for analytics);
 * the submit screen now renders as a normal card.
 */
export function isSubmitConfirmationScreen(lines: string[]): boolean {
  let hasFooter = false;
  let hasSubmitQuestion = false;
  let hasSubmitOption = false;
  for (const line of lines) {
    const inner = stripBoxGutter(line).trim();
    if (ASK_FOOTER_RE.test(line)) hasFooter = true;
    if (SUBMIT_QUESTION_RE.test(inner)) hasSubmitQuestion = true;
    const m = OPTION_RE.exec(inner);
    if (m && SUBMIT_OPTION_RE.test(m[2].trim())) hasSubmitOption = true;
  }
  return hasFooter && hasSubmitQuestion && hasSubmitOption;
}

/**
 * True when an AskUserQuestion menu is still painted on the rendered screen.
 * Cheaper and far more forgiving than detectQuestionFromScreen: it asks only
 * "is the picker up?", so a menu whose options wrap oddly still reads as
 * present. Used to reject an answer for a menu that already closed. Pure.
 */
export function isQuestionMenuOnScreen(lines: string[]): boolean {
  // The footer must START its row (after any box gutter) and sit under at least two
  // option rows. A bare substring test also matched prose that quotes the footer,
  // which held a finished turn open as `running` for as long as the text stayed on
  // screen. ponytail: a quoted footer at a row start under a numbered list still
  // matches; fine until it is seen.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ASK_FOOTER_ROW_RE.test(stripBoxGutter(lines[i]))) continue;
    let optionRows = 0;
    for (let j = i - 1; j >= Math.max(0, i - MENU_WINDOW_ROWS); j--) {
      if (OPTION_RE.test(stripBoxGutter(lines[j]))) optionRows++;
    }
    return optionRows >= 2;
  }
  return false;
}

/**
 * Stable content key for de-duping a screen-scraped question against the JSONL
 * detection of the same question (they share no toolUseId). Keyed on the
 * question text + option labels.
 */
export function questionContentKey(questions: AskQuestion[]): string {
  return questions
    .map((q) => `${q.question} ${q.options.map((o) => o.label).join(",")}`)
    .join("::");
}

const normalizeQuestionText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * True when every question in `screen` is a question of `transcript`: the
 * rendered menu is a (possibly lossy) view of that tool call. The scrape sees
 * only the visible tab of a multi-question form and reads the TUI's own
 * "Type something" / "Chat about this" rows as options, so neither the content
 * key nor the option labels can be compared — only the question text survives.
 */
export function isLossyViewOf(screen: AskQuestion[], transcript: AskQuestion[]): boolean {
  const known = new Set(transcript.map((q) => normalizeQuestionText(q.question)));
  return screen.length > 0 && screen.every((q) => known.has(normalizeQuestionText(q.question)));
}
