import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { planAnswer } from "../src/services/questions/answersToKeystrokes";
import {
  detectQuestionFromScreen,
  isQuestionMenuOnScreen,
  questionCursorRow,
} from "../src/services/questions/detectQuestionFromScreen";
import { renderRaw } from "./helpers/render-raw";

// Raw bytes captured from Claude Code 2.1.328 (haiku, 120x40) for a 3-option
// single-select AskUserQuestion, with the cursor stepped to each row in turn.
// Rendered here rather than stored as text so the layout the detector has to
// survive (the rule drawn between rows 4 and 5, the composer's own `❯`, the
// footer that gains "ctrl+g to edit" while the field is focused) is the real one.
const screen = (name: string) =>
  renderRaw(
    readFileSync(
      join(__dirname, "fixtures", "ask-user-question", `claude-2.1.328-${name}.raw`),
      "utf8",
    ),
  );

describe("AskUserQuestion on Claude Code 2.1.328", () => {
  it.each([
    ["menu", 0],
    ["type-row-focused", 3],
    ["type-row-typed", 3], // the field shows the typed text where its label was
    ["chat-row-focused", 4],
  ])("%s: cursor row %i, menu recognised, composer ❯ ignored", async (name, row) => {
    const lines = await screen(name);
    expect(isQuestionMenuOnScreen(lines)).toBe(true);
    expect(questionCursorRow(lines)).toBe(row);
  });

  it("no menu, no cursor row", () => {
    expect(questionCursorRow(["❯ some prompt", "  1. a list in prose"])).toBeNull();
  });

  it("the screen card plans the same rows the TUI put the cursor on", async () => {
    const detected = detectQuestionFromScreen(await screen("menu"));
    const questions = detected?.questions ?? [];
    expect(questions[0].options.map((o) => o.label)).toEqual([
      "Red",
      "Green",
      "Blue",
      "Type something.",
      "Chat about this",
    ]);
    // The two rows say what they are, so a client need not match their labels.
    expect(questions[0].options.map((o) => o.terminalRow)).toEqual([
      undefined,
      undefined,
      undefined,
      "other",
      "chat",
    ]);
    const q = questions[0].question;
    expect(planAnswer(questions, { [q]: { other: "x" } })).toEqual({
      freeText: { row: await cursorOf("type-row-focused"), text: "x" },
    });
    expect(planAnswer(questions, { [q]: "Chat about this" })).toEqual({
      keys: `${"\x1b[B".repeat(await cursorOf("chat-row-focused"))}\r`,
    });
  });
});

async function cursorOf(name: string): Promise<number> {
  return questionCursorRow(await screen(name)) ?? -1;
}
