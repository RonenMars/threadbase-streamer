// The multi-question driver sends a key only when this parser can say exactly
// which tab is up, where the cursor is and what is ticked. Replays real Claude
// Code 2.1.332 recordings, read the way getOutputLines reads them.

import { Terminal } from "@xterm/headless";
import { readFileSync } from "fs";
import { join } from "path";
import { readFormScreen } from "../src/services/questions/readFormScreen";
import type { AskQuestion } from "../src/types";

async function screen(name: string, cols = 120, rows = 40): Promise<string[]> {
  const raw = readFileSync(
    join(__dirname, "fixtures", "ask-user-question", `claude-2.1.332-${name}.raw`),
    "utf8",
  );
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(raw, resolve));
  const lines: string[] = [];
  for (let y = 0; y < term.buffer.active.length; y++) {
    lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
  }
  term.dispose();
  while (lines.at(-1) === "") lines.pop();
  return lines.slice(-rows);
}

const q = (question: string, labels: string[], multiSelect = false): AskQuestion => ({
  question,
  header: "",
  multiSelect,
  options: labels.map((label) => ({ label, description: "" })),
});

const FRUIT = q("Pick a fruit?", ["Apple", "Pear", "Plum"]);
const DRINK = q("Pick a drink?", ["Tea", "Coffee", "Water"]);
const TWO = [FRUIT, DRINK];
const SINGLE_MULTI = [FRUIT, q("Pick toppings?", ["Salt", "Pepper", "Honey", "Mint"], true)];
const FOUR = [
  FRUIT,
  q("Pick toppings?", ["Salt", "Pepper", "Honey"], true),
  DRINK,
  q("Pick sides?", ["Rice", "Beans", "Corn"], true),
];
const SLOTS = ["first", "second"].map((slot) =>
  q(`Pick one for the ${slot} slot?`, ["Alpha", "Beta", "Gamma"]),
);
const clauses = Array.from(
  { length: 10 },
  (_, i) =>
    `Clause ${i + 1} says the sample orchard keeps careful notes about every basket of fruit it packs.`,
).join(" ");
const LONG = [
  q(`${clauses} Which fruit should be packed first?`, ["Apple", "Pear", "Plum"]),
  q(`${clauses} Which toppings should be added?`, ["Salt", "Pepper", "Honey"], true),
];

const none = (n: number) => Array<boolean>(n).fill(false);
const tab = (index: number, cursor: number, checked: boolean[]) => ({
  kind: "tab",
  index,
  cursor,
  checked,
});

describe("readFormScreen on a question tab", () => {
  it.each([
    ["two-single-tab1", TWO, tab(0, 0, none(3))],
    ["two-single-tab2-after-enter", TWO, tab(1, 0, none(3))],
    ["two-single-tab1-answered-revisit", TWO, tab(0, 1, none(3))],
    ["four-tab1", FOUR, tab(0, 0, none(3))],
    ["four-tab2-multi-next-row", FOUR, tab(1, 0, none(3))],
    ["single-multi-tab2-multi-last", SINGLE_MULTI, tab(1, 0, none(4))],
    ["single-multi-tab2-toggled", SINGLE_MULTI, tab(1, 2, [true, false, true, false])],
    // The unnumbered Next/Submit row sits one past "Type something" (index 4).
    ["single-multi-tab2-cursor-on-submit-row", SINGLE_MULTI, tab(1, 5, [true, false, true, false])],
    ["single-multi-tab2-revisit-after-tab1", SINGLE_MULTI, tab(1, 0, [true, false, true, false])],
    ["same-header-tab1", SLOTS, tab(0, 0, none(3))],
    ["same-header-tab2", SLOTS, tab(1, 0, none(3))],
    ["long-question-tab1", LONG, tab(0, 0, none(3))],
    ["long-question-tab2", LONG, tab(1, 0, none(3))],
  ])("reads %s", async (name, questions, expected) => {
    expect(readFormScreen(await screen(name), questions)).toEqual(expected);
  });

  it.each([
    ["50x40-four-tab1", tab(0, 0, none(3))],
    ["50x40-four-tab4", tab(3, 0, none(3))],
  ])("reads %s, with cut headers and a wrapped footer", async (name, expected) => {
    expect(readFormScreen(await screen(name, 50), FOUR)).toEqual(expected);
  });

  it("reads a cursor on Type something and on Chat about this", async () => {
    const lines = await screen("two-single-tab1");
    const moveTo = (row: RegExp) =>
      lines.map((l) => (row.test(l) ? l.replace(/^ {2}/, "❯ ") : l.replace(/^❯ /, "  ")));
    expect(readFormScreen(moveTo(/Type something/), TWO)).toEqual(tab(0, 3, none(3)));
    expect(readFormScreen(moveTo(/Chat about this/), TWO)).toEqual(tab(0, 4, none(3)));
  });

  it("matches a label that wraps onto a second row", async () => {
    const lines = (await screen("two-single-tab1")).flatMap((l) =>
      l.includes("2. Pear") ? ["  2. Pe", "     ar"] : [l],
    );
    expect(readFormScreen(lines, TWO)).toEqual(tab(0, 0, none(3)));
  });
});

