import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVersion, resetVersionCache } from "../src/version";

describe("getVersion", () => {
  let tmp: string;
  let originalArgv1: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tb-version-"));
    originalArgv1 = process.argv[1];
    resetVersionCache();
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    rmSync(tmp, { recursive: true, force: true });
    resetVersionCache();
  });

  it("reads version.txt next to the running script", () => {
    const distDir = join(tmp, "dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "version.txt"), "1.2.3+brew\n");
    process.argv[1] = join(distDir, "cli.cjs");

    expect(getVersion()).toBe("1.2.3+brew");
  });

  it("trims surrounding whitespace from version.txt", () => {
    const distDir = join(tmp, "dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "version.txt"), "   1.2.3+update   \n\n");
    process.argv[1] = join(distDir, "cli.cjs");

    expect(getVersion()).toBe("1.2.3+update");
  });

  it("falls back to package.json with +source suffix when version.txt is absent", () => {
    const distDir = join(tmp, "dist");
    mkdirSync(distDir);
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "9.9.9" }));
    process.argv[1] = join(distDir, "cli.cjs");

    expect(getVersion()).toBe("9.9.9+source");
  });

  it("returns 0.0.0+unknown when neither file exists", () => {
    process.argv[1] = join(tmp, "nothing", "cli.cjs");

    expect(getVersion()).toBe("0.0.0+unknown");
  });

  it("treats an empty version.txt as absent and falls through to package.json", () => {
    const distDir = join(tmp, "dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "version.txt"), "  \n");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "7.7.7" }));
    process.argv[1] = join(distDir, "cli.cjs");

    expect(getVersion()).toBe("7.7.7+source");
  });

  it("memoizes the result across calls", () => {
    const distDir = join(tmp, "dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "version.txt"), "1.0.0+first");
    process.argv[1] = join(distDir, "cli.cjs");

    expect(getVersion()).toBe("1.0.0+first");

    // Change the file; without resetVersionCache, the cached value should win.
    writeFileSync(join(distDir, "version.txt"), "2.0.0+second");
    expect(getVersion()).toBe("1.0.0+first");

    resetVersionCache();
    expect(getVersion()).toBe("2.0.0+second");
  });
});
