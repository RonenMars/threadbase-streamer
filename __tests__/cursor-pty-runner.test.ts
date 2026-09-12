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
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function spawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

describe("CursorPtyRunner — spawn args", () => {
  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns agent --workspace --trust with no session id", async () => {
    const runner = new CursorPtyRunner();
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });

    expect(session.provider).toBe("cursor-cli");
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