describe("readFormScreen refuses a tab it cannot vouch for", () => {
  const withOptions = (labels: string[]) => [q("Pick a fruit?", labels), DRINK];

  it.each([
    ["another form's questions", SLOTS],
    ["a form with more questions than the tab bar shows", [...TWO, q("Pick again?", ["A", "B"])]],
    ["a changed label", withOptions(["Apple", "Peach", "Plum"])],
    ["a label that only starts the same", withOptions(["Apple", "Pea", "Plum"])],
    ["one option fewer than on screen", withOptions(["Apple", "Pear"])],
    ["one option more than on screen", withOptions(["Apple", "Pear", "Plum", "Fig"])],
    ["a multi-select where the screen has no checkboxes", [{ ...FRUIT, multiSelect: true }, DRINK]],
    ["two questions with the same text", [FRUIT, FRUIT]],
  ])("%s", async (_what, questions) => {
    expect(readFormScreen(await screen("two-single-tab1"), questions)).toBeNull();
  });

  it("a single-select where the screen has checkboxes", async () => {
    const lines = await screen("single-multi-tab2-multi-last");
    const questions = [FRUIT, { ...SINGLE_MULTI[1], multiSelect: false }];
    expect(readFormScreen(lines, questions)).toBeNull();
  });

  const edited = async (edit: (lines: string[]) => string[]) =>
    readFormScreen(edit(await screen("two-single-tab1")), TWO);

  it("a form with later output under it (stale scrollback)", async () => {
    expect(await edited((l) => [...l, "one", "two", "three"])).toBeNull();
  });

  it("no cursor", async () => {
    expect(await edited((l) => l.map((x) => x.replace("❯ 1.", "  1.")))).toBeNull();
  });

  it("two cursors", async () => {
    expect(await edited((l) => l.map((x) => x.replace("  2. Pear", "❯ 2. Pear")))).toBeNull();
  });

  it("no tab bar", async () => {
    expect(await edited((l) => l.filter((x) => !x.includes("✔ Submit")))).toBeNull();
  });

  it("a plain prompt", () => {
    expect(readFormScreen(["Done.", "", "❯ "], TWO)).toBeNull();
  });
});

describe("readFormScreen on a form that cannot be read as painted", () => {
  it.each([
    ["overflow-tab1", 40],
    ["overflow-tab2", 40],
    ["120x24-overflow-tab2", 24],
    ["120x24-overflow-back-to-tab1", 24],
  ])("calls %s scrolled", async (name, rows) => {
    expect(readFormScreen(await screen(name, 120, rows), TWO)).toEqual({ kind: "scrolled" });
  });

  it.each([
    ["preview-tab1", 120],
    ["preview-revisit", 120],
    ["preview-cursor-on-chat", 120],
    ["80x40-preview-tab1", 80],
  ])("calls %s a preview form", async (name, cols) => {
    expect(readFormScreen(await screen(name, cols), TWO)).toEqual({ kind: "preview" });
  });

  it("calls a review whose top is off screen scrolled", async () => {
    const lines = await screen("four-review-after-burst");
    expect(readFormScreen(lines.slice(-6), FOUR)).toEqual({ kind: "scrolled" });
  });
});

describe("readFormScreen on the review screen", () => {
  const review = (answers: (string | null)[], unanswered = false, cursor = "submit") => ({
    kind: "review",
    answers,
    unanswered,
    cursor,
  });

  // Answers come back with all whitespace removed, since a long one wraps.
  it.each([
    ["two-single-review", TWO, review(["Pear", "Water"])],
    ["single-multi-review", SINGLE_MULTI, review(["Apple", "Salt,Honey"])],
    ["four-review-after-burst", FOUR, review(["Pear", "Salt,Honey", "Water", "Beans"])],
    ["four-review-partial", FOUR, review(["Pear", "Salt", null, null], true)],
    ["four-review-unanswered", FOUR, review([null, null, null, null], true)],
  ])("reads %s", async (name, questions, expected) => {
    expect(readFormScreen(await screen(name), questions)).toEqual(expected);
  });

  const edited = async (edit: (lines: string[]) => string[]) =>
    readFormScreen(edit(await screen("two-single-review")), TWO);

  it("reads a cursor on Cancel", async () => {
    const read = await edited((l) =>
      l.map((x) => x.replace("❯ 1.", "  1.").replace("  2. Cancel", "❯ 2. Cancel")),
    );
    expect(read).toEqual(review(["Pear", "Water"], false, "cancel"));
  });

  it("joins an answer that wraps", async () => {
    const read = await edited((l) =>
      l.flatMap((x) => (x.includes("→ Pear") ? ["   → Pe", "     ar"] : [x])),
    );
    expect(read).toEqual(review(["Pear", "Water"]));
  });

  it("refuses a question that is not in the form", async () => {
    expect(await edited((l) => l.map((x) => x.replace("drink?", "snack?")))).toBeNull();
  });

  it("refuses a review with later output under it", async () => {
    expect(await edited((l) => [...l, "Thinking"])).toBeNull();
  });
});
