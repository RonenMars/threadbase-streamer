import { PTYManager } from "../src/pty-manager";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  })),
}));

describe("PTYManager.getOutputLines — session held while the screen flushes", () => {
  it("returns no lines and never reads the disposed screen", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new PTYManager({});
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    // The flush awaits a deferred xterm tick; the hold lands inside that await.
    const pending = mgr.getOutputLines(session.id, 10);
    mgr.putOnHold(session.id);

    await expect(pending).resolves.toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    warnings.mockRestore();
  });
});
