import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// THREADBASE_CONFIG_DIR is resolved per call inside auth.ts (not frozen at
// import), so pointing it at a sandbox here keeps these writes away from the
// real ~/.threadbase/server.yaml.
let configDir: string;
let configFile: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "threadbase-flags-test-"));
  configFile = join(configDir, "server.yaml");
  process.env.THREADBASE_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.THREADBASE_CONFIG_DIR;
});

async function auth() {
  return await import("../src/auth");
}

describe("claude_flags persistence", () => {
  it("round-trips values through server.yaml", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    setClaudeFlags({ permissionMode: "bypassPermissions", addDir: ["/srv/a"] });

    expect(loadClaudeFlags()).toEqual({
      permissionMode: "bypassPermissions",
      addDir: ["/srv/a"],
    });
  });

  // The whole reason the value is stored as JSON: server.yaml is parsed by
  // single-line regex, so a value containing a colon, a space or a quote must
  // not be able to break the line format.
  it("survives values containing spaces, colons and quotes", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    const tricky = ["/path with spaces/a:b", '/has"quote'];
    setClaudeFlags({ addDir: tricky });

    expect(loadClaudeFlags().addDir).toEqual(tricky);
    // Still exactly one line for the key.
    const lines = readFileSync(configFile, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("claude_flags:"));
    expect(lines).toHaveLength(1);
  });

  it("preserves other keys in the file", async () => {
    const { loadOrCreateApiKey, setClaudeFlags } = await auth();
    const key = loadOrCreateApiKey();
    setClaudeFlags({ maxBudgetUsd: "5" });

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain(`api_key: ${key}`);
    expect(content).toContain("claude_flags:");
  });

  it("replaces rather than appends on repeated writes", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    setClaudeFlags({ maxBudgetUsd: "5" });
    setClaudeFlags({ maxBudgetUsd: "9" });

    const lines = readFileSync(configFile, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("claude_flags:"));
    expect(lines).toHaveLength(1);
    expect(loadClaudeFlags()).toEqual({ maxBudgetUsd: "9" });
  });

  it("removes the line entirely when cleared", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    setClaudeFlags({ maxBudgetUsd: "5" });
    setClaudeFlags({});

    expect(readFileSync(configFile, "utf-8")).not.toContain("claude_flags:");
    expect(loadClaudeFlags()).toEqual({});
  });

  // A hand-edited typo must not stop the server from booting.
  it("returns {} for a corrupt line instead of throwing", async () => {
    const { loadClaudeFlags } = await auth();
    writeFileSync(configFile, "claude_flags: {not valid json\n");

    expect(loadClaudeFlags()).toEqual({});
  });

  it("drops unknown ids read back from disk", async () => {
    const { loadClaudeFlags } = await auth();
    writeFileSync(configFile, 'claude_flags: {"bogusFlag":"x","maxBudgetUsd":"5"}\n');

    expect(loadClaudeFlags()).toEqual({ maxBudgetUsd: "5" });
  });

  it("returns {} when the file does not exist", async () => {
    const { loadClaudeFlags } = await auth();
    expect(loadClaudeFlags()).toEqual({});
  });

  // server.yaml holds the API key, so the atomic write must not widen its mode.
  it("writes with 0600 permissions", async () => {
    const { setClaudeFlags } = await auth();
    setClaudeFlags({ maxBudgetUsd: "5" });

    expect(statSync(configFile).mode & 0o777).toBe(0o600);
  });
});

describe("claude_extra_args persistence", () => {
  it("round-trips free text", async () => {
    const { loadClaudeExtraArgs, setClaudeExtraArgs } = await auth();
    setClaudeExtraArgs('--bare --agent "code reviewer"');

    expect(loadClaudeExtraArgs()).toBe('--bare --agent "code reviewer"');
  });

  it("clears the line for empty input", async () => {
    const { loadClaudeExtraArgs, setClaudeExtraArgs } = await auth();
    setClaudeExtraArgs("--bare");
    setClaudeExtraArgs("   ");

    expect(loadClaudeExtraArgs()).toBeUndefined();
    expect(readFileSync(configFile, "utf-8")).not.toContain("claude_extra_args:");
  });

  // Rejected rather than sanitized: a newline would corrupt the flat file, and
  // the caller should surface that as a validation error rather than quietly
  // rewriting what the user typed.
  it("throws on an embedded newline", async () => {
    const { setClaudeExtraArgs } = await auth();
    expect(() => setClaudeExtraArgs("--bare\n--evil")).toThrow(/newline/i);
  });
});

describe("default_permission_mode", () => {
  it("accepts all six modes", async () => {
    const { loadDefaultPermissionMode, setDefaultPermissionMode } = await auth();
    for (const mode of [
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "manual",
      "dontAsk",
      "plan",
    ] as const) {
      setDefaultPermissionMode(mode);
      expect(loadDefaultPermissionMode()).toBe(mode);
    }
  });

  it("ignores an invalid mode on disk", async () => {
    const { loadDefaultPermissionMode } = await auth();
    writeFileSync(configFile, "default_permission_mode: nonsense\n");
    expect(loadDefaultPermissionMode()).toBeUndefined();
  });
});
