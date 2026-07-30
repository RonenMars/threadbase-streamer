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
        fallbackModel: "sonnet",
      },
    });

    const args = lastSpawnArgs();
    expect(occurrences(args, "--model")).toBe(1);
    expect(occurrences(args, "--effort")).toBe(1);
    expect(occurrences(args, "--permission-mode")).toBe(1);
    // A non-positional flag in the same record still comes through the allowlist.
    expect(flagValue(args, "--fallback-model")).toBe("sonnet");
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
});
