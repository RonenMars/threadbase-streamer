import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetAll,
  forgetRepo,
  getPrefForRepo,
  readPrefs,
  writePrefForRepo,
} from "../../src/lifecycle/prefs";

describe("prefs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prefs-test-"));
    process.env.THREADBASE_INSTALL_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.THREADBASE_INSTALL_DIR;
  });

  it("readPrefs returns empty when no file exists", () => {
    expect(readPrefs()).toEqual({ repos: {} });
  });

  it("writePrefForRepo + getPrefForRepo round-trip 'use-port' choice", () => {
    writePrefForRepo("/repo/a", { choice: "use-port", port: 9001 });
    const pref = getPrefForRepo("/repo/a");
    expect(pref?.choice).toBe("use-port");
    expect(pref?.port).toBe(9001);
    expect(pref?.rememberedAt).toBeDefined();
  });

  it("writePrefForRepo 'replace-prod' has no port", () => {
    writePrefForRepo("/repo/b", { choice: "replace-prod" });
    expect(getPrefForRepo("/repo/b")?.port).toBeUndefined();
  });

  it("forgetRepo removes only that repo's entry", () => {
    writePrefForRepo("/repo/a", { choice: "replace-prod" });
    writePrefForRepo("/repo/b", { choice: "use-port", port: 9001 });
    forgetRepo("/repo/a");
    expect(getPrefForRepo("/repo/a")).toBeNull();
    expect(getPrefForRepo("/repo/b")).not.toBeNull();
  });

  it("forgetAll wipes everything", () => {
    writePrefForRepo("/repo/a", { choice: "replace-prod" });
    writePrefForRepo("/repo/b", { choice: "use-port", port: 9001 });
    forgetAll();
    expect(readPrefs()).toEqual({ repos: {} });
  });

  it("returns null pref when no repo path given (e.g. not in git)", () => {
    expect(getPrefForRepo(null)).toBeNull();
  });
});
