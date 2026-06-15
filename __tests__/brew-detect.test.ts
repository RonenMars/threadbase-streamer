import { describe, expect, it } from "vitest";
import { isBrewInstall } from "../src/updater/brew-detect";

describe("isBrewInstall", () => {
  it("detects an Apple Silicon Homebrew Cellar path", () => {
    expect(isBrewInstall("/opt/homebrew/Cellar/tb-streamer/1.2.1/libexec/dist/cli.cjs")).toBe(true);
  });

  it("detects an Intel Homebrew Cellar path", () => {
    expect(isBrewInstall("/usr/local/Cellar/tb-streamer/1.2.1/libexec/dist/cli.cjs")).toBe(true);
  });

  it("detects a linuxbrew Cellar path", () => {
    expect(
      isBrewInstall("/home/linuxbrew/.linuxbrew/Cellar/tb-streamer/1.2.1/libexec/dist/cli.cjs"),
    ).toBe(true);
  });

  it("returns false for a deploy.sh install path", () => {
    expect(isBrewInstall("/Users/me/.threadbase/releases/cli.abc1234.cjs")).toBe(false);
  });

  it("returns false for the auto-updater current symlink path", () => {
    expect(isBrewInstall("/Users/me/.threadbase/releases/1.2.1/dist/cli.cjs")).toBe(false);
  });

  it("returns false for a source-tree run", () => {
    expect(isBrewInstall("/Users/me/code/tb-streamer/cli/index.ts")).toBe(false);
  });

  it("returns false for an empty path", () => {
    expect(isBrewInstall("")).toBe(false);
  });
});
