import type { AskQuestion } from "../../types";
import { isTerminalOnlyRow, isTypeRow } from "./terminalOnlyRows";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
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

// Free text for the "Type something." row that cannot be typed as given: empty,
// over the cap, not a string, or carrying a control character. A control byte
// would reach the TUI as an escape sequence rather than as text.
export class InvalidTextError extends Error {
  constructor(public readonly detail: string) {
    super(`Invalid free text: ${detail}`);
    this.name = "InvalidTextError";
  }
}

export class IncompleteAnswerError extends Error {
  constructor(public readonly question: string) {
    super(`Missing answer for question "${question}"`);
    this.name = "IncompleteAnswerError";
  }
}

export const MAX_FREE_TEXT = 2000;

const TYPE_ROW = "Type something.";
const CHAT_ROW = "Chat about this";

/** The free-text answer shape: `{ "<question>": { other: "<text>" } }`. */
export type FreeTextAnswer = { other: string };
export type AnswerValue = string | string[] | FreeTextAnswer;

/**
 * What answering means for the PTY. Plain labels are one burst of keys. Free
 * text cannot be: the field only takes text once the cursor is on it and the
 * closing Enter must be its own write, so the handler runs the sequence
 * (`row` is the 0-based row to put the cursor on; `text` is already encoded for
 * the field, newlines as Option+Enter).
 */
export type AnswerPlan = { keys: string } | { freeText: { row: number; text: string } };

// Verified on Claude Code 2.1.328: Option+Enter (ESC CR) is a newline inside the
// field; a bare CR submits. Every other control character is refused rather than
// stripped, since stripping would send something the user did not write.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const FORBIDDEN_CONTROL = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;
const NEWLINE = /\r\n|\n|\r/;

function encodeFreeText(value: unknown): string {
  if (typeof value !== "string") throw new InvalidTextError("not a string");
  if (value.trim() === "") throw new InvalidTextError("empty");
  if (value.length > MAX_FREE_TEXT) throw new InvalidTextError(`over ${MAX_FREE_TEXT} characters`);
  if (FORBIDDEN_CONTROL.test(value)) throw new InvalidTextError("control character");
  return value.split(NEWLINE).join("\x1b\r");
}

// A structured (JSONL) card lists only the model's options; a screen-scraped one
// also lists the two rows Claude Code adds itself. Single-select only: give both
// a card the same row list so the index maths is one thing.
function withTerminalRows(q: AskQuestion): string[] {
  const labels = q.options.map((o) => o.label);
  if (labels.some(isTerminalOnlyRow)) return labels;
  return [...labels, TYPE_ROW, CHAT_ROW];
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
export function planAnswer(
  questions: AskQuestion[],
  answers: Record<string, AnswerValue>,
): AnswerPlan {
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
  if (isFreeText(raw)) {
    if (q.multiSelect) throw new UnsupportedPromptShapeError("free text for a multi-select");
    const text = encodeFreeText(raw.other);
    const row = withTerminalRows(q).findIndex(isTypeRow);
    if (row < 0) throw new UnsupportedPromptShapeError('no "Type something." row to type into');
    return { freeText: { row, text } };
  }
  if (q.multiSelect) return { keys: multiSelectKeystrokes(q, Array.isArray(raw) ? raw : [raw]) };
  if (Array.isArray(raw) && raw.length > 1) {
    throw new UnsupportedPromptShapeError(`${raw.length} labels for a single-select question`);
  }
  const label = Array.isArray(raw) ? raw[0] : raw;
  // The bare label would only move the cursor onto the field and press Enter on
  // it empty, which declines the whole question. Free text has its own shape.
  if (isTypeRow(label)) {
    throw new UnsupportedPromptShapeError('"Type something." needs { other: "<text>" }');
  }
  const target = withTerminalRows(q).indexOf(label);
  if (target < 0) throw new UnknownOptionError(q.question, label);
  return { keys: DOWN.repeat(target) + ENTER };
}

const isFreeText = (v: AnswerValue): v is FreeTextAnswer =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Arrow keys that move the cursor `delta` rows (positive is down). */
export const keysForMove = (delta: number): string =>
  delta >= 0 ? DOWN.repeat(delta) : UP.repeat(-delta);

/** Keys-only view of {@link planAnswer}; free text cannot be one burst of keys. */
export function answersToKeystrokes(
  questions: AskQuestion[],
  answers: Record<string, AnswerValue>,
): string {
  const plan = planAnswer(questions, answers);
  if ("freeText" in plan) throw new UnsupportedPromptShapeError("free text is not a key burst");
  return plan.keys;
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
