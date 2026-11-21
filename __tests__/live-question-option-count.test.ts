import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionOptions, type LiveSessionWiringDeps } from "../src/server-wiring";
import { detectQuestionFromScreen } from "../src/services/questions/detectQuestionFromScreen";
import { countRealOptions, isTerminalOnlyRow } from "../src/services/questions/terminalOnlyRows";
import { renderRaw } from "./helpers/render-raw";

// Claude Code 2.1.328 paints "Type something." and "Chat about this" after the
// model's own options. They are terminal rows, not choices, so a push that says
// "5 options" for a 3-option question is wrong.
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", "ask-user-question", name), "utf8");

function wiring() {
  const onPrompt = vi.fn();
  const deps = {
    waitingInputNotifier: () => ({ onPrompt }),
    sessionStore: { get: () => ({ id: "s1" }) },
    ptyAttachedIds: () => new Set<string>(),
    sessionHandlers: () => ({ handleLiveQuestion: vi.fn() }),
  } as unknown as LiveSessionWiringDeps;
  return { options: createLiveSessionOptions(deps), onPrompt };
}

describe("terminal-only rows", () => {
  it("matches the two rows Claude Code appends, trimmed and case-insensitive", () => {
    expect(isTerminalOnlyRow("Type something.")).toBe(true);
    expect(isTerminalOnlyRow("  type something ")).toBe(true);
    expect(isTerminalOnlyRow("Chat about this")).toBe(true);
    expect(isTerminalOnlyRow("Red")).toBe(false);
    expect(isTerminalOnlyRow("Type something else")).toBe(false);
  });

  it("counts only the model's own options", () => {
    const o = (label: string) => ({ label, description: "" });
    expect(countRealOptions([o("A"), o("B"), o("Type something."), o("Chat about this")])).toBe(2);
  });
});

describe("question push option count", () => {
  it("a screen-scraped 3-option question with the two terminal rows reports 3", async () => {
    const lines = await renderRaw(fixture("claude-2.1.328-menu.raw"));
    const detected = detectQuestionFromScreen(lines);
    // Positive control: the scrape really does carry all five rows.
    expect(detected?.questions[0].options.map((o) => o.label)).toEqual([
      "Red",
      "Green",
      "Blue",
      "Type something.",
      "Chat about this",
    ]);

    const { options, onPrompt } = wiring();
    options.onLiveQuestion?.("s1", detected!.questions, "occ-1");

    expect(onPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "question",
      true,
      { optionCount: 3 },
      undefined,
    );
  });

  it("a structured question (no terminal rows in options) still reports its own count", () => {
    const { options, onPrompt } = wiring();
    const o = (label: string) => ({ label, description: "" });
    options.onLiveQuestion?.(
      "s1",
      [{ question: "Q?", header: "", multiSelect: false, options: [o("A"), o("B")] }],
      "occ-1",
    );
    expect(onPrompt.mock.calls[0][3]).toEqual({ optionCount: 2 });
  });
});
