import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { isQuestionMenuOnScreen } from "../src/services/questions/detectQuestionFromScreen";
import { renderRaw } from "./helpers/render-raw";

// Raw bytes captured from Claude Code 2.1.332 (haiku, 120x40) while stepping
// through AskUserQuestion forms with more than one question (#1044). These pin
// what each frame shows, so the recordings stay usable as ground truth for the
// code that will drive such a form. They do not claim the detector handles them.
const screen = async (name: string) => {
  const raw = readFileSync(
    join(__dirname, "fixtures", "ask-user-question", `claude-2.1.332-${name}.raw`),
    "utf8",
  );
  return (await renderRaw(raw)).map((line) => line.trim());
};

describe("multi-question AskUserQuestion on Claude Code 2.1.332", () => {
  it.each([
    ["two-single-tab1", "Pick a fruit?", "❯ 1. Apple"],
    // Enter on a single-select option moves to the next tab by itself.
    ["two-single-tab2-after-enter", "Pick a drink?", "❯ 1. Tea"],
    // Going back puts the cursor on the chosen option, with a trailing check.
    ["two-single-tab1-answered-revisit", "Pick a fruit?", "❯ 2. Pear ✔"],
    ["single-multi-tab2-multi-last", "Pick toppings?", "❯ 1. [ ] Salt"],
    ["single-multi-tab2-toggled", "Pick toppings?", "❯ 3. [✔] Honey"],
    // A multi-select revisit keeps its ticks and resets the cursor.
    ["single-multi-tab2-revisit-after-tab1", "Pick toppings?", "❯ 1. [✔] Salt"],
    // The unnumbered row that leaves a multi-select tab: Submit on the last one,
    ["single-multi-tab2-cursor-on-submit-row", "Pick toppings?", "❯    Submit"],
    // and Next otherwise.
    ["four-tab2-multi-next-row", "Pick toppings?", "Next"],
    ["four-tab1", "Pick a fruit?", "❯ 1. Apple"],
    // Headers and options can repeat; only the question text names the tab.
    ["same-header-tab1", "Pick one for the first slot?", "←  ☐ Slot  ☐ Slot  ✔ Submit  →"],
    ["same-header-tab2", "Pick one for the second slot?", "←  ☒ Slot  ☐ Slot  ✔ Submit  →"],
  ])("%s shows %s", async (name, question, row) => {
    const lines = await screen(name);
    expect(isQuestionMenuOnScreen(lines)).toBe(true);
    expect(lines).toContain(question);
    expect(lines).toContain(row);
  });

  it.each([
    ["two-single-review", ["→ Pear", "→ Water"]],
    ["single-multi-review", ["→ Apple", "→ Salt, Honey"]],
    ["four-review-after-burst", ["→ Pear", "→ Salt, Honey", "→ Water", "→ Beans"]],
    ["four-review-unanswered", ["⚠ Some questions are unanswered"]],
  ])("%s is the review screen, which has no menu footer", async (name, expected) => {
    const lines = await screen(name);
    for (const line of ["Review your answers", "❯ 1. Submit answers", "2. Cancel", ...expected]) {
      expect(lines).toContain(line);
    }
    expect(lines.some((line) => line.startsWith("Enter to select"))).toBe(false);
  });
});
