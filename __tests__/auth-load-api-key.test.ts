import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiKey } from "../src/auth";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "tb-load-key-"));
  originalConfigDir = process.env.THREADBASE_CONFIG_DIR;
  process.env.THREADBASE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = originalConfigDir;
});

describe("loadApiKey", () => {
  it("returns undefined and creates no file when server.yaml is missing", () => {
    expect(loadApiKey()).toBeUndefined();
    expect(existsSync(join(configDir, "server.yaml"))).toBe(false);
  });

  it("returns undefined when server.yaml has no api_key line", () => {
    writeFileSync(join(configDir, "server.yaml"), "browse_root: /tmp\n");
    expect(loadApiKey()).toBeUndefined();
  });

  it("returns the key when server.yaml has one", () => {
    writeFileSync(join(configDir, "server.yaml"), "api_key: tb_0123\nbrowse_root: /tmp\n");
    expect(loadApiKey()).toBe("tb_0123");
  });
});
