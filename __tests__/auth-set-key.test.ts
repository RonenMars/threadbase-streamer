import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let setApiKey: (key: string) => void;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-auth-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  // os.homedir() reads USERPROFILE on Windows (HOME is ignored). Without this
  // the sandbox leaks and setApiKey writes to the REAL ~/.threadbase/server.yaml.
  process.env.USERPROFILE = homeDir;
  vi.resetModules();
  ({ setApiKey } = await import("../src/auth"));
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
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

  it("inserts a leading newline when existing content has no trailing newline", () => {
    mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
    writeFileSync(configFile, "browse_root: /tmp/x", "utf-8"); // no trailing \n

    setApiKey("tb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

    const content = readFileSync(configFile, "utf-8");
    // Both lines must be present and separated by exactly one newline.
    expect(content).toBe("browse_root: /tmp/x\napi_key: tb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n");
  });

  // Windows has no POSIX permission bits — chmod(0o600) is a no-op there and
  // statSync reports 0o666 regardless. The chmod call is real and enforced on
  // Unix (where CI runs); only the assertion is meaningless on Windows.
  it.skipIf(process.platform === "win32")("writes the file with 0600 permissions", () => {
    setApiKey("tb_dddddddddddddddddddddddddddddddd");
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
