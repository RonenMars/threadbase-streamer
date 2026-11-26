import { driveQuestionForm } from "../src/services/questions/driveQuestionForm";
import { readFormScreen } from "../src/services/questions/readFormScreen";
import type { AskQuestion } from "../src/types";
import { DOWN, ENTER, FakeQuestionForm, LEFT, RIGHT } from "./helpers/fake-question-form";

const q = (question: string, labels: string[], multiSelect = false): AskQuestion => ({
  question,
  header: "",
  multiSelect,
  options: labels.map((label) => ({ label, description: "" })),
});

const FRUIT = q("Pick a fruit?", ["Apple", "Pear", "Plum"]);
const TOPPINGS = q("Pick toppings?", ["Salt", "Pepper", "Honey"], true);
const DRINK = q("Pick a drink?", ["Tea", "Coffee", "Water"]);
const SIDES = q("Pick sides?", ["Rice", "Beans", "Corn"], true);
const FOUR = [FRUIT, TOPPINGS, DRINK, SIDES];

const TIMING = { timeoutMs: 40, pollMs: 1 };
const drive = (form: FakeQuestionForm, selections: number[][], questions = form.questions) =>
  driveQuestionForm(form.terminal, questions, selections, TIMING);

// Every answer a question accepts: one option, or any non-empty set of them.
const choices = (question: AskQuestion): number[][] =>
  question.multiSelect
    ? Array.from({ length: 7 }, (_, m) => [0, 1, 2].filter((i) => (m + 1) & (1 << i)))
    : [[0], [1], [2]];

describe("the fake form paints what the parser reads (control)", () => {
  it("reads every tab and the review of an untouched form", () => {
    const form = new FakeQuestionForm(FOUR);
    const kinds = FOUR.map((_, i) => {
      const read = readFormScreen(form.paint(), FOUR);
      form.terminal.write(RIGHT);
      return read?.kind === "tab" && read.index === i;
    });
    expect(kinds).toEqual([true, true, true, true]);
    expect(readFormScreen(form.paint(), FOUR)).toMatchObject({ kind: "review" });
  });
});

describe("driveQuestionForm submits exactly the chosen options", () => {
  it.each([
    ["single, single", [FRUIT, DRINK]],
    ["single, multi", [FRUIT, TOPPINGS]],
    ["multi, single", [TOPPINGS, DRINK]],
    ["multi, multi", [TOPPINGS, SIDES]],
  ])("for every combination of %s", async (_name, questions) => {
    for (const first of choices(questions[0])) {
      for (const second of choices(questions[1])) {
        const form = new FakeQuestionForm(questions);
        expect(await drive(form, [first, second])).toEqual({ outcome: "answered" });
        expect(form.submitted).toEqual([first, second]);
      }
    }
  });

  it("for four mixed questions on a slowly repainting terminal", async () => {
    const form = new FakeQuestionForm(FOUR);
    form.lag = 3;
    expect(await drive(form, [[1], [0, 2], [2], [1]])).toEqual({ outcome: "answered" });
    expect(form.submitted).toEqual([[1], [0, 2], [2], [1]]);
  });

  it("over a form someone already half answered in the terminal", async () => {
    const form = new FakeQuestionForm(FOUR);
    form.single[0] = 2;
    form.cursor[0] = 2;
    form.ticks[1] = new Set([1, 2]);
    expect(await drive(form, [[0], [0], [1], [0]])).toEqual({ outcome: "answered" });
    expect(form.submitted).toEqual([[0], [0], [1], [0]]);
  });

  // Coming back to an unanswered tab resets its cursor, so the position seen
  // before the first key is out of date by the time the answer is chosen.
  it("from the cursor it sees after looking around, not the one it started on", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    form.cursor[0] = 2;
    expect(await drive(form, [[1], [0]])).toEqual({ outcome: "answered" });
    expect(form.submitted).toEqual([[1], [0]]);
  });

  it("sends one key per write", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    await drive(form, [[2], [0]]);
    // Look at both tabs and the review, come back, then answer.
    expect(form.writes).toEqual([RIGHT, RIGHT, LEFT, LEFT, DOWN, DOWN, ENTER, ENTER, ENTER]);
  });

  it("with an option label that holds a comma", async () => {
    const commas = q("Pick spices?", ["Salt, sea", "Salt", "Pepper"], true);
    const form = new FakeQuestionForm([commas, FRUIT]);
    expect(await drive(form, [[0, 1], [0]])).toEqual({ outcome: "answered" });
  });
});

