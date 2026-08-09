import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeServerYaml } from "../src/docker/mergeServerYaml";

const SCRIPT = join(__dirname, "..", "dist", "merge-server-yaml.cjs");

function runScript(env: Record<string, string>, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("node", [SCRIPT, ...args], {
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

describe("mergeServerYaml", () => {
  let workDir: string;
  let yamlPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-merge-yaml-"));
    yamlPath = join(workDir, ".threadbase", "server.yaml");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates the file with the supplied keys on a fresh volume", () => {
    mergeServerYaml(yamlPath, {
      api_key: "tb_abc",
      public_url: "https://example.test",
      browse_root: "/data/.claude/projects",
    });

    const content = readFileSync(yamlPath, "utf8");
    expect(content).toContain("api_key: tb_abc\n");
    expect(content).toContain("public_url: https://example.test\n");
    expect(content).toContain("browse_root: /data/.claude/projects\n");
  });

  it("preserves unrelated keys when upserting owned keys", () => {
    mkdirSync(join(workDir, ".threadbase"), { recursive: true });
    writeFileSync(
      yamlPath,
      [
        "api_key: old_key",
        'claude_flags: {"model":"opus"}',
        'feature_flags: {"codexSystemPrompt":true}',
        "browse_root: /old",
        "",
      ].join("\n"),
    );

    mergeServerYaml(yamlPath, {
      api_key: "new_key",
      public_url: "https://new.test",
      browse_root: "/home/demo/projects",
    });

    const content = readFileSync(yamlPath, "utf8");
    expect(content).toContain("api_key: new_key\n");
    expect(content).toContain("browse_root: /home/demo/projects\n");
    expect(content).toContain("public_url: https://new.test\n");
    expect(content).toContain('claude_flags: {"model":"opus"}');
    expect(content).toContain('feature_flags: {"codexSystemPrompt":true}');
  });

  it("rejects multi-line values", () => {
    expect(() => mergeServerYaml(yamlPath, { api_key: "a\nb" })).toThrow(/multi-line/);
  });

  it("rejects invalid key names", () => {
    expect(() => mergeServerYaml(yamlPath, { "api-key": "x" })).toThrow(/invalid/);
  });

  it.skipIf(process.platform === "win32")("writes mode 0600", () => {
    mergeServerYaml(yamlPath, { api_key: "tb_y" });
    expect(statSync(yamlPath).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(!existsSync(SCRIPT))("merge-server-yaml.cjs (script entry)", () => {
  let workDir: string;
  let yamlPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tb-merge-yaml-cli-"));
    yamlPath = join(workDir, "server.yaml");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes keys", () => {
    const { code } = runScript({ SERVER_YAML_PATH: yamlPath }, [
      "api_key=tb_demo",
      "browse_root=/data",
    ]);
    expect(code).toBe(0);
    expect(readFileSync(yamlPath, "utf8")).toContain("api_key: tb_demo\n");
  });

  it("exits 1 when SERVER_YAML_PATH is unset", () => {
    const { code, stderr } = runScript({ SERVER_YAML_PATH: "" }, ["api_key=x"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/\[entrypoint\]/);
  });
});
