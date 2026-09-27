import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";
import type { ManagedSession } from "../src/types";

// The failure push picks its copy from failureCode, because failureReason
// embeds the project path and never goes in a push. So an instant exit must
// set the code, and the public session must carry it to the notifier.

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
  dir = mkdtempSync(join(tmpdir(), "pty-failure-code-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function exitAtOnce(projectPath: string): Promise<ManagedSession | undefined> {
  const changes: ManagedSession[] = [];
  const mgr = new PTYManager({ onStatusChange: (s) => changes.push(s) });
  await mgr.start("sess-exit", { projectPath, projectName: "p" });
  procs[0]._emit("exit", { exitCode: 1 });
  mgr.dispose();
  return changes.find((s) => s.status === "idle");
}

describe("PTYManager instant exit", () => {
  it("codes a missing project folder", async () => {
    const idle = await exitAtOnce(join(dir, "gone"));
    expect(idle?.failureCode).toBe("project_dir_missing");
  });

  it("codes any other instant exit", async () => {
    const idle = await exitAtOnce(dir);
    expect(idle?.failureCode).toBe("instant_exit");
  });
});
