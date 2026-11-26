import type { AskQuestion } from "../../types";
import { isUnreadableQuestionForm } from "./detectQuestionFromScreen";

// Reads a multi-question AskUserQuestion form off the rendered screen, checked
// against the questions the prompt holds. The driver writes keys only from what
// this returns, so anything it cannot match exactly is null.

export type FormScreen =
  | {
      kind: "tab";
      index: number;
      // Option index; then "Type something" (N), the unnumbered Next/Submit row
      // (N+1, multi only) and "Chat about this" last.
      cursor: number;
      checked: boolean[];
    }
  | {
      kind: "review";
      // Per question, with all whitespace removed (a long answer wraps).
      answers: (string | null)[];
      unanswered: boolean;
      cursor: "submit" | "cancel";
    }
  | { kind: "scrolled" }
  | { kind: "preview" };

const TAB_BAR_RE = /^\s*←\s+[☐☒].*✔ Submit\s+→\s*$/;
const CHIP_RE = /[☐☒]/g;
const FOOTER_RE = /^\s*Enter to select/i;
const PREVIEW_RE = /n to add notes/i;
// A footer wraps onto at most two more rows on a narrow screen.
const FOOTER_EXTRA_ROWS = 2;
const NUMBERED_ROW_RE = /^\s*(❯)?\s*(\d+)\.\s+(?:\[( |✔)\]\s+)?(.*)$/;
const NEXT_ROW_RE = /^\s*(❯)?\s*(?:Next|Submit)\s*$/;
const RULE_RE = /^\s*─+\s*$/;

export const squash = (text: string): string => text.replace(/\s+/g, "");
const ungutter = (line: string): string => line.replace(/^\s*│/, "");

const lastMatch = (lines: string[], re: RegExp): number =>
  lines.reduce((found, line, i) => (re.test(line) ? i : found), -1);

// The one question whose text is exactly `text`, ignoring wrapping.
function questionIndex(text: string, questions: AskQuestion[]): number {
  const matches = questions.flatMap((q, i) => (squash(q.question) === text ? [i] : []));
  return matches.length === 1 ? matches[0] : -1;
}

export function readFormScreen(lines: string[], questions: AskQuestion[]): FormScreen | null {
  const barAt = lastMatch(lines, TAB_BAR_RE);
  const body = barAt === -1 ? [] : lines.slice(barAt + 1);
  const filled = lines.filter((l) => l.trim() !== "");

  if (/^\s*(?:❯)?\s*2\. Cancel\s*$/.test(filled[filled.length - 1] ?? "")) {
    if (!/Submit answers\s*$/.test(filled[filled.length - 2] ?? "")) return null;
    if (body.find((l) => l.trim() !== "")?.trim() !== "Review your answers") {
      return { kind: "scrolled" };
    }
    if (lines[barAt].match(CHIP_RE)?.length !== questions.length) return null;
    return readReview(body, questions);
  }

  const footerAt = lastMatch(lines, FOOTER_RE);
  if (footerAt === -1) return null;
  const footer = lines.slice(footerAt);
  if (footer.filter((l) => l.trim() !== "").length > 1 + FOOTER_EXTRA_ROWS) return null;
  if (isUnreadableQuestionForm(lines)) {
    return PREVIEW_RE.test(footer.join(" ")) ? { kind: "preview" } : { kind: "scrolled" };
  }
  if (barAt === -1 || barAt > footerAt) return null;
  if (lines[barAt].match(CHIP_RE)?.length !== questions.length) return null;
  return readTab(lines.slice(barAt + 1, footerAt), questions);
}

