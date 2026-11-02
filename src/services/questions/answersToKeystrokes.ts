import type { AskQuestion } from "../../types";

const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const RIGHT = "\x1b[C";

export class UnknownOptionError extends Error {
  constructor(
    public readonly question: string,
    public readonly value: string,
  ) {
    super(`No option labelled "${value}" for question "${question}"`);
    this.name = "UnknownOptionError";
  }
}

// A shape this keystroke path cannot answer safely: a multi-question form, a
// multi-select picker whose checkbox could not be read, or more than one label
// for a single-select question.
export class UnsupportedPromptShapeError extends Error {
  constructor(public readonly detail: string) {
    super(`Unsupported prompt shape: ${detail}`);
    this.name = "UnsupportedPromptShapeError";
  }
}

export class IncompleteAnswerError extends Error {
  constructor(public readonly question: string) {
    super(`Missing answer for question "${question}"`);
    this.name = "IncompleteAnswerError";
  }
}

// Supported shape: exactly one question.
//
// Single-select: one label. Cursor starts at index 0; N downs + Enter selects
// index N.
//
// Multi-select: one label, or a list of them. Enter on an option row toggles it
// (it does not submit), so the sequence is: walk down to each chosen option in
// order and press Space, then Right arrow to the "Review your answers" screen
// and Enter on its default "Submit answers". Verified on Claude Code 2.1.316
// with two of four options chosen, stepwise and as one burst write.
//
// Deliberately nothing more. Multi-question forms used to be answered by
// concatenating one block per question, blind to whether the TUI advanced or
// where its cursor landed; a multi-select question was "answered" with its
// first label as if single-select (#728). Both wrote bytes for an answer the
// user did not give. A multi-select question is now only ever answered with the
// toggle sequence, never the single-select one, and a picker whose checkbox
// marker was unreadable (`multiSelectUnverified`) throws BEFORE any keystroke is
// built. The TUI shows a multi-question form one picker at a time and the screen
// detector cards each picker as a single question, so that path is unaffected.
export function answersToKeystrokes(
  questions: AskQuestion[],
  answers: Record<string, string | string[]>,
): string {
  if (questions.length !== 1) {
    throw new UnsupportedPromptShapeError(`${questions.length} questions`);
  }
  const q = questions[0];
  if (q.multiSelect && q.multiSelectUnverified) {
    throw new UnsupportedPromptShapeError("multiSelect with an unreadable checkbox marker");
  }
  const raw = answers[q.question];
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    throw new IncompleteAnswerError(q.question);
  }
  if (q.multiSelect) return multiSelectKeystrokes(q, Array.isArray(raw) ? raw : [raw]);
  if (Array.isArray(raw) && raw.length > 1) {
    throw new UnsupportedPromptShapeError(`${raw.length} labels for a single-select question`);
  }
  const label = Array.isArray(raw) ? raw[0] : raw;
  const target = q.options.findIndex((o) => o.label === label);
  if (target < 0) throw new UnknownOptionError(q.question, label);
  return DOWN.repeat(target) + ENTER;
}

function multiSelectKeystrokes(q: AskQuestion, labels: string[]): string {
  const targets = new Set<number>();
  for (const label of labels) {
    const index = q.options.findIndex((o) => o.label === label);
    if (index < 0) throw new UnknownOptionError(q.question, label);
    targets.add(index);
  }
  let keys = "";
  let cursor = 0;
  for (const index of [...targets].sort((a, b) => a - b)) {
    keys += DOWN.repeat(index - cursor) + SPACE;
    cursor = index;
  }
  return keys + RIGHT + ENTER;
}
