import {
  extractCodexResumeId,
  extractConversationId,
  looksLikeClaudeProcess,
  looksLikeCodexProcess,
  parsePsOutput,
  providerForCommandLine,
} from "../src/process-discovery";

/**
 * Codex process discovery.
 *
 * The fixtures are real command lines, taken from `ps ax -o pid=,args=` on a
 * developer machine running the ChatGPT desktop app, the VS Code extension and
 * three Codex CLI sessions. That machine had 21 processes matching the word
 * "codex" and 3 were sessions, which is why this matcher checks the executable
 * and the subcommand rather than testing the string for "codex".
 *
 * Weighted heavily toward what must NOT match: discovery feeds adopt, and adopt
 * SIGTERMs what it finds. A false positive here is a killed process.
 */

// ─── Real sessions (must match) ────────────────────────────────────
const FRESH = "codex";
const RESUME = "codex resume 01a06e20-75ff-7cb2-8cc2-14fb76121928";
const RESUME_2 = "codex resume 01a06d74-8878-7851-a488-9543fe3b5504";

// ─── Real non-sessions (must not match) ────────────────────────────
const CHATGPT_APP_SERVER =
  "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled";
const VSCODE_APP_SERVER =
  "/Users/me/.vscode/extensions/openai.chatgpt-26.901.22334-darwin-arm64/bin/macos-aarch64/codex -c features.code_mode_host=true app-server";
const CODE_MODE_HOST = "/opt/homebrew/Caskroom/codex/0.153.4/bin/codex-code-mode-host";
const ELECTRON_RENDERER =
  "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/151.0.7922.174/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer";
const ELECTRON_SERVICE =
  "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/151.0.7922.174/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service) --type=gpu-process";
const COMPUTER_USE =
  "/Users/me/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService";
const EXTENSION_HOST =
  "/Users/me/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome";

describe("looksLikeCodexProcess", () => {
  it.each([
    ["a fresh session", FRESH],
    ["a fresh session with flags", "codex --cd /Users/me/project"],
    ["a resumed session", RESUME],
    ["an absolute path to the binary", "/opt/homebrew/bin/codex"],
    ["a Windows binary", "C:\\\\Users\\\\me\\\\bin\\\\codex.exe"],
  ])("matches %s", (_label, commandLine) => {
    expect(looksLikeCodexProcess(commandLine)).toBe(true);
  });

  // The two app-server entries are the load-bearing cases: their executable is
  // named exactly `codex`, so nothing but the subcommand separates them from a
  // session someone is typing at.
  it.each([
    ["the ChatGPT desktop app's app-server", CHATGPT_APP_SERVER],
    ["the VS Code extension's app-server", VSCODE_APP_SERVER],
    ["the code-mode-host sidecar", CODE_MODE_HOST],
    ["an Electron renderer helper", ELECTRON_RENDERER],
    ["an Electron service helper", ELECTRON_SERVICE],
    ["the computer-use service", COMPUTER_USE],
    ["the bundled Chrome extension host", EXTENSION_HOST],
    ["a non-interactive exec run", "codex exec 'do the thing'"],
    ["an mcp server", "codex mcp"],
    ["an empty command line", ""],
  ])("does not match %s", (_label, commandLine) => {
    expect(looksLikeCodexProcess(commandLine)).toBe(false);
  });

  // Scanning every token rather than locating "the subcommand" is what makes a
  // value-taking flag harmless: `codex -c model=gpt-5 resume <id>` is still a
  // session, and `codex --cd /srv/app` is too — an earlier version read the
  // flag's value as the subcommand and rejected both.
  it("is not confused by a flag that takes a value", () => {
    expect(
      looksLikeCodexProcess("codex -c model=gpt-5 resume 01a06e20-75ff-7cb2-8cc2-14fb76121928"),
    ).toBe(true);
    expect(looksLikeCodexProcess("codex -c features.x=true app-server")).toBe(false);
  });

  it("does not mistake a Claude process for Codex, or the reverse", () => {
    expect(looksLikeCodexProcess("claude --resume abc")).toBe(false);
    expect(looksLikeClaudeProcess(RESUME)).toBe(false);
  });
});

describe("providerForCommandLine", () => {
  it.each([
    ["claude", "claude", "claude-code"],
    ["a node-hosted Claude shim", "node /usr/lib/node_modules/claude-code/cli.js", "claude-code"],
    ["a fresh Codex session", FRESH, "codex-cli"],
    ["a resumed Codex session", RESUME, "codex-cli"],
  ])("identifies %s", (_label, commandLine, expected) => {
    expect(providerForCommandLine(commandLine)).toBe(expected);
  });

  it.each([
    ["the ChatGPT app-server", CHATGPT_APP_SERVER],
    ["an Electron helper", ELECTRON_RENDERER],
    ["an unrelated process", "vim notes.md"],
    ["a process merely mentioning codex", "grep -r codex ."],
  ])("returns null for %s", (_label, commandLine) => {
    expect(providerForCommandLine(commandLine)).toBeNull();
  });
});

describe("extractCodexResumeId", () => {
  it("pulls the rollout id out of a resume", () => {
    expect(extractCodexResumeId(RESUME)).toBe("01a06e20-75ff-7cb2-8cc2-14fb76121928");
    expect(extractCodexResumeId(RESUME_2)).toBe("01a06d74-8878-7851-a488-9543fe3b5504");
  });

  it("has no id for a fresh session", () => {
    expect(extractCodexResumeId(FRESH)).toBeNull();
  });

  // `codex resume --last` picks the most recent session and states no id.
  // Capturing "--last" would surface a conversation that does not exist, and
  // adopt would then kill a real process to resume a fictional id.
  it("refuses a resume that names no id", () => {
    expect(extractCodexResumeId("codex resume --last")).toBeNull();
  });

  it("refuses a non-uuid argument", () => {
    expect(extractCodexResumeId("codex resume not-a-uuid")).toBeNull();
  });

  it("routes by provider, since the two CLIs spell resume differently", () => {
    expect(extractConversationId(RESUME, "codex-cli")).toBe("01a06e20-75ff-7cb2-8cc2-14fb76121928");
    // Claude's flag form is invisible to the Codex extractor and vice versa.
    expect(extractConversationId("claude --resume abc-123", "claude-code")).toBe("abc-123");
    expect(extractConversationId("claude --resume abc-123", "codex-cli")).toBeNull();
  });
});

describe("parsePsOutput", () => {
  it("picks up both agents from one sweep and ignores everything else", () => {
    const stdout = [
      "  101 claude",
      `  102 ${RESUME}`,
      `  103 ${CHATGPT_APP_SERVER}`,
      `  104 ${ELECTRON_RENDERER}`,
      `  105 ${FRESH}`,
      "  106 vim notes.md",
    ].join("\n");

    expect(parsePsOutput(stdout)).toEqual([101, 102, 105]);
  });
});
