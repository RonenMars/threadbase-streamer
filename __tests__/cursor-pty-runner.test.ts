import { EventEmitter } from "events";
import { spawn as mockSpawn } from "node-pty";
import { CursorPtyRunner } from "../src/cursor-pty-runner";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 54321,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function spawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

function getMockProc(
  runner: CursorPtyRunner,
  sessionId: string,
): {
  write: ReturnType<typeof vi.fn>;
  _emit: (event: string, data: string) => boolean;
} {
  const session = (runner as any).sessions.get(sessionId);
  return session.process;
}

describe("CursorPtyRunner — spawn args", () => {
  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns agent --workspace --trust with no session id", async () => {
    const runner = new CursorPtyRunner();
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });

    expect(session.provider).toBe("cursor");
    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust"]);
  });

  it("startFresh appends systemPrompt as the trailing positional prompt", async () => {
    const runner = new CursorPtyRunner();
    await runner.startFresh({
      projectPath: "/tmp/proj",
      projectName: "test",
      systemPrompt: "stay in the sandbox",
    });

    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust", "stay in the sandbox"]);
  });

  it("start (resume) passes --resume=<id> and keeps the session id", async () => {
    const runner = new CursorPtyRunner();
    const session = await runner.start("placeholder-uuid", {
      projectPath: "/tmp/proj",
      projectName: "test",
      resumeId: "chat-id",
    });

    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust", "--resume=chat-id"]);
    expect(session.id).toBe("placeholder-uuid");
  });
});

describe("CursorPtyRunner — sendInput clears compose before write", () => {
  it("prefixes Ctrl+U then text, then submits \\r after quiet", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);

      // Settle boot so sendInput is not queued.
      proc._emit("data", "ready\r\n");
      await vi.advanceTimersByTimeAsync(600);
      proc.write.mockClear();

      runner.sendInput(session.id, "Yes, commit it");
      expect(proc.write).toHaveBeenCalledWith("\x15Yes, commit it");
      expect(proc.write).not.toHaveBeenCalledWith("\r");

      await vi.advanceTimersByTimeAsync(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears before each flush so queued turns do not concatenate", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);

      runner.sendInput(session.id, "Commit it");
      runner.sendInput(session.id, "Yes, commit it");
      expect(proc.write).not.toHaveBeenCalled();

      proc._emit("data", "ready\r\n");
      await vi.advanceTimersByTimeAsync(600);

      const writes = proc.write.mock.calls.map((c: unknown[]) => c[0]);
      expect(writes.filter((w: string) => typeof w === "string" && w.startsWith("\x15"))).toEqual([
        "\x15Commit it",
        "\x15Yes, commit it",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