function readTab(rows: string[], questions: AskQuestion[]): FormScreen | null {
  const firstOption = rows.findIndex((l) => /^\s*(?:❯)?\s*1\.\s/.test(l));
  if (firstOption === -1) return null;
  const text = squash(rows.slice(0, firstOption).map(ungutter).join(""));
  const index = questionIndex(text, questions);
  if (index === -1) return null;
  const { options, multiSelect } = questions[index];
  const count = options.length;

  // Rows numbered 1..count, then "Type something" (count+1) and "Chat about
  // this" (count+2). Finding Type something there confirms the option count.
  const at: number[] = [];
  let from = firstOption;
  for (let n = 1; n <= count + 2; n++) {
    const found = rows.findIndex((l, i) => i >= from && Number(NUMBERED_ROW_RE.exec(l)?.[2]) === n);
    if (found === -1) return null;
    at.push(found);
    from = found + 1;
  }

  const checked: boolean[] = [];
  const cursors: number[] = [];
  for (let i = 0; i <= count + 1; i++) {
    const [, marker, , box, label] = NUMBERED_ROW_RE.exec(rows[at[i]]) as RegExpExecArray;
    const isChat = i === count + 1;
    if (!isChat && (box !== undefined) !== multiSelect) return null;
    if (isChat && label.trim() !== "Chat about this") return null;
    if (i === count && !label.startsWith("Type something")) return null;
    if (i < count) {
      if (!labelEndsOnARow(label, rows.slice(at[i] + 1, at[i + 1]), options[i].label)) return null;
      checked.push(box === "✔");
    }
    if (marker) cursors.push(isChat && multiSelect ? count + 2 : i);
  }
  if (multiSelect) {
    const next = rows.slice(at[count] + 1, at[count + 1]).flatMap((l) => NEXT_ROW_RE.exec(l) ?? []);
    // exec yields [row, marker]; exactly one such row must exist.
    if (next.length !== 2) return null;
    if (next[1]) cursors.push(count + 1);
  }
  if (rows.filter((l) => l.includes("❯") && !l.trimStart().startsWith("│")).length !== 1) {
    return null;
  }
  if (cursors.length !== 1) return null;
  return { kind: "tab", index, cursor: cursors[0], checked };
}

// A label may wrap, and its description starts on a new row, so the label must
// be exactly the text up to the end of some row. A revisit appends "✔".
function labelEndsOnARow(first: string, rest: string[], label: string): boolean {
  const want = squash(label);
  let seen = "";
  return [first, ...rest].some((row) => {
    seen += squash(row);
    return seen === want || seen === `${want}✔`;
  });
}

function readReview(body: string[], questions: AskQuestion[]): FormScreen | null {
  const answers: (string | null)[] = questions.map(() => null);
  let unanswered = false;
  let cursor: "submit" | "cancel" | null = null;
  let asked = "";
  let answer: string | null = null;
  let part: "none" | "question" | "answer" = "none";
  const flush = (): boolean => {
    if (part === "none") return true;
    const index = questionIndex(asked, questions);
    if (index === -1 || answer === null || answers[index] !== null) return false;
    answers[index] = answer;
    part = "none";
    return true;
  };

  let titled = false;
  for (const row of body) {
    const text = ungutter(row).trim();
    if (text === "" || RULE_RE.test(row)) continue;
    const action = /^(❯)?\s*[12]\. (Submit answers|Cancel)$/.exec(text);
    if (action) {
      if (!flush()) return null;
      if (action[1]) {
        if (cursor) return null;
        cursor = action[2] === "Cancel" ? "cancel" : "submit";
      }
    } else if (!titled) {
      titled = true;
    } else if (text === "⚠ Some questions are unanswered") {
      unanswered = true;
    } else if (text.startsWith("●")) {
      if (!flush()) return null;
      part = "question";
      asked = squash(text.slice(1));
      answer = null;
    } else if (text.startsWith("→") && part === "question") {
      part = "answer";
      answer = squash(text.slice(1));
    } else if (part === "question") {
      asked += squash(text);
    } else if (part === "answer") {
      answer += squash(text);
    } else {
      return null;
    }
  }
  return cursor ? { kind: "review", answers, unanswered, cursor } : null;
}
