// The PTY a Claude session spawns must be exactly as large as the headless
// screen that renders it (pty-shared's invariant), and createScreen sizes the
// screen from PTY_COLS/PTY_ROWS, so the spawn sites must use them too.
//
// The constants are overridden to values that differ from the old literals
// (120x40), so a spawn site that hard-codes a size cannot pass by coincidence.

import { spawn as mockSpawn } from "node-pty";
import { PTYManager } from "../src/pty-manager";
import { PTY_COLS, PTY_ROWS } from "../src/pty-shared";

vi.mock("../src/pty-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pty-shared")>()),
  PTY_COLS: 77,
  PTY_ROWS: 33,
}));

vi.mock("node-pty", () => {
  function makeMockProcess() {
    return { pid: 4242, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), kill: vi.fn() };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function lastSpawnOptions() {
  return (mockSpawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2];
}

describe("PTYManager — spawn dimensions follow PTY_COLS/PTY_ROWS", () => {
  const newManager = () => new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });

  it("uses the mocked constants (guards the override itself)", () => {
    expect([PTY_COLS, PTY_ROWS]).toEqual([77, 33]);
  });

  it("startFresh spawns at the constants", async () => {
    const mgr = newManager();
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    expect(lastSpawnOptions()).toMatchObject({ cols: PTY_COLS, rows: PTY_ROWS });
  });

  it("start (resume) spawns at the constants", async () => {
    const mgr = newManager();
    await mgr.start("00000000-0000-4000-8000-000000000001", {
      projectPath: "/tmp/test",
      projectName: "test",
    });

    expect(lastSpawnOptions()).toMatchObject({ cols: PTY_COLS, rows: PTY_ROWS });
  });
});
