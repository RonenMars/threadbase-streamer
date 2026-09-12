import {
  extractConversationId,
  looksLikeCursorProcess,
  providerForCommandLine,
} from "../src/process-discovery";

/**
 * `agent` is a crowded argv[0]. Discovery feeds adopt, and adopt SIGTERMs what
 * it finds, so this matcher is a deny-list of non-interactive Cursor CLI verbs
 * plus an exact executable name.
 */

describe("looksLikeCursorProcess", () => {
  it.each([
    ["a fresh session", "agent"],
    ["a resumed session", "agent --resume=abc-123"],
    ["resume subcommand", "agent resume"],
    ["absolute path", "/Users/me/.local/bin/agent"],
    ["cursor-agent alias", "cursor-agent --workspace /tmp/proj"],
    ["Windows binary", "C:\\\\Users\\\\me\\\\bin\\\\agent.exe"],
  ])("matches %s", (_label, commandLine) => {
    expect(looksLikeCursorProcess(commandLine)).toBe(true);
  });

  it.each([
    ["login", "agent login"],
    ["mcp", "agent mcp list"],
    ["worker", "agent worker start"],
    ["update", "agent update"],
    ["create-chat", "agent create-chat"],
    ["the editor binary", "cursor ."],
    ["an empty command line", ""],
  ])("does not match %s", (_label, commandLine) => {
    expect(looksLikeCursorProcess(commandLine)).toBe(false);
  });
});

describe("providerForCommandLine — cursor-cli", () => {
  it("identifies an agent session", () => {
    expect(providerForCommandLine("agent --workspace /tmp/proj")).toBe("cursor-cli");
  });

  it("does not steal Claude or Codex sessions", () => {
    expect(providerForCommandLine("claude --resume abc")).toBe("claude-code");
    expect(providerForCommandLine("codex resume abc-123")).toBe("codex-cli");
  });
});

describe("extractConversationId — cursor-cli", () => {
  it("reads --resume=<id>", () => {
    expect(extractConversationId("agent --resume=chat-99", "cursor-cli")).toBe("chat-99");
  });
});
