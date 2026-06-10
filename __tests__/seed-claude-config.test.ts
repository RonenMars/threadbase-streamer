import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedClaudeConfig, TRUSTED_DIR } from "../src/docker/seed-claude-config";

// The script-entry tests exercise the compiled bundle (the require.main guard
// only fires when run as a script), matching what ships in the container.
const SCRIPT = join(__dirname, "..", "dist", "seed-claude-config.cjs");
const API_KEY = "sk-ant-aaaaaaaaaaaaLAST20CHARS_XYZ";
const SUFFIX = API_KEY.slice(-20);

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Runs the .cjs as a script (the entrypoint code path) and returns its exit
// code + stderr. Mirrors __tests__/install-shim.test.ts.
function runScript(env: Record<string, string>): { code: number; stderr: string } {
  try {
    execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return { code: e.status ?? 1, stderr: e.stderr?.toString() ?? "" };
  }
}

describe("seedClaudeConfig", () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-seed-test-"));
    configPath = join(workDir, ".claude.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("fresh volume (no file): writes the full seed shape", () => {
    seedClaudeConfig(configPath, API_KEY);
    const c = readConfig(configPath);

    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.theme).toBe("dark");
    expect(c.hasTrustDialogAccepted).toBe(true);
    expect((c.projects as Record<string, unknown>)[TRUSTED_DIR]).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect((c.customApiKeyResponses as { approved: string[] }).approved).toEqual([SUFFIX]);
  });

  it("no API key: skips customApiKeyResponses but still seeds dialog flags", () => {
    seedClaudeConfig(configPath, "");
    const c = readConfig(configPath);

    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.customApiKeyResponses).toBeUndefined();
  });

  it("idempotent: preserves unrelated existing keys and does not overwrite theme", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ userID: "keep-me", oauthAccount: { id: 1 }, theme: "light" }),
    );

    seedClaudeConfig(configPath, API_KEY);
    const c = readConfig(configPath);

    expect(c.userID).toBe("keep-me");
    expect(c.oauthAccount).toEqual({ id: 1 });
    // Existing theme wins (c.theme || "dark").
    expect(c.theme).toBe("light");
  });

  it("idempotent: re-run does not duplicate the approved key suffix", () => {
    seedClaudeConfig(configPath, API_KEY);
    seedClaudeConfig(configPath, API_KEY);
    const c = readConfig(configPath);

    expect((c.customApiKeyResponses as { approved: string[] }).approved).toEqual([SUFFIX]);
  });

  it("idempotent: per-project merge preserves an existing allowedTools entry", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [TRUSTED_DIR]: { allowedTools: ["Bash"] } } }),
    );

    seedClaudeConfig(configPath, API_KEY);
    const c = readConfig(configPath);

    // Existing project values win over the defaults.
    expect(
      (c.projects as Record<string, { allowedTools: string[] }>)[TRUSTED_DIR].allowedTools,
    ).toEqual(["Bash"]);
  });

  it("corrupt config: throws and leaves the existing file untouched (no truncation)", () => {
    const corrupt = '{"userID":"keep-me",';
    writeFileSync(configPath, corrupt);

    expect(() => seedClaudeConfig(configPath, API_KEY)).toThrow(/refusing to overwrite/);
    // The data-loss guard: the original bytes must survive.
    expect(readFileSync(configPath, "utf8")).toBe(corrupt);
  });
});

// Requires a build (the script-entry path lives in dist/). Skipped when dist/
// is absent so `npm test` on a clean tree doesn't fail; CI builds before test.
describe.skipIf(!existsSync(SCRIPT))("seed-claude-config.cjs (script entry)", () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-seed-cli-"));
    configPath = join(workDir, ".claude.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("exits 0 and seeds on a fresh path", () => {
    const { code } = runScript({ CLAUDE_CONFIG: configPath, CLAUDE_API_KEY: API_KEY });
    expect(code).toBe(0);
    expect(readConfig(configPath).hasCompletedOnboarding).toBe(true);
  });

  it("exits 1 with a prefixed message when CLAUDE_CONFIG is unset", () => {
    const { code, stderr } = runScript({ CLAUDE_CONFIG: "" });
    expect(code).toBe(1);
    expect(stderr).toMatch(/\[entrypoint\]/);
  });

  // Unix-only: chmod 000 to force an unreadable (non-ENOENT) existing file.
  it.skipIf(process.platform === "win32")(
    "exits 1 and does not truncate an unreadable existing config",
    () => {
      const corrupt = '{"userID":"keep-me",';
      writeFileSync(configPath, corrupt);
      chmodSync(configPath, 0o000);

      const { code, stderr } = runScript({ CLAUDE_CONFIG: configPath, CLAUDE_API_KEY: API_KEY });

      expect(code).toBe(1);
      expect(stderr).toMatch(/refusing to overwrite/);
      chmodSync(configPath, 0o600);
      expect(readFileSync(configPath, "utf8")).toBe(corrupt);
    },
  );
});
