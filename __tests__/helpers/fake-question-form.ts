import type { AskQuestion } from "../../src/types";

// A stand-in for Claude Code 2.1.332's multi-question form. It paints the rows
// the recordings in fixtures/ask-user-question show and copies only the key
// behaviour verified against the real CLI: a single-select Enter answers and
// advances; a multi-select Space or Enter toggles and never advances; Left and
// Right change tab and toggle nothing; a revisited single-select puts the cursor
// on its answer. A form taller than the terminal loses its top rows.

export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const RIGHT = "\x1b[C";
export const LEFT = "\x1b[D";
export const ENTER = "\r";

const RULE = "─".repeat(60);
const FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";

export class FakeQuestionForm {
  tab = 0;
  cursor: number[];
  single: (number | null)[];
  ticks: Set<number>[];
  reviewCursor = 0;
  writes: string[] = [];
  submitted: number[][] | null = null;
  rows = 40;
  grown = 0;
  // Test hooks: replace the screen, or drop a key without painting.
  override: ((lines: string[]) => string[]) | null = null;
  onWrite: ((key: string, count: number) => "ignore" | undefined) | null = null;
  // Repaint lag: a read returns the previous frame this many times.
  lag = 0;
  private stale: string[] = [];
  private staleReads = 0;

  constructor(
    public questions: AskQuestion[],
    // Extra description rows per tab, to make a tab taller than the terminal.
    private padding: number[] = [],
  ) {
    this.cursor = questions.map(() => 0);
    this.single = questions.map(() => null);
    this.ticks = questions.map(() => new Set<number>());
  }

  readonly terminal = {
    read: async (): Promise<string[]> => {
      if (this.staleReads > 0) {
        this.staleReads--;
        return this.stale;
      }
      return this.paint();
    },
    write: (key: string): void => {
      const before = this.paint();
      this.writes.push(key);
      if (this.onWrite?.(key, this.writes.length) === "ignore") return;
      this.press(key);
      this.stale = before;
      this.staleReads = this.lag;
    },
    grow: (): void => {
      this.grown++;
      this.rows = 100;
    },
  };

  paint(): string[] {
    const lines = this.frame();
    return this.override ? this.override(lines) : lines;
  }

  // What was submitted, or what the form holds if it never was.
  held(): number[][] {
    return this.questions.map((q, i) => {
      const picked = this.single[i];
      return q.multiSelect
        ? [...this.ticks[i]].sort((a, b) => a - b)
        : picked === null
          ? []
          : [picked];
    });
  }

  private frame(): string[] {
    if (this.submitted) return ["● User answered Claude's questions:", "", "❯ "];
    const chips = this.questions
      .map((_, i) => `${this.held()[i].length ? "☒" : "☐"} H${i}`)
      .join("  ");
    const head = ["Earlier output", RULE, `←  ${chips}  ✔ Submit  →`, ""];
    if (this.tab === this.questions.length) return [...head, ...this.review()];

    const q = this.questions[this.tab];
    const count = q.options.length;
    const at = (row: number) => (this.cursor[this.tab] === row ? "❯ " : "  ");
    const body = [q.question, ""];
    q.options.forEach((o, i) => {
      const box = q.multiSelect ? `[${this.ticks[this.tab].has(i) ? "✔" : " "}] ` : "";
      const mark = !q.multiSelect && this.single[this.tab] === i ? " ✔" : "";
      body.push(`${at(i)}${i + 1}. ${box}${o.label}${mark}`, `     About ${i}`);
    });
    for (let i = 0; i < (this.padding[this.tab] ?? 0); i++) body.push(`     more ${i}`);
    body.push(
      `${at(count)}${count + 1}. ${q.multiSelect ? "[ ] Type something" : "Type something."}`,
    );
    if (q.multiSelect) {
      const word = this.tab === this.questions.length - 1 ? "Submit" : "Next";
      body.push(`${at(count + 1)}   ${word}`);
    }
    const chat = q.multiSelect ? count + 2 : count + 1;
    body.push(RULE, `${at(chat)}${count + 2}. Chat about this`, "");

    const full = [...head, ...body, FOOTER];
    const form = full.length - 1;
    if (form <= this.rows) return full;
    // Scrolled: the top of the form is gone.
    return [...body.slice(-(this.rows - 2)), ` ↑ ${form - this.rows} more lines`, FOOTER];
  }

  private review(): string[] {
    const lines = ["Review your answers", " "];
    const held = this.held();
    if (held.some((a) => a.length === 0)) lines.push("⚠ Some questions are unanswered", " ");
    held.forEach((answer, i) => {
      if (!answer.length) return;
      const q = this.questions[i];
      lines.push(` ● ${q.question}`, `   → ${answer.map((a) => q.options[a].label).join(", ")}`);
    });
    const at = (row: number) => (this.reviewCursor === row ? "❯ " : "  ");
    lines.push(" ", `${at(0)}1. Submit answers`, `${at(1)}2. Cancel`);
    return lines;
  }

  private press(key: string): void {
    if (this.submitted) return;
    const last = this.questions.length;
    if (key === LEFT) {
      if (this.tab > 0) this.show(this.tab - 1);
      return;
    }
    if (key === RIGHT) {
      if (this.tab < last) this.show(this.tab + 1);
      return;
    }
    if (this.tab === last) {
      if (key === DOWN) this.reviewCursor = 1;
      if (key === UP) this.reviewCursor = 0;
      if (key === ENTER && this.reviewCursor === 0) this.submitted = this.held();
      return;
    }
    const q = this.questions[this.tab];
    const rows = q.options.length + (q.multiSelect ? 3 : 2);
    const cursor = this.cursor[this.tab];
    if (key === DOWN) this.cursor[this.tab] = Math.min(rows - 1, cursor + 1);
    else if (key === UP) this.cursor[this.tab] = Math.max(0, cursor - 1);
    else if (cursor >= q.options.length) throw new Error(`Key on a terminal row: ${key}`);
    else if (q.multiSelect && (key === " " || key === ENTER)) {
      if (!this.ticks[this.tab].delete(cursor)) this.ticks[this.tab].add(cursor);
    } else if (key === ENTER) {
      this.single[this.tab] = cursor;
      this.show(this.tab + 1);
    } else throw new Error(`Unexpected key ${JSON.stringify(key)}`);
  }

  private show(tab: number): void {
    this.tab = tab;
    this.reviewCursor = 0;
    if (tab === this.questions.length) return;
    // Only a revisited single-select remembers where it was.
    this.cursor[tab] = this.single[tab] ?? 0;
  }
}
