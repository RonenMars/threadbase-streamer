import { EventEmitter } from "events";
import { spawn as mockSpawn } from "node-pty";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import type { ManagedSession } from "../src/types";

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

// Real-world status-bar line captured during Phase 0 live-PTY probing —
// Codex is booted and usable. Padded with leading rows so the "last
// non-blank line" check exercises real screen rendering, not just a single
// chunk.
const READY_STATUS_BAR = "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…\r\n";

// "Starting" state: MCP servers still loading. The compose box `›` prefix is
// already visible here — must NOT be treated as ready.
const STARTING_STATUS_BAR = "› \r\ngpt-5.5 medium · /path · gpt-5.5 · medium · Starting\r\n";

// Directory-trust gate, captured verbatim per Phase 0 findings.
const TRUST_GATE_SCREEN =
  "Do you want to trust the contents of this directory?\r\n" +
  "1. Yes, continue\r\n" +
  "2. No, quit\r\n" +
  "Press enter to continue\r\n";

async function spawnFresh(runner: CodexPtyRunner, projectPath = "/tmp/test") {
  return runner.startFresh({ projectPath, projectName: "test" });
}

async function spawnResume(runner: CodexPtyRunner, sessionId = "codex-session-id") {
  return runner.start(sessionId, {
    projectPath: "/tmp/test",
    projectName: "test",
    branch: "main",
  });
}

function getMockProc(runner: CodexPtyRunner, sessionId: string): any {
  return (runner as any).sessions.get(sessionId).process;
}

function spawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

describe("CodexPtyRunner — spawn args", () => {
  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns codex --cd <projectPath> --no-alt-screen with no other args", async () => {
    const runner = new CodexPtyRunner();
    const session = await spawnFresh(runner, "/tmp/proj");

    expect(session.provider).toBe("codex-cli");
    const args = spawnArgs();
    expect(args).toEqual(["--cd", "/tmp/proj", "--no-alt-screen"]);
  });

  it("start (resume) spawns codex resume <sessionId> --cd <projectPath> --no-alt-screen", async () => {
    const runner = new CodexPtyRunner();
    await runner.start("abc-123", { projectPath: "/tmp/proj", projectName: "test" });

    const args = spawnArgs();
    expect(args).toEqual(["resume", "abc-123", "--cd", "/tmp/proj", "--no-alt-screen"]);
  });
});

describe("CodexPtyRunner — directory-trust gate", () => {
  it("writes \\r exactly once and does not mark ready", async () => {
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onReady: (s) => ready.push(s) });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", TRUST_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith("\r");
    expect(ready).toHaveLength(0);

    // Feeding the same gate content again must not write a second \r.
    proc._emit("data", TRUST_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(proc.write).toHaveBeenCalledTimes(1);
  });
});

describe("CodexPtyRunner — ready detection", () => {
  it("fires onReady and transitions to waiting_input when status bar contains Ready", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", READY_STATUS_BAR);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it("does NOT fire onReady on › alone without Ready in the status line", async () => {
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onReady: (s) => ready.push(s) });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", STARTING_STATUS_BAR);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(0);
    expect(runner.getSession(session.id)?.status).toBe("running");
  });
});

describe("CodexPtyRunner — input queueing", () => {
  it("queues sendInput while pending-ready, then flushes in order once ready", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CodexPtyRunner();
      const session = await spawnFresh(runner);
      const proc = getMockProc(runner, session.id);

      const promptCount1 = runner.sendInput(session.id, "first");
      const promptCount2 = runner.sendInput(session.id, "second");
      expect(promptCount1).toBe(1);
      expect(promptCount2).toBe(2);
      expect(proc.write).not.toHaveBeenCalled();

      proc._emit("data", READY_STATUS_BAR);
      await vi.advanceTimersByTimeAsync(0);

      // First input's raw text lands immediately; its \r is deferred.
      expect(proc.write.mock.calls[0][0]).toBe("first");

      // Timeline: 0=first, 16ms=\r(first), 32ms=second, 48ms=\r(second).
      await vi.advanceTimersByTimeAsync(60);

      const writes = proc.write.mock.calls.map((c: any[]) => c[0]);
      expect(writes).toContain("first");
      expect(writes).toContain("second");
      // \r appears at least twice (once per submit).
      expect(writes.filter((w: string) => w === "\r").length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendInput after ready writes directly (not queued)", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CodexPtyRunner();
      const session = await spawnResume(runner);
      const proc = getMockProc(runner, session.id);

      proc._emit("data", READY_STATUS_BAR);
      await vi.advanceTimersByTimeAsync(0);
      proc.write.mockClear();

      runner.sendInput(session.id, "hello");
      expect(proc.write).toHaveBeenCalledWith("hello");
      expect(proc.write).not.toHaveBeenCalledWith("\r");

      await vi.advanceTimersByTimeAsync(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexPtyRunner — cancel / putOnHold", () => {
  it("cancel sends SIGINT", async () => {
    const runner = new CodexPtyRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    runner.cancel(session.id);
    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("putOnHold sends SIGINT and cleans up session state", async () => {
    const statusChanges: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    runner.putOnHold(session.id);

    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
    expect(runner.hasSession(session.id)).toBe(false);
    expect(statusChanges.some((s) => s.status === "idle")).toBe(true);
  });
});

describe("CodexPtyRunner — exit handling", () => {
  it("sets failureReason on instant non-zero exit with no output", async () => {
    const statusChanges: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(runner, "/tmp/test");
    const proc = getMockProc(runner, session.id);

    proc._emit("exit", { exitCode: 1 });

    const finalUpdate = statusChanges[statusChanges.length - 1];
    expect(finalUpdate.status).toBe("idle");
    expect(finalUpdate.failureReason).toBeTruthy();
    expect(runner.hasSession(session.id)).toBe(false);
  });
});
