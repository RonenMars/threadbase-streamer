// The spawn argv for --permission-mode / --model / --effort.
//
// These three are the only registry flags the spawn paths pass as explicit
// positionals, which is why buildFlagArgs skips them (SPAWN_POSITIONAL_FLAG_IDS).
// The failure mode this locks down is a DUPLICATE flag on the command line: it
// would not throw here, it would reach `claude` and be resolved by whichever
// occurrence the CLI's parser happens to prefer.

import { spawn as mockSpawn } from "node-pty";
import { PTYManager } from "../src/pty-manager";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    return {
      pid: 31337,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function lastSpawnArgs(): string[] {
  const calls = (mockSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

function occurrences(args: string[], flag: string): number {
  return args.filter((a) => a === flag).length;
}

/** The value immediately following a flag, as the CLI would read it. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("PTYManager — model/effort/permission-mode argv", () => {
  function newManager() {
    return new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
  }

  it("passes the resolved model and effort through to argv", async () => {
    await newManager().startFresh({
      projectPath: "/tmp/test",
      projectName: "test",
      model: "claude-opus-4-5",
      effort: "xhigh",
      permissionMode: "plan",
    });

    const args = lastSpawnArgs();
    expect(flagValue(args, "--model")).toBe("claude-opus-4-5");
    expect(flagValue(args, "--effort")).toBe("xhigh");
    expect(flagValue(args, "--permission-mode")).toBe("plan");
  });

  it("falls back to sonnet/low when no override is supplied", async () => {
    await newManager().startFresh({ projectPath: "/tmp/test", projectName: "test" });

    const args = lastSpawnArgs();
    expect(flagValue(args, "--model")).toBe("sonnet");
    expect(flagValue(args, "--effort")).toBe("low");
  });

  // The regression this file exists for: the same values arriving as BOTH the
  // resolved options and the raw claudeFlags record must still yield one flag
  // each, because buildFlagArgs skips the positional ids.
  it("emits each positional flag exactly once when claudeFlags carries it too", async () => {
    await newManager().startFresh({
      projectPath: "/tmp/test",
      projectName: "test",
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
      claudeFlags: {
        model: "opus",
        effort: "high",
        permissionMode: "bypassPermissions",
        addDir: ["/srv/extra"],
      },
    });

    const args = lastSpawnArgs();
    expect(occurrences(args, "--model")).toBe(1);
    expect(occurrences(args, "--effort")).toBe(1);
    expect(occurrences(args, "--permission-mode")).toBe(1);
    // A non-positional flag in the same record still comes through the allowlist.
    expect(flagValue(args, "--add-dir")).toBe("/srv/extra");
  });

  it("applies the same argv on the resume path", async () => {
    await newManager().start("00000000-0000-4000-8000-000000000000", {
      projectPath: "/tmp/test",
      model: "opus",
      effort: "max",
      permissionMode: "acceptEdits",
      claudeFlags: { model: "opus", effort: "max" },
    });

    const args = lastSpawnArgs();
    expect(occurrences(args, "--model")).toBe(1);
    expect(occurrences(args, "--effort")).toBe(1);
    expect(flagValue(args, "--model")).toBe("opus");
    expect(flagValue(args, "--effort")).toBe("max");
    expect(args).toContain("--resume");
  });

  // Issue #960: claude_extra_args is appended last, so a --model / --effort in it
  // wins inside Claude. The session must report what Claude actually runs.
  describe("effective model and effort on the returned session", () => {
    const RESUME_ID = "00000000-0000-4000-8000-000000000001";

    it("reports the spawn values when extra args do not touch them", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        model: "opus",
        effort: "high",
        claudeExtraArgs: "--verbose",
      });
      expect(s.model).toBe("opus");
      expect(s.effort).toBe("high");
    });

    it("reports the defaults the spawn fell back to when nothing was supplied", async () => {
      const s = await newManager().startFresh({ projectPath: "/tmp/test" });
      expect(s.model).toBe("sonnet");
      expect(s.effort).toBe("low");
    });

    it("reports the --model from claude_extra_args, not the one the spawn passed first", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        model: "sonnet",
        effort: "low",
        claudeExtraArgs: "--model claude-sonnet-5",
      });
      expect(s.model).toBe("claude-sonnet-5");
      expect(s.effort).toBe("low");
    });

    it("reports the --effort from claude_extra_args", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        model: "sonnet",
        effort: "low",
        claudeExtraArgs: "--effort high",
      });
      expect(s.effort).toBe("high");
      expect(s.model).toBe("sonnet");
    });

    it("reads the --flag=value form", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        claudeExtraArgs: "--model=opus --effort=max",
      });
      expect(s.model).toBe("opus");
      expect(s.effort).toBe("max");
    });

    it("lets the last of several overrides win", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        claudeExtraArgs: "--model a --model=b",
      });
      expect(s.model).toBe("b");
    });

    it("agrees with the argv that was actually handed to the PTY", async () => {
      const s = await newManager().startFresh({
        projectPath: "/tmp/test",
        claudeExtraArgs: "--model claude-sonnet-5 --effort high",
      });
      const args = lastSpawnArgs();
      expect(args.slice(-4)).toEqual(["--model", "claude-sonnet-5", "--effort", "high"]);
      expect(s.model).toBe("claude-sonnet-5");
      expect(s.effort).toBe("high");
    });

    it("applies the same resolution on the resume path", async () => {
      const s = await newManager().start(RESUME_ID, {
        projectPath: "/tmp/test",
        model: "sonnet",
        effort: "low",
        claudeExtraArgs: "--model=opus --effort high",
      });
      expect(s.model).toBe("opus");
      expect(s.effort).toBe("high");
    });

    it("resume reports the spawn values when extra args do not override", async () => {
      const s = await newManager().start(RESUME_ID.replace(/1$/, "2"), {
        projectPath: "/tmp/test",
        model: "opus",
        effort: "max",
      });
      expect(s.model).toBe("opus");
      expect(s.effort).toBe("max");
    });
  });
});
