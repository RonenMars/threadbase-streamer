import {
  looksLikeClaudeProcess,
  parseCimDate,
  parseCimProcesses,
  parsePsOutput,
  tokenizeCommandLine,
} from "../src/process-discovery";

// P4.c: discovery used to match on the process NAME (pgrep -x claude /
// IMAGENAME eq claude.exe), which misses every npm-shim install because those
// run as `node`. Identification is now based on what is actually executed.
describe("looksLikeClaudeProcess", () => {
  it("matches a native binary invoked by absolute path", () => {
    expect(
      looksLikeClaudeProcess(
        '"C:\\Users\\PC\\.local\\bin\\claude.exe" --dangerously-skip-permissions',
      ),
    ).toBe(true);
    expect(looksLikeClaudeProcess("/usr/local/bin/claude --resume abc")).toBe(true);
  });

  it("matches a bare `claude` on PATH", () => {
    expect(looksLikeClaudeProcess("claude")).toBe(true);
    expect(looksLikeClaudeProcess("claude --resume abc-123")).toBe(true);
  });

  it("matches an npm-shim install running under node (the case name-matching missed)", () => {
    expect(
      looksLikeClaudeProcess(
        'node "C:\\Users\\PC\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume abc',
      ),
    ).toBe(true);
    expect(
      looksLikeClaudeProcess(
        "/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      ),
    ).toBe(true);
  });

  it("matches when the runtime carries flags before the script", () => {
    expect(
      looksLikeClaudeProcess("node --enable-source-maps /opt/npm/@anthropic-ai/claude-code/cli.js"),
    ).toBe(true);
  });

  it("matches bun and deno hosts", () => {
    expect(looksLikeClaudeProcess("bun /opt/npm/@anthropic-ai/claude-code/cli.js")).toBe(true);
  });

  // The streamer itself is a node process that spawns claude, and editors get
  // launched with all sorts of paths — neither may be reported as an agent.
  it("does NOT match unrelated processes that merely mention claude", () => {
    expect(looksLikeClaudeProcess("node /home/me/threadbase-streamer/dist/cli.cjs serve")).toBe(
      false,
    );
    expect(looksLikeClaudeProcess("code --user-data-dir /home/me/.claude/projects")).toBe(false);
    expect(looksLikeClaudeProcess("tail -f /home/me/.claude/projects/x.jsonl")).toBe(false);
    expect(looksLikeClaudeProcess("")).toBe(false);
  });

  it("does not match a node process running some other script", () => {
    expect(looksLikeClaudeProcess("node /opt/app/server.js --claude")).toBe(false);
  });
});

describe("tokenizeCommandLine", () => {
  it("keeps quoted paths containing spaces intact", () => {
    expect(tokenizeCommandLine('"C:\\Program Files\\nodejs\\node.exe" script.js --flag')).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "script.js",
      "--flag",
    ]);
  });

  it("returns an empty list for an empty command line", () => {
    expect(tokenizeCommandLine("   ")).toEqual([]);
  });
});

describe("parsePsOutput", () => {
  it("selects only the Claude rows and returns their pids", () => {
    const out = [
      "  501 /usr/local/bin/claude --resume abc",
      "  502 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "  503 node /home/me/threadbase-streamer/dist/cli.cjs serve",
      "  504 /usr/bin/ssh-agent",
    ].join("\n");
    expect(parsePsOutput(out)).toEqual([501, 502]);
  });

  it("tolerates blank and malformed lines", () => {
    expect(parsePsOutput("\n\ngarbage\n  601 claude\n")).toEqual([601]);
  });
});

describe("parseCimProcesses / parseCimDate", () => {
  it("accepts a single object as well as an array", () => {
    expect(
      parseCimProcesses('{"ProcessId":1,"CommandLine":"claude","CreationDate":null}'),
    ).toHaveLength(1);
    expect(parseCimProcesses('[{"ProcessId":1},{"ProcessId":2}]')).toHaveLength(2);
  });

  it("returns an empty list for empty output", () => {
    expect(parseCimProcesses("   ")).toEqual([]);
  });

  it("reads both the ISO and /Date(ms)/ serializations", () => {
    expect(parseCimDate("2026-07-20T18:40:06.000Z").toISOString()).toBe("2026-07-20T18:40:06.000Z");
    expect(parseCimDate("/Date(1753036806000)/").getTime()).toBe(1753036806000);
  });

  it("falls back to now for a missing or unparseable date rather than NaN", () => {
    expect(Number.isNaN(parseCimDate(null).getTime())).toBe(false);
    expect(Number.isNaN(parseCimDate("not-a-date").getTime())).toBe(false);
  });
});
