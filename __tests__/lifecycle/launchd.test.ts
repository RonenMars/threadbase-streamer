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
  darwinPlistPath,
  getLogPaths,
  isAgentLoaded,
  kickstartAgent,
} from "../../src/lifecycle/launchd";

describe("launchd wrappers", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    delete process.env.LAUNCHD_LABEL;
  });

  it("isAgentLoaded returns true when launchctl list exits 0", () => {
    // No brew service loaded (print probe throws) → resolver yields the
    // deploy.sh label, which isAgentLoaded then lists.
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if ((args as string[])[0] === "print") throw new Error("not loaded");
      return Buffer.from("");
    });
    expect(isAgentLoaded()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["list", "com.ronen.threadbase"],
      expect.any(Object),
    );
  });

  it("targets the brew label when the brew service is the one loaded", () => {
    // The resolver probes the brew label with `launchctl print`; a clean exit
    // means it's loaded, so subsequent operations target it.
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/\/homebrew\.mxcl\.tb-streamer$/)],
      expect.any(Object),
    );
  });

  it("falls back to the deploy.sh label when the brew service is not loaded", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if ((args as string[])[0] === "print") throw new Error("Could not find service");
      return Buffer.from("");
    });
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/\/com\.ronen\.threadbase$/)],
      expect.any(Object),
    );
  });

  it("honors the LAUNCHD_LABEL env override without probing", () => {
    process.env.LAUNCHD_LABEL = "com.acme.custom";
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    kickstartAgent();
    const probeCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter((c) => (c[1] as string[])[0] === "print");
    expect(probeCalls).toHaveLength(0);
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/\/com\.acme\.custom$/)],
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
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if ((args as string[])[0] === "print") throw new Error("not loaded");
      return Buffer.from("");
    });
    kickstartAgent();
    expect(execFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["kickstart", "-k", expect.stringMatching(/^gui\/\d+\/com\.ronen\.threadbase$/)],
      expect.any(Object),
    );
  });

  describe("darwinPlistPath", () => {
    it("builds the brew plist path when the brew service is loaded", () => {
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
      expect(darwinPlistPath()).toMatch(
        /\/Library\/LaunchAgents\/homebrew\.mxcl\.tb-streamer\.plist$/,
      );
    });

    it("builds the deploy.sh plist path when the brew service is not loaded", () => {
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        if ((args as string[])[0] === "print") throw new Error("not loaded");
        return Buffer.from("");
      });
      expect(darwinPlistPath()).toMatch(/\/Library\/LaunchAgents\/com\.ronen\.threadbase\.plist$/);
    });
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
