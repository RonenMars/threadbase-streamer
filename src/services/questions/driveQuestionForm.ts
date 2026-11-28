import type { AskQuestion } from "../../types";
import { keysForMove } from "./answersToKeystrokes";
import { type FormScreen, readFormScreen, squash } from "./readFormScreen";

// Answers a multi-question AskUserQuestion form one key at a time. Every key is
// planned from the screen as it is, and the next one is written only after the
// screen shows exactly what that key should have done. Nothing is ever resent.
// A key cannot be taken back, so a stop after the first one is "partial".

const SPACE = " ";
const ENTER = "\r";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const SUBMIT_ROW_RE = /Submit answers\s*$/;

export interface FormTerminal {
  /** The rendered rows, as many as the terminal is tall. */
  read(): Promise<string[]>;
  /** `submits` marks the one key that hands the answers to the agent. */
  write(key: string, submits?: boolean): void;
  /** Make the terminal tall enough for a form that scrolled. Restoring is the caller's job. */
  grow(): void;
}

export type DriveResult =
  | { outcome: "answered" }
  /** Nothing was written. */
  | { outcome: "refused"; reason: "invalid" | "not_on_screen" | "preview" | "too_tall" }
  /** Keys were written and the form is in an unknown state. */
  | { outcome: "partial"; reason: string };

type Tab = Extract<FormScreen, { kind: "tab" }>;
type Match<T> = (screen: FormScreen | null, lines: string[]) => T | null;

function answerable(q: AskQuestion, picked: number[]): boolean {
  if (q.multiSelect && q.multiSelectUnverified) return false;
  if (picked.length === 0 || (!q.multiSelect && picked.length > 1)) return false;
  if (new Set(picked).size !== picked.length) return false;
  return picked.every((o) => Number.isInteger(o) && o >= 0 && o < q.options.length);
}

// The review lists a multi-select's labels comma-joined, and a label may itself
// hold a comma, so match the text against the labels instead of splitting it.
function isJoinOf(text: string, labels: string[]): boolean {
  if (labels.length === 1) return text === labels[0];
  return labels.some(
    (label, i) =>
      text.startsWith(`${label},`) &&
      isJoinOf(
        text.slice(label.length + 1),
        labels.filter((_, other) => other !== i),
      ),
  );
}

/** `selections[i]` holds the option indexes chosen for `questions[i]`. */
export async function driveQuestionForm(
  terminal: FormTerminal,
  questions: AskQuestion[],
  selections: number[][],
  timing: { timeoutMs: number; pollMs: number },
): Promise<DriveResult> {
  const total = questions.length;
  if (selections.length !== total || !questions.every((q, i) => answerable(q, selections[i]))) {
    return { outcome: "refused", reason: "invalid" };
  }
  if (questions.some((q) => q.options.some((o) => o.preview !== undefined))) {
    return { outcome: "refused", reason: "preview" };
  }

  let grown = false;
  let wrote = false;

  async function waitFor<T>(match: Match<T>): Promise<{ hit: T | null; last: FormScreen | null }> {
    let deadline = Date.now() + timing.timeoutMs;
    for (;;) {
      const lines = await terminal.read();
      const screen = readFormScreen(lines, questions);
      if (screen?.kind === "scrolled" && !grown) {
        grown = true;
        terminal.grow();
        deadline = Date.now() + timing.timeoutMs;
      } else {
        const hit = match(screen, lines);
        if (hit !== null) return { hit, last: screen };
        if (Date.now() >= deadline) return { hit: null, last: screen };
      }
      await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
    }
  }

  async function press<T>(
    key: string,
    step: string,
    match: Match<T>,
    submits?: boolean,
  ): Promise<T> {
    terminal.write(key, submits);
    wrote = true;
    const { hit } = await waitFor(match);
    if (hit === null) throw new Error(`the screen did not show ${step}`);
    return hit;
  }

  // A tab is usable only with the cursor on an option row: on "Type something"
  // the arrows move a text cursor, and the rows under it were never driven.
  const tabAt = (screen: FormScreen | null, index: number): Tab | null =>
    screen?.kind === "tab" &&
    screen.index === index &&
    screen.cursor < questions[index].options.length
      ? screen
      : null;

  const toTab = (key: string, index: number) =>
    press(key, `question ${index + 1}`, (screen) => tabAt(screen, index));

  const toReview = (key: string) =>
    press(key, "the review", (screen) => (screen?.kind === "review" ? screen : null));

  // Within one tab: the cursor and the ticks must be exactly these.
  const onTab = (key: string, index: number, cursor: number, checked: boolean[]) =>
    press(key, `the key's effect on question ${index + 1}`, (screen) => {
      const tab = tabAt(screen, index);
      return tab?.cursor === cursor && tab.checked.join() === checked.join() ? tab : null;
    });

  async function answerTab(tab: Tab, picked: number[]): Promise<void> {
    const { index } = tab;
    const { multiSelect, options } = questions[index];
    let now = tab;
    const moveTo = async (target: number) => {
      while (now.cursor !== target) {
        const step = Math.sign(target - now.cursor);
        now = await onTab(keysForMove(step), index, now.cursor + step, now.checked);
      }
    };
    if (!multiSelect) return moveTo(picked[0]);
    for (let o = 0; o < options.length; o++) {
      if (now.checked[o] === picked.includes(o)) continue;
      await moveTo(o);
      const ticked = now.checked.map((was, i) => (i === o ? !was : was));
      now = await onTab(SPACE, index, o, ticked);
    }
  }

  const first = await waitFor((screen) => (screen?.kind === "preview" ? screen : tabAt(screen, 0)));
  if (first.hit?.kind === "preview") return { outcome: "refused", reason: "preview" };
  if (!first.hit) {
    const reason = first.last?.kind === "scrolled" ? "too_tall" : "not_on_screen";
    return { outcome: "refused", reason };
  }

  try {
    // Look at every tab and the review before choosing anything.
    for (let i = 1; i < total; i++) await toTab(RIGHT, i);
    await toReview(RIGHT);
    let tab = await toTab(LEFT, total - 1);
    for (let i = total - 2; i >= 0; i--) tab = await toTab(LEFT, i);

    for (let i = 0; i < total; i++) {
      await answerTab(tab, selections[i]);
      // A single-select Enter answers and advances; on a multi-select it would
      // toggle, so that one is left with the Right arrow.
      const commit = questions[i].multiSelect ? RIGHT : ENTER;
      if (i < total - 1) tab = await toTab(commit, i + 1);
      else {
        await press(commit, "a review of exactly these answers", (screen) => {
          if (screen?.kind !== "review" || screen.unanswered || screen.cursor !== "submit") {
            return null;
          }
          const same = screen.answers.every((answer, q) => {
            const labels = selections[q].map((o) => squash(questions[q].options[o].label));
            return answer !== null && isJoinOf(answer, labels);
          });
          return same ? screen : null;
        });
      }
    }

    await press(
      ENTER,
      "the form closing",
      (screen, lines) =>
        screen === null && !lines.some((l) => SUBMIT_ROW_RE.test(l)) ? true : null,
      true,
    );
    return { outcome: "answered" };
  } catch (err) {
    if (!wrote) throw err;
    return { outcome: "partial", reason: err instanceof Error ? err.message : String(err) };
  }
}
