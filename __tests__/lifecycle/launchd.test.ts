import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bootoutAgent,
  bootstrapAgent,
  getLogPaths,
  isAgentLoaded,
  kickstartAgent,
} from "../../src/lifecycle/launchd";

describe("launchd wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("isAgentLoaded returns true when launchctl list exits 0", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(isAgentLoaded()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["list", "com.ronen.threadbase"],
      expect.any(Object),
    );
  });

  it("isAgentLoaded returns false when launchctl list throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not loaded");
    });
    expect(isAgentLoaded()).toBe(false);
  });

  it("bootoutAgent swallows 'not loaded' errors", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not loaded");
    });
    expect(() => bootoutAgent()).not.toThrow();
  });

  it("bootstrapAgent passes the plist path", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    bootstrapAgent("/path/to/plist");
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", expect.stringMatching(/^gui\/\d+$/), "/path/to/plist"],
      expect.any(Object),
    );
  });

  it("kickstartAgent uses -k flag", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/^gui\/\d+\/com\.ronen\.threadbase$/)],
      expect.any(Object),
    );
  });

  describe("getLogPaths", () => {
    it("defaults to <homedir>/.threadbase/logs/{stdout,stderr}.log", () => {
      delete process.env.THREADBASE_INSTALL_DIR;
      const paths = getLogPaths();
      expect(paths.stdout).toBe(join(homedir(), ".threadbase", "logs", "stdout.log"));
      expect(paths.stderr).toBe(join(homedir(), ".threadbase", "logs", "stderr.log"));
    });

    it("honors THREADBASE_INSTALL_DIR override", () => {
      process.env.THREADBASE_INSTALL_DIR = "/tmp/tb-override";
      const paths = getLogPaths();
      // join() so the expectation matches the platform separator (getLogPaths
      // builds the path with path.join), consistent with the sibling test above.
      expect(paths.stdout).toBe(join("/tmp/tb-override", "logs", "stdout.log"));
      expect(paths.stderr).toBe(join("/tmp/tb-override", "logs", "stderr.log"));
      delete process.env.THREADBASE_INSTALL_DIR;
    });
  });
});
