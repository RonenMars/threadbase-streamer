import { Terminal } from "@xterm/headless";
import { readPromptSuggestion } from "../src/services/questions/detectPromptSuggestion";

const RULE = "─".repeat(100);

async function screen(composer: string): Promise<Terminal> {
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const body = `\x1b[2J\x1b[H❯ old user message\r\n⏺ done\r\n\x1b[36;1H${RULE}\r\n${composer}\r\n${RULE}\r\n  ⏵⏵ auto mode on`;
  await new Promise<void>((r) => term.write(body, r));
  return term;
}

describe("readPromptSuggestion", () => {
  // Bytes as Claude Code v2.1.278 emitted them: ❯ plain, text inside ESC[2m … ESC[22m.
  it("returns dim text in the composer row", async () => {
    const t = await screen("❯ \x1b[2madd type hints and a docstring\x1b[22m");
    expect(readPromptSuggestion(t)).toBe("add type hints and a docstring");
  });

  // Positive control for the test above: the same text without SGR 2 is real
  // input and must not read as a suggestion, otherwise the dim check is inert.
  it("returns null for the same text typed by the user (not dim)", async () => {
    const t = await screen("❯ add type hints and a docstring");
    expect(readPromptSuggestion(t)).toBeNull();
  });

  it("returns null when only part of the text is dim (user typed over a suggestion)", async () => {
    const t = await screen("❯ add \x1b[2mtype hints\x1b[22m");
    expect(readPromptSuggestion(t)).toBeNull();
  });

  it("returns null for an empty composer", async () => {
    expect(readPromptSuggestion(await screen("❯ "))).toBeNull();
  });

  it("ignores a dim ❯ line that is not between the composer rules", async () => {
    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    await new Promise<void>((r) =>
      term.write("\x1b[2J\x1b[H❯ \x1b[2mnot a composer\x1b[22m\r\n", r),
    );
    expect(readPromptSuggestion(term)).toBeNull();
  });

  it("ignores the dim example tip older builds show in an empty composer", async () => {
    const t = await screen('❯ \x1b[2mTry "fix typecheck errors"\x1b[22m');
    expect(readPromptSuggestion(t)).toBeNull();
  });

  it("handles wide characters", async () => {
    const t = await screen("❯ \x1b[2m添加类型提示\x1b[22m");
    expect(readPromptSuggestion(t)).toBe("添加类型提示");
  });
});
