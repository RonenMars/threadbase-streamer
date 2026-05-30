import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  bootoutAgent,
  bootstrapAgent,
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
});