describe("driveQuestionForm writes nothing unless tab 1 is up and readable", () => {
  const refused = async (form: FakeQuestionForm, questions = form.questions) => {
    const result = await drive(form, [[0], [0]], questions);
    expect(form.writes).toEqual([]);
    return result;
  };
  const two = () => new FakeQuestionForm([FRUIT, DRINK]);
  const notOnScreen = { outcome: "refused", reason: "not_on_screen" };

  it("at a plain prompt", async () => {
    const form = two();
    form.override = () => ["Done.", "", "❯ "];
    expect(await refused(form)).toEqual(notOnScreen);
  });

  it("on tab 2", async () => {
    const form = two();
    form.tab = 1;
    expect(await refused(form)).toEqual(notOnScreen);
  });

  it("on the review", async () => {
    const form = two();
    form.tab = 2;
    expect(await refused(form)).toEqual(notOnScreen);
  });

  it("on another form", async () => {
    expect(await refused(two(), [TOPPINGS, DRINK])).toEqual(notOnScreen);
  });

  it("on a form with a question the prompt lacks", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK, SIDES]);
    expect(await refused(form, [FRUIT, DRINK])).toEqual(notOnScreen);
  });

  it("with the cursor in the free-text field, where arrows move the text cursor", async () => {
    const form = two();
    form.cursor[0] = 3;
    expect(await refused(form)).toEqual(notOnScreen);
  });

  it("when the questions carry previews", async () => {
    const preview = { ...DRINK, options: [{ label: "Tea", description: "", preview: "x" }] };
    expect(await refused(two(), [FRUIT, preview])).toEqual({
      outcome: "refused",
      reason: "preview",
    });
  });

  it("when the screen shows a preview footer", async () => {
    const form = two();
    form.override = (lines) => [...lines.slice(0, -1), "Enter to select · n to add notes"];
    expect(await refused(form)).toEqual({ outcome: "refused", reason: "preview" });
  });

  it("when tab 1 still does not fit after growing", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK], [200]);
    expect(await refused(form)).toEqual({ outcome: "refused", reason: "too_tall" });
    expect(form.grown).toBe(1);
  });
});

describe("driveQuestionForm writes nothing for an answer the form cannot take", () => {
  it.each([
    ["too few selections", [[0]]],
    ["too many selections", [[0], [0], [0]]],
    ["a question left empty", [[0], []]],
    ["two options on a single-select", [[0, 1], [0]]],
    ["an option listed twice", [[0], [1, 1]]],
    ["an option past the end", [[3], [0]]],
    ["a negative option", [[-1], [0]]],
    ["a fractional option", [[0.5], [0]]],
  ])("%s", async (_name, selections) => {
    const form = new FakeQuestionForm([FRUIT, TOPPINGS]);
    expect(await drive(form, selections)).toEqual({ outcome: "refused", reason: "invalid" });
    expect(form.writes).toEqual([]);
  });

  it("a multi-select whose checkbox marker was never read", async () => {
    const form = new FakeQuestionForm([FRUIT, TOPPINGS]);
    const unverified = [FRUIT, { ...TOPPINGS, multiSelectUnverified: true }];
    expect(await drive(form, [[0], [0]], unverified)).toEqual({
      outcome: "refused",
      reason: "invalid",
    });
    expect(form.writes).toEqual([]);
  });
});

describe("driveQuestionForm grows only a form that does not fit", () => {
  it("leaves a fitting form alone", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    await drive(form, [[0], [0]]);
    expect(form.grown).toBe(0);
  });

  it.each([
    ["tab 1", [60]],
    ["a later tab", [0, 60]],
  ])("grows once when %s is too tall, then answers", async (_name, padding) => {
    const form = new FakeQuestionForm([FRUIT, DRINK], padding);
    expect(await drive(form, [[1], [2]])).toEqual({ outcome: "answered" });
    expect(form.grown).toBe(1);
    expect(form.submitted).toEqual([[1], [2]]);
  });

  it("stops as partly answered when a later tab still does not fit", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK], [0, 200]);
    expect(await drive(form, [[1], [2]])).toMatchObject({ outcome: "partial" });
    expect(form.writes).toEqual([RIGHT]);
  });
});

