import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let runSetKey: typeof import("../cli/setKey").runSetKey;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-setkey-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  // os.homedir() reads USERPROFILE on Windows (HOME is ignored). Without this
  // the sandbox leaks and setApiKey writes to the REAL ~/.threadbase/server.yaml.
  process.env.USERPROFILE = homeDir;
  vi.resetModules();
  ({ runSetKey } = await import("../cli/setKey"));
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
});

describe("runSetKey", () => {
  it("accepts a valid key passed as argument and writes it", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { log });
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf-8")).toMatch(/api_key:\s*tb_a{32}/);
  });

  it("rejects a key with bad prefix", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "wrong_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { log });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid key format. Expected: tb_<32 hex chars>"),
    );
  });

  it("rejects a key with bad length", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_short" }, { log });
    expect(code).toBe(1);
  });

  it("rejects a key with non-hex chars", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: "tb_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }, { log });
    expect(code).toBe(1);
  });

  it("reads from stdin when key is '-'", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey(
      { key: "-" },
      { log, readStdin: async () => "tb_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n" },
    );
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf-8")).toMatch(/api_key:\s*tb_e{32}/);
  });

  it("rejects missing key when no arg and stdin empty", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const code = await runSetKey({ key: undefined }, { log, readStdin: async () => "" });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("API key required"));
  });

  it("prints restart hint on success", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await runSetKey({ key: "tb_ffffffffffffffffffffffffffffffff" }, { log });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("brew services restart tb-streamer"),
    );
  });
});
