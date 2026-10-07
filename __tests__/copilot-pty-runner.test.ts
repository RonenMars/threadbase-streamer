import { EventEmitter } from "events";
import { spawn } from "node-pty";
import { CopilotPtyRunner } from "../src/copilot-pty-runner";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const events = new EventEmitter();
    return {
      pid: 54321,
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      onData: (cb: (s: string) => void) => events.on("data", cb),
      onExit: (cb: (s: { exitCode: number }) => void) => events.on("exit", cb),
      emit: events.emit.bind(events),
    };
  }),
}));
vi.mock("../src/platform", () => ({
  resolveCopilotExe: () => "/bin/copilot",
  clearCopilotExeCache: vi.fn(),
}));

describe("Copilot PTY", () => {
  let runner: CopilotPtyRunner;
  beforeEach(() => {
    vi.clearAllMocks();
    runner = new CopilotPtyRunner();
  });
  afterEach(() => {
    runner.dispose();
  });
  const proc = () => vi.mocked(spawn).mock.results.at(-1)?.value;
  it("passes an explicit fresh ID, workspace and model without Claude flags or trust bypass", async () => {
    const session = await runner.startFresh({
      projectPath: "/tmp/project",
      model: "gpt-5",
      systemPrompt: "do not inject",
    });
    expect(session.provider).toBe("copilot");
    expect(spawn).toHaveBeenCalledWith(
      "/bin/copilot",
      ["-C", "/tmp/project", `--session-id=${session.id}`, "--model", "gpt-5"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });
  it("resumes the native ID and deduplicates concurrent starts", async () => {
    const options = { projectPath: "/tmp/project", resumeId: "native-id" };
    const [a, b] = await Promise.all([
      runner.start("stored-id", options),
      runner.start("stored-id", options),
    ]);
    expect(a.id).toBe(b.id);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["-C", "/tmp/project", "--resume=native-id"]);
  });
  it("streams raw output and accepts terminal input without scraping gates", async () => {
    const output = vi.fn();
    runner.dispose();
    runner = new CopilotPtyRunner({ onOutput: output });
    const s = await runner.startFresh({ projectPath: "/tmp/project" });
    proc().emit("data", "Trust this workspace?");
    expect(output).toHaveBeenCalledWith(s.id, "Trust this workspace?");
    runner.sendRawKeys(s.id, "\r");
    expect(proc().write).toHaveBeenCalledWith("\r");
    runner.sendInput(s.id, "hello");
    expect(runner.getInputHistory(s.id)[0].text).toBe("hello");
    expect(proc().write).toHaveBeenCalledWith("hello\r");
    runner.resize(s.id, 90, 30);
    expect(proc().resize).toHaveBeenCalledWith(90, 30);
  });
  it("releases the PTY on hold and can resume again", async () => {
    const s = await runner.startFresh({ projectPath: "/tmp/project" });
    const first = proc();
    runner.putOnHold(s.id);
    expect(first.kill).toHaveBeenCalledWith("SIGINT");
    expect(runner.hasSession(s.id)).toBe(false);
    await runner.start(s.id, { projectPath: "/tmp/project" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("reports exit and refuses late starts after disposal", async () => {
    const changed = vi.fn();
    runner.dispose();
    runner = new CopilotPtyRunner({ onStatusChange: changed });
    const s = await runner.startFresh({ projectPath: "/tmp/project" });
    proc().emit("exit", { exitCode: 1 });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: s.id, status: "idle" }));
    expect(runner.hasSession(s.id)).toBe(false);
    runner.dispose();
    await expect(runner.startFresh({ projectPath: "/tmp/project" })).rejects.toThrow();
  });
});
