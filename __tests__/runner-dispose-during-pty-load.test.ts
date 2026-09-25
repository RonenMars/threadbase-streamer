import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";

// node-pty's first load is a real await (a native addon import). A shutdown
// that lands inside it used to let the start carry on and spawn a child after
// dispose() had already swept the runner — one nothing would ever kill. The
// gate holds the import open so dispose() can land exactly there.
const gate = vi.hoisted(() => {
  let release!: () => void;
  const opened = new Promise<void>((r) => {
    release = r;
  });
  return { opened, release: () => release() };
});

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    const ee = new EventEmitter();
    return {
      pid: 4242,
      onData: (cb: (d: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }),
);

vi.mock("node-pty", async () => {
  await gate.opened;
  return { spawn };
});

type Runner = { startFresh(o: { projectPath: string }): Promise<unknown>; dispose(): void };

const runners: Array<[string, () => Promise<Runner>]> = [
  ["claude", async () => new (await import("../src/pty-manager")).PTYManager()],
  ["codex", async () => new (await import("../src/codex-pty-runner")).CodexPtyRunner()],
  ["cursor", async () => new (await import("../src/cursor-pty-runner")).CursorPtyRunner()],
];

describe("a runner disposed while node-pty is still loading", () => {
  it.each(runners)("%s refuses to spawn once the load resolves", async (_name, make) => {
    const runner = await make();
    const started = runner.startFresh({ projectPath: tmpdir() });
    runner.dispose();
    gate.release();

    await expect(started).rejects.toThrow(/shut down/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
