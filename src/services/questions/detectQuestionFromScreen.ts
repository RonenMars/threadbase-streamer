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

  // Collect contiguous option rows immediately above the footer (skipping the
  // Esc/navigate footer line and blanks between options and footer).
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
    if (BOX_ONLY_RE.test(line.trim())) continue; // box border around the menu
    if (ESC_FOOTER_RE.test(line) && options.length === 0) continue;
    const m = OPTION_RE.exec(inner);
    if (m) {
      const label = m[2].trim();
      if (PERMISSION_LABEL_RE.test(label)) return null; // it's a permission gate
      options.unshift({ label, description: "" });
      firstOptionIdx = i;
    } else {
      break; // first non-option line above the block — that's the question region
    }
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

  return {
    questions: [{ question, header: "", multiSelect: false, options }],
  };
}

/**
 * Stable content key for de-duping a screen-scraped question against the JSONL
 * detection of the same question (they share no toolUseId). Keyed on the
 * question text + option labels.
 */
export function questionContentKey(questions: AskQuestion[]): string {
  return questions.map((q) => `${q.question} ${q.options.map((o) => o.label).join(",")}`).join("::");
}
