import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDir, markerPath, prefsPath } from "../../src/lifecycle/constants";

describe("installDir()", () => {
  afterEach(() => {
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("uses THREADBASE_INSTALL_DIR override when set", () => {
    process.env.THREADBASE_INSTALL_DIR = "/tmp/override";
    expect(installDir()).toBe("/tmp/override");
  });

  it("defaults to <homedir>/.threadbase (portable, not $HOME)", () => {
    delete process.env.THREADBASE_INSTALL_DIR;
    expect(installDir()).toBe(join(homedir(), ".threadbase"));
  });

  it("markerPath() and prefsPath() build on installDir()", () => {
    process.env.THREADBASE_INSTALL_DIR = "/x";
    expect(markerPath()).toBe(join("/x", "prod-suspended.json"));
    expect(prefsPath()).toBe(join("/x", "dev-prefs.json"));
  });
});
