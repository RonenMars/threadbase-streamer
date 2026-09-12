import { codexScreenShowsReady, detectCodexPicker } from "../src/services/questions/codexScreen";

// #868. Captured from codex-cli 0.154.0 spawned as CodexPtyRunner spawns it
// (`codex --cd <dir> --no-alt-screen`, @xterm/headless at 120x40) against a
// scratch CODEX_HOME; identical to the screen the streamer rendered live.
const SIGN_IN_PICKER = [
  "  Welcome to Codex, OpenAI's command-line coding agent",
  "  Sign in with ChatGPT to use Codex as part of your paid plan",
  "  or connect an API key for usage-based billing",
  "> 1. Sign in with ChatGPT",
  "     Usage included with Plus, Pro, Business, and Enterprise plans",
  "  2. Sign in with Device Code",
  "     Sign in from another device with a one-time code",
  "  3. Provide your own API key",
  "     Pay for what you use",
  "  Press enter to continue",
];

// What option 3 leads to — no numbered rows at all.
const API_KEY_ENTRY = [
  "  Welcome to Codex, OpenAI's command-line coding agent",
  "> Use your own OpenAI API key for usage-based billing",
  "  Paste or type your API key below. It will be stored locally in auth.json.",
  "  Press enter to save",
  "  Press esc to go back",
];

describe("detectCodexPicker", () => {
  it("claims the sign-in picker, with the trailing footer as neither prompt nor option", () => {
    const card = detectCodexPicker(SIGN_IN_PICKER);
    expect(card?.options).toEqual([
      { index: 1, label: "Sign in with ChatGPT", answerKeys: "1" },
      { index: 2, label: "Sign in with Device Code", answerKeys: "2" },
      { index: 3, label: "Provide your own API key", answerKeys: "3" },
    ]);
    expect(card?.prompt).toBe("or connect an API key for usage-based billing");
    expect(card?.detail).toContain("Sign in with ChatGPT to use Codex as part of your paid plan");
  });

  it("claims a plain numbered menu with no description rows", () => {
    const card = detectCodexPicker(["  Choose a model", "› 1. Fast", "  2. Thorough"]);
    expect(card?.options.map((o) => o.index)).toEqual([1, 2]);
  });

  it("does not claim the API key entry screen", () => {
    expect(detectCodexPicker(API_KEY_ENTRY)).toBeNull();
  });

  it("does not claim Codex's own trust gate", () => {
    const screen = [
      "  Do you trust the contents of this directory?",
      "> 1. Yes, continue",
      "  2. No, quit",
    ];
    expect(detectCodexPicker(screen)).toBeNull();
  });

  // A live session's transcript can hold a numbered list; the compose line
  // below it is what says the menu is not waiting for an answer.
  it("does not claim a numbered list above the compose line", () => {
    const screen = [
      "  Here is the plan:",
      "> 1. Update the parser",
      "  2. Add the tests",
      "",
      "› ",
      "gpt-5.5 medium · /path · gpt-5.5 · medium · Wo…",
    ];
    expect(codexScreenShowsReady(screen)).toBe(false); // the Ready guard is not what rejects it
    expect(detectCodexPicker(screen)).toBeNull();
  });

  it("does not claim a menu on a Ready screen", () => {
    const screen = [
      "  Options:",
      "> 1. One",
      "  2. Two",
      "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…",
    ];
    expect(detectCodexPicker(screen)).toBeNull();
  });

  it("does not claim a single numbered row, or rows with no cursor", () => {
    expect(detectCodexPicker(["  Pick:", "> 1. Only one"])).toBeNull();
    expect(detectCodexPicker(["  Pick:", "  1. One", "  2. Two"])).toBeNull();
  });

  it("does not claim rows separated by a blank line", () => {
    expect(detectCodexPicker(["  Pick:", "> 1. One", "", "  2. Two"])).toBeNull();
  });
});
