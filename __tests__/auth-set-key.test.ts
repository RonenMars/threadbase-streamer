import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;
let setApiKey: (key: string) => void;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-auth-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  vi.resetModules();
  ({ setApiKey } = await import("../src/auth"));
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
});

describe("setApiKey", () => {
  it("creates server.yaml with the key when the file does not exist", () => {
    setApiKey("tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const content = readFileSync(configFile, "utf-8");
    expect(content).toMatch(/^api_key:\s*tb_a{32}$/m);
  });

  it("updates api_key in place, preserving other fields", () => {
    mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
    writeFileSync(
      configFile,
      "api_key: tb_oldoldoldoldoldoldoldoldoldoldoo\nbrowse_root: /tmp/x\npublic_url: https://example.com\n",
      "utf-8",
    );

    setApiKey("tb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const content = readFileSync(configFile, "utf-8");
    expect(content).toMatch(/^api_key:\s*tb_b{32}$/m);
    expect(content).toContain("browse_root: /tmp/x");
    expect(content).toContain("public_url: https://example.com");
  });

  it("appends api_key when file exists but has no api_key line", () => {
    mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
    writeFileSync(configFile, "browse_root: /tmp/x\n", "utf-8");

    setApiKey("tb_cccccccccccccccccccccccccccccccc");

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain("browse_root: /tmp/x");
    expect(content).toMatch(/api_key:\s*tb_c{32}/);
  });

  it("writes the file with 0600 permissions", () => {
    setApiKey("tb_dddddddddddddddddddddddddddddddd");
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
