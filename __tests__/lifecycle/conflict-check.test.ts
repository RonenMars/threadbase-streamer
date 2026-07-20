import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  detectConflictingAgents,
  formatConflictMessage,
  KNOWN_STREAMER_LABELS,
} from "../../src/lifecycle/conflict-check";

describe("conflict-check", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    delete process.env.LAUNCHD_LABEL;
  });

  describe("detectConflictingAgents", () => {
    // The detector short-circuits to [] off macOS, so these tests must run as
    // darwin regardless of the host platform (CI runs on Linux).
    const realPlatform = process.platform;
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    });

    it("returns empty array on non-darwin platforms", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const result = detectConflictingAgents();
        expect(result).toEqual([]);
        expect(execFileSync).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("returns empty array when no conflicting agents are loaded", () => {
      // Make all launchctl calls fail (nothing loaded)
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not loaded");
      });
      const result = detectConflictingAgents();
      expect(result).toEqual([]);
    });

    it("detects homebrew agent as conflict when deploy.sh agent is running", () => {
      // Simulate: deploy.sh label is loaded (no brew), but brew label is also loaded
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        // print probe for brew label: fail (so own label resolves to deploy.sh)
        if (argList[0] === "print" && argList[1]?.includes("homebrew.mxcl.tb-streamer")) {
          throw new Error("not loaded");
        }
        // list check for com.ronen.threadbase: succeed (own agent)
        if (argList[0] === "list" && argList[1] === "com.ronen.threadbase") {
          return Buffer.from("");
        }
        // list check for homebrew.mxcl.tb-streamer: succeed (conflict!)
        if (argList[0] === "list" && argList[1] === "homebrew.mxcl.tb-streamer") {
          return Buffer.from("");
        }
        // list check for com.threadbase.streamer: fail
        if (argList[0] === "list" && argList[1] === "com.threadbase.streamer") {
          throw new Error("not loaded");
        }
        // launchctl list (for legacy scan): return empty
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from("PID\tStatus\tLabel\n");
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        label: "homebrew.mxcl.tb-streamer",
        resolution: "uninstall-homebrew",
      });
    });

    it("detects deploy.sh agent as conflict when homebrew agent is running", () => {
      // Simulate: brew label is loaded, but deploy.sh label is also loaded
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        // print probe for brew label: succeed (own label resolves to brew)
        if (argList[0] === "print" && argList[1]?.includes("homebrew.mxcl.tb-streamer")) {
          return Buffer.from("");
        }
        // list check for com.ronen.threadbase: succeed (conflict!)
        if (argList[0] === "list" && argList[1] === "com.ronen.threadbase") {
          return Buffer.from("");
        }
        // list check for com.threadbase.streamer: fail
        if (argList[0] === "list" && argList[1] === "com.threadbase.streamer") {
          throw new Error("not loaded");
        }
        // launchctl list (for legacy scan): return empty
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from("PID\tStatus\tLabel\n");
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        label: "com.ronen.threadbase",
        resolution: "bootout",
      });
    });

    it("detects legacy com.threadbase.streamer variants via launchctl list", () => {
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        // print probe: fail (deploy.sh label)
        if (argList[0] === "print") {
          throw new Error("not loaded");
        }
        // Individual list checks: all fail
        if (argList[0] === "list" && argList.length === 2) {
          throw new Error("not loaded");
        }
        // launchctl list (full scan): return a legacy label
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from(
            "PID\tStatus\tLabel\n" +
              "123\t0\tcom.threadbase.streamer.old\n" +
              "456\t0\tcom.apple.something\n",
          );
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        label: "com.threadbase.streamer.old",
        resolution: "bootout",
      });
    });

    it("excludes own label from conflicts", () => {
      // Simulate: only the deploy.sh label (own) is loaded
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        if (argList[0] === "print") {
          throw new Error("not loaded");
        }
        if (argList[0] === "list" && argList[1] === "com.ronen.threadbase") {
          return Buffer.from("");
        }
        if (argList[0] === "list" && argList.length === 2) {
          throw new Error("not loaded");
        }
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from("PID\tStatus\tLabel\n123\t0\tcom.ronen.threadbase\n");
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      expect(result).toEqual([]);
    });

    it("honors LAUNCHD_LABEL env override when resolving own label", () => {
      process.env.LAUNCHD_LABEL = "com.acme.custom";

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        // Should NOT probe for brew label when env is set
        if (argList[0] === "print") {
          throw new Error("should not be called");
        }
        // list check for com.ronen.threadbase: succeed (conflict, since own is custom)
        if (argList[0] === "list" && argList[1] === "com.ronen.threadbase") {
          return Buffer.from("");
        }
        // Other list checks: fail
        if (argList[0] === "list" && argList.length === 2) {
          throw new Error("not loaded");
        }
        // launchctl list: empty
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from("PID\tStatus\tLabel\n");
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("com.ronen.threadbase");
    });

    it("detects multiple conflicts simultaneously", () => {
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argList = args as string[];
        // print probe: fail (deploy.sh label)
        if (argList[0] === "print") {
          throw new Error("not loaded");
        }
        // All known labels are loaded
        if (argList[0] === "list" && argList.length === 2) {
          return Buffer.from("");
        }
        // launchctl list: also includes a legacy variant
        if (argList[0] === "list" && argList.length === 1) {
          return Buffer.from(
            "PID\tStatus\tLabel\n" +
              "1\t0\tcom.threadbase.streamer.v1\n" +
              "2\t0\tcom.threadbase.streamer.v2\n",
          );
        }
        throw new Error(`unexpected call: ${argList.join(" ")}`);
      });

      const result = detectConflictingAgents();
      // Own label is com.ronen.threadbase, so conflicts are:
      // homebrew.mxcl.tb-streamer, com.threadbase.streamer, and two legacy variants
      expect(result.length).toBeGreaterThanOrEqual(3);
      expect(result.some((c) => c.label === "homebrew.mxcl.tb-streamer")).toBe(true);
      expect(result.some((c) => c.label === "com.threadbase.streamer")).toBe(true);
    });
  });

  describe("formatConflictMessage", () => {
    it("returns empty string for no conflicts", () => {
      expect(formatConflictMessage([])).toBe("");
    });

    it("formats bootout resolution correctly", () => {
      const message = formatConflictMessage([
        { label: "com.ronen.threadbase", resolution: "bootout" },
      ]);
      expect(message).toContain("Conflicting Threadbase streamer agents");
      expect(message).toContain("com.ronen.threadbase");
      expect(message).toContain("launchctl bootout");
    });

    it("formats homebrew uninstall resolution correctly", () => {
      const message = formatConflictMessage([
        { label: "homebrew.mxcl.tb-streamer", resolution: "uninstall-homebrew" },
      ]);
      expect(message).toContain("homebrew.mxcl.tb-streamer");
      expect(message).toContain("brew services stop");
      expect(message).toContain("brew uninstall");
    });

    it("formats multiple conflicts", () => {
      const message = formatConflictMessage([
        { label: "com.ronen.threadbase", resolution: "bootout" },
        { label: "homebrew.mxcl.tb-streamer", resolution: "uninstall-homebrew" },
      ]);
      expect(message).toContain("com.ronen.threadbase");
      expect(message).toContain("homebrew.mxcl.tb-streamer");
      expect(message).toContain("Only one Threadbase streamer can bind port 8766");
    });
  });

  describe("KNOWN_STREAMER_LABELS", () => {
    it("includes all expected labels", () => {
      expect(KNOWN_STREAMER_LABELS).toContain("com.ronen.threadbase");
      expect(KNOWN_STREAMER_LABELS).toContain("homebrew.mxcl.tb-streamer");
      expect(KNOWN_STREAMER_LABELS).toContain("com.threadbase.streamer");
    });
  });
});
