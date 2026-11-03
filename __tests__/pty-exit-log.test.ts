import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";

// A session death must be one grep away: `event":"pty.exit"` carries the exit
// code, how long the session lived and the diagnosed failureReason.

const procs: Array<{ _emit: (event: string, data: unknown) => void }> = [];

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const ee = new EventEmitter();
    const proc = {
      pid: 4242,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
    procs.push(proc);
    return proc;
  }),
}));

let dir: string;
beforeEach(() => {
  procs.length = 0;
  dir = mkdtempSync(join(tmpdir(), "pty-exit-log-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function makeManager() {
  const info = vi.fn();
  const logger = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const mgr = new PTYManager({ logger: logger as never });
  return { mgr, info };
}

const exitCalls = (info: ReturnType<typeof vi.fn>) =>
  info.mock.calls.filter(([, fields]) => fields?.event === "pty.exit");

describe("PTYManager pty.exit log", () => {
  it("logs one pty.exit with code, elapsed time and the diagnosed reason", async () => {
    const { mgr, info } = makeManager();
    await mgr.start("sess-exit", { projectPath: join(dir, "gone"), projectName: "p" });
    procs[0]._emit("exit", { exitCode: 1 });
    mgr.dispose();

    const calls = exitCalls(info);
    expect(calls).toHaveLength(1);
    const fields = calls[0][1];
    expect(fields).toMatchObject({
      event: "pty.exit",
      sessionId: "sess-exit",
      exitCode: 1,
      failureReason: expect.stringContaining("Project directory not found"),
    });
    expect(typeof fields.elapsedMs).toBe("number");
  });

  it("measures elapsedMs from the session start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { mgr, info } = makeManager();
    await mgr.start("sess-time", { projectPath: dir, projectName: "p" });
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    procs[0]._emit("exit", { exitCode: 0 });
    mgr.dispose();

    expect(exitCalls(info)[0][1]).toMatchObject({ exitCode: 0, elapsedMs: 5000 });
  });

  it("logs failureReason as undefined for a clean exit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { mgr, info } = makeManager();
    await mgr.start("sess-ok", { projectPath: dir, projectName: "p" });
    vi.setSystemTime(Date.now() + 10_000);
    procs[0]._emit("exit", { exitCode: 0 });
    mgr.dispose();

    expect(exitCalls(info)[0][1].failureReason).toBeUndefined();
  });
});