describe("driveQuestionForm stops at the first screen it did not expect", () => {
  const partial = { outcome: "partial" };

  // The fake's full run is a known key list; break the screen after each key.
  it("after any key: no further key is written and nothing is submitted", async () => {
    const selections = [[1], [0, 2]];
    const clean = new FakeQuestionForm([FRUIT, TOPPINGS]);
    await drive(clean, selections);
    for (let n = 1; n < clean.writes.length; n++) {
      const form = new FakeQuestionForm([FRUIT, TOPPINGS]);
      form.onWrite = (_key, count) => {
        if (count === n) form.override = () => ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
        return undefined;
      };
      expect(await drive(form, selections), `broken after key ${n}`).toMatchObject(partial);
      expect(form.writes.length).toBe(n);
      expect(form.submitted).toBeNull();
    }
  });

  it("when a key is ignored (timeout)", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    form.onWrite = (key) => (key === DOWN ? "ignore" : undefined);
    expect(await drive(form, [[1], [0]])).toMatchObject(partial);
    expect(form.writes).toEqual([RIGHT, RIGHT, LEFT, LEFT, DOWN]);
  });

  it("when the very first key is ignored", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    form.onWrite = () => "ignore";
    expect(await drive(form, [[1], [0]])).toMatchObject(partial);
    expect(form.writes).toEqual([RIGHT]);
  });

  it("when a toggle does not tick the box", async () => {
    const form = new FakeQuestionForm([TOPPINGS, DRINK]);
    form.onWrite = (key) => (key === " " ? "ignore" : undefined);
    expect(await drive(form, [[0], [0]])).toMatchObject(partial);
    // Nothing is written after the key that had no effect.
    expect(form.writes.at(-1)).toBe(" ");
    expect(form.writes.filter((k) => k === " ")).toHaveLength(1);
  });

  const onReview = async (edit: (lines: string[]) => string[]) => {
    const form = new FakeQuestionForm([FRUIT, TOPPINGS]);
    form.override = (lines) => (lines.at(-1)?.includes("Cancel") ? edit(lines) : lines);
    const result = await drive(form, [[1], [0, 2]]);
    expect(form.submitted).toBeNull();
    return result;
  };

  // The pre-pass also visits the review, so these edits leave an unanswered one
  // readable and only change what the final check looks at.
  it.each([
    ["shows another answer", (l: string) => l.replace("→ Pear", "→ Plum")],
    ["drops a ticked option", (l: string) => l.replace("→ Salt, Honey", "→ Salt")],
    ["adds an option", (l: string) => l.replace("→ Salt, Honey", "→ Salt, Honey, Pepper")],
    ["puts the cursor on Cancel", (l: string) => l.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")],
  ])("never submits a review that %s", async (_name, edit) => {
    expect(await onReview((lines) => lines.map(edit))).toMatchObject(partial);
  });

  it("never submits a review that warns of unanswered questions", async () => {
    const result = await onReview((lines) =>
      lines.some((l) => l.includes("→ Salt"))
        ? [...lines.slice(0, -3), "⚠ Some questions are unanswered", ...lines.slice(-3)]
        : lines,
    );
    expect(result).toMatchObject(partial);
  });

  it("when Submit does not close the form", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    let enters = 0;
    form.onWrite = (key) => (key === ENTER && ++enters === 3 ? "ignore" : undefined);
    expect(await drive(form, [[0], [0]])).toMatchObject(partial);
  });

  it("does not call it answered while the Submit row is still up", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    let enters = 0;
    form.onWrite = (key) => {
      if (key !== ENTER || ++enters < 3) return undefined;
      // Ignored, and the review no longer parses.
      form.override = (lines) => [...lines, "something under it"];
      return "ignore";
    };
    expect(await drive(form, [[0], [0]])).toMatchObject(partial);
  });

  it("gives a form that scrolls late a full wait to repaint after growing", async () => {
    vi.useFakeTimers();
    try {
      const form = new FakeQuestionForm([FRUIT, DRINK], [0, 60]);
      let tabTwoAt = 0;
      form.onWrite = (_key, count) => {
        if (count === 1) tabTwoAt = Date.now() + 30;
        return undefined;
      };
      // Tab 2 paints 30 ms after the key, and the taller terminal 20 ms after that.
      form.override = (lines) => (Date.now() < tabTwoAt ? ["…"] : lines);
      const grow = form.terminal.grow;
      const terminal = { ...form.terminal, grow: () => void setTimeout(grow, 20) };
      const result = driveQuestionForm(terminal, form.questions, [[0], [0]], TIMING);
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toEqual({ outcome: "answered" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("when a write fails after the first", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    form.onWrite = (_key, count) => {
      if (count === 3) throw new Error("PTY gone");
      return undefined;
    };
    expect(await drive(form, [[0], [0]])).toMatchObject(partial);
  });

  it("throws when the first write fails, since nothing was written", async () => {
    const form = new FakeQuestionForm([FRUIT, DRINK]);
    form.onWrite = () => {
      throw new Error("PTY gone");
    };
    await expect(drive(form, [[0], [0]])).rejects.toThrow("PTY gone");
  });
});
