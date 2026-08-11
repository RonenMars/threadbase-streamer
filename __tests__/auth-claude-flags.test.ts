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
    setClaudeFlags({ model: "opus" });

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain(`api_key: ${key}`);
    expect(content).toContain("claude_flags:");
  });

  it("replaces rather than appends on repeated writes", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    setClaudeFlags({ model: "opus" });
    setClaudeFlags({ model: "sonnet" });

    const lines = readFileSync(configFile, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("claude_flags:"));
    expect(lines).toHaveLength(1);
    expect(loadClaudeFlags()).toEqual({ model: "sonnet" });
  });

  it("removes the line entirely when cleared", async () => {
    const { loadClaudeFlags, setClaudeFlags } = await auth();
    setClaudeFlags({ model: "opus" });
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
    writeFileSync(configFile, 'claude_flags: {"bogusFlag":"x","model":"opus"}\n');

    expect(loadClaudeFlags()).toEqual({ model: "opus" });
  });

  it("returns {} when the file does not exist", async () => {
    const { loadClaudeFlags } = await auth();
    expect(loadClaudeFlags()).toEqual({});
  });

  // server.yaml holds the API key, so the atomic write must not widen its mode.
  // Skipped on Windows, which has no POSIX permission bits — chmod(0o600) is a
  // no-op there and statSync reports 0o666 regardless. The chmod call is real
  // and enforced on Unix (where CI runs); only the assertion is meaningless.
  it.skipIf(process.platform === "win32")("writes with 0600 permissions", async () => {
    const { setClaudeFlags } = await auth();
    setClaudeFlags({ model: "opus" });

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

describe("feature_flags", () => {
  it("reads a valid one-line JSON value", async () => {
    const { loadFeatureFlags } = await auth();
    writeFileSync(configFile, 'feature_flags: {"codexSystemPrompt":true}\n');
    expect(loadFeatureFlags()).toEqual({ codexSystemPrompt: true });
  });

  it("returns {} when the key is absent", async () => {
    const { loadFeatureFlags } = await auth();
    writeFileSync(configFile, "api_key: tb_deadbeef\n");
    expect(loadFeatureFlags()).toEqual({});
  });

  it("returns {} when the file does not exist", async () => {
    const { loadFeatureFlags } = await auth();
    expect(loadFeatureFlags()).toEqual({});
  });

  // server.yaml is hand-editable, so a typo must cost the flag, never the boot.
  it("returns {} for malformed JSON instead of throwing", async () => {
    const { loadFeatureFlags } = await auth();
    writeFileSync(configFile, "feature_flags: {oops\n");
    expect(() => loadFeatureFlags()).not.toThrow();
    expect(loadFeatureFlags()).toEqual({});
  });

  it("drops unknown ids and non-boolean values from disk", async () => {
    const { loadFeatureFlags } = await auth();
    writeFileSync(configFile, 'feature_flags: {"bogus":true,"codexSystemPrompt":"yes"}\n');
    expect(loadFeatureFlags()).toEqual({});
  });

  it("reads the flag line regardless of surrounding keys", async () => {
    const { loadFeatureFlags } = await auth();
    writeFileSync(
      configFile,
      'api_key: tb_deadbeef\nfeature_flags: {"codexSystemPrompt":true}\ntail_size: 10\n',
    );
    expect(loadFeatureFlags()).toEqual({ codexSystemPrompt: true });
  });
});
