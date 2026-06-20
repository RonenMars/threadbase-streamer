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

// v1: single-select only. Cursor starts at index 0; N downs + Enter selects index N.
// Multi-question calls replay each question's block in the order Claude presents them.
export function answersToKeystrokes(
  questions: AskQuestion[],
  answers: Record<string, string | string[]>,
): string {
  let out = "";
  for (const q of questions) {
    const raw = answers[q.question];
    if (raw === undefined) {
      throw new Error(`Missing answer for question "${q.question}"`);
    }
    const label = Array.isArray(raw) ? raw[0] : raw; // v1 ignores extra (multiSelect is v2)
    const target = q.options.findIndex((o) => o.label === label);
    if (target < 0) throw new UnknownOptionError(q.question, label);
    out += DOWN.repeat(target) + ENTER;
  }
  return out;
}
