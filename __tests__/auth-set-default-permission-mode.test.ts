import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let homeDir: string;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let setDefaultPermissionMode: (mode: "acceptEdits" | "manual") => void;
let loadDefaultPermissionMode: () => "acceptEdits" | "manual" | undefined;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-auth-"));
  configFile = join(homeDir, ".threadbase", "server.yaml");
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  vi.resetModules();
  ({ setDefaultPermissionMode, loadDefaultPermissionMode } = await import("../src/auth"));
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

describe("setDefaultPermissionMode / loadDefaultPermissionMode", () => {
  it("returns undefined when server.yaml does not exist", () => {
    expect(loadDefaultPermissionMode()).toBeUndefined();
  });

  it("round-trips through server.yaml", () => {
    setDefaultPermissionMode("manual");
    expect(loadDefaultPermissionMode()).toBe("manual");
    const content = readFileSync(configFile, "utf-8");
    expect(content).toMatch(/^default_permission_mode:\s*manual$/m);
  });

  it("updates the value in place, preserving other fields", () => {
    mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
    writeFileSync(
      configFile,
      "api_key: tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ndefault_permission_mode: manual\n",
      "utf-8",
    );

    setDefaultPermissionMode("acceptEdits");

    const content = readFileSync(configFile, "utf-8");
    expect(content).toContain("api_key: tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(content).toMatch(/^default_permission_mode:\s*acceptEdits$/m);
  });

  it("ignores an unrecognized value in server.yaml", () => {
    mkdirSync(join(homeDir, ".threadbase"), { recursive: true });
    writeFileSync(configFile, "default_permission_mode: bogus\n", "utf-8");
    expect(loadDefaultPermissionMode()).toBeUndefined();
  });
});
