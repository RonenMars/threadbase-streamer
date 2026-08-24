import type { AskQuestion } from "../../types";

const DOWN = "\x1b[B";
const ENTER = "\r";

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
// multi-select question, or more than one label for a single-select question.
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

// Supported shape: exactly one single-select question answered with one label.
// Cursor starts at index 0; N downs + Enter selects index N.
//
// Deliberately nothing more. Multi-question forms used to be answered by
// concatenating one block per question, blind to whether the TUI advanced or
// where its cursor landed; a multi-select question was "answered" with its
// first label as if single-select. Both wrote bytes for an answer the user did
// not give. They now throw BEFORE any keystroke is built, and the route refuses
// without writing. The TUI shows a multi-question form one picker at a time and
// the screen detector cards each picker as a single question, so that path is
// unaffected.
export function answersToKeystrokes(
  questions: AskQuestion[],
  answers: Record<string, string | string[]>,
): string {
  if (questions.length !== 1) {
    throw new UnsupportedPromptShapeError(`${questions.length} questions`);
  }
  const q = questions[0];
  if (q.multiSelect) throw new UnsupportedPromptShapeError("multiSelect");
  const raw = answers[q.question];
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    throw new IncompleteAnswerError(q.question);
  }
  if (Array.isArray(raw) && raw.length > 1) {
    throw new UnsupportedPromptShapeError(`${raw.length} labels for a single-select question`);
  }
  const label = Array.isArray(raw) ? raw[0] : raw;
  const target = q.options.findIndex((o) => o.label === label);
  if (target < 0) throw new UnknownOptionError(q.question, label);
  return DOWN.repeat(target) + ENTER;
}
