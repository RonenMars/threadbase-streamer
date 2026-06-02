import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampVersionTxt } from "../src/updater/stamp-version";

describe("stampVersionTxt", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "stamp-version-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes <destDir>/dist/version.txt with the +update suffix", () => {
    stampVersionTxt(tmp, "1.2.3");
    expect(readFileSync(join(tmp, "dist", "version.txt"), "utf8")).toBe("1.2.3+update\n");
  });

  it("creates the dist directory if the tarball didn't include one", () => {
    // No pre-existing tmp/dist — function must mkdir it.
    stampVersionTxt(tmp, "9.9.9");
    expect(readFileSync(join(tmp, "dist", "version.txt"), "utf8")).toContain("9.9.9");
  });

  it("overwrites an existing version.txt", () => {
    stampVersionTxt(tmp, "1.0.0");
    stampVersionTxt(tmp, "2.0.0");
    expect(readFileSync(join(tmp, "dist", "version.txt"), "utf8")).toBe("2.0.0+update\n");
  });
});
