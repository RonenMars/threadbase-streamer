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
// Differences from the JSONL form: no header/description/preview (the screen
// only shows labels), and the leading number is the on-screen index. We map it
// to the AskQuestion shape (header/description default to "") so the existing
// `question` WS event and QuestionCard render path are reused unchanged.

// The footer that terminates an AskUserQuestion menu — its presence is the
// positive signal that this block IS a structured picker (vs a permission gate,
// which uses a different footer and y/n phrasing).
const ASK_FOOTER_RE = /Enter to select/i;
const ESC_FOOTER_RE = /Esc to cancel|to navigate/i;

// An option row: optional `❯` cursor + "N. label". Tolerates the box indent.
const OPTION_RE = /^\s*(?:❯)?\s*(\d+)\.\s+(.+?)\s*$/;

// A question header ends with "?" (AskUserQuestion questions are interrogative).
const QUESTION_RE = /\?\s*$/;

const BOX_ONLY_RE = /^[\s│─┌┐└┘├┤┬┴┼╭╮╰╯╱╲=_-]+$/;

// Reject permission-gate option labels so a gate (caught separately via OSC 777)
// never doubles as a structured question.
const PERMISSION_LABEL_RE = /^(Yes|No)\b/i;

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
      const label = m[2].trim();
      if (PERMISSION_LABEL_RE.test(label)) return null; // it's a permission gate
      options.unshift({ label, description: "" });
      firstOptionIdx = i;
    }
    // else: a wrapped description / continuation line for the option below it —
    // skip it and keep scanning upward for more options.
  }

  if (options.length < 2 || firstOptionIdx === -1) return null;

  // Question = nearest non-empty, non-box line above the first option row that
  // ends with "?".
  let question: string | undefined;
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const raw = stripBoxGutter(lines[i]);
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (BOX_ONLY_RE.test(lines[i].trim())) continue;
    if (QUESTION_RE.test(trimmed)) {
      question = trimmed;
    }
    break;
  }

  if (!question) return null;

  // The multi-question "Ready to submit your answers?" confirmation IS surfaced
  // as a real card (Submit answers / Cancel) so the user can tap to confirm —
  // the multi-question carousel doesn't reliably auto-submit. (Roadmap: robust
  // auto-submit.) So we no longer reject it here.

  return {
    questions: [{ question, header: "", multiSelect: false, options }],
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
 * Stable content key for de-duping a screen-scraped question against the JSONL
 * detection of the same question (they share no toolUseId). Keyed on the
 * question text + option labels.
 */
export function questionContentKey(questions: AskQuestion[]): string {
  return questions
    .map((q) => `${q.question} ${q.options.map((o) => o.label).join(",")}`)
    .join("::");
}
