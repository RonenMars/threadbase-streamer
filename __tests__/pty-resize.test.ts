import { spawn as mockSpawn } from "node-pty";
import { PTYManager } from "../src/pty-manager";
import { PTY_COLS, PTY_ROWS } from "../src/pty-shared";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    return {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function lastSpawnedProcess() {
  const calls = (mockSpawn as ReturnType<typeof vi.fn>).mock.results;
  return calls[calls.length - 1].value;
}

async function startSession() {
  const mgr = new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
  const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  return { mgr, session, proc: lastSpawnedProcess() };
}

/** The session's headless render terminal, which has no public accessor. */
function internalScreen(mgr: PTYManager, sessionId: string) {
  const sessions = (
    mgr as unknown as {
      sessions: Map<
        string,
        { screen: { resize(c: number, r: number): void; cols: number; rows: number } }
      >;
    }
  ).sessions;
  const screen = sessions.get(sessionId)?.screen;
  if (!screen) throw new Error(`no screen for ${sessionId}`);
  return screen;
}

describe("PTYManager — resize", () => {
  it("forwards the requested dimensions to the pty", async () => {
    const { mgr, session, proc } = await startSession();

    mgr.resize(session.id, 200, 60);

    expect(proc.resize).toHaveBeenCalledWith(200, 60);
  });

  // pty-shared states this as an invariant: the headless render terminal MUST
  // match the PTY, because getOutputLines reads its grid and the gate detectors
  // scrape it. Resizing only the pty desyncs every absolute cursor move — which
  // breaks gate detection, the reason a managed session exists at all.
  it("resizes the render terminal in step with the pty", async () => {
    const { mgr, session } = await startSession();
    const screen = internalScreen(mgr, session.id);
    const spy = vi.spyOn(screen, "resize");

    mgr.resize(session.id, 200, 60);

    expect(spy).toHaveBeenCalledWith(200, 60);
    expect(screen.cols).toBe(200);
    expect(screen.rows).toBe(60);
  });

  // Sessions keep spawning at the fixed constants; resize is opt-in for an
  // attached terminal. If a session ever spawned at the caller's size instead,
  // every headless consumer that assumes PTY_COLS/PTY_ROWS would silently drift.
  it("does not change the size a session spawns at", async () => {
    const { proc } = await startSession();

    expect(proc.resize).not.toHaveBeenCalled();
    const opts = (mockSpawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2];
    expect(opts.cols).toBe(PTY_COLS);
    expect(opts.rows).toBe(PTY_ROWS);
  });

  // A terminal emitting SIGWINCH races session exit by nature, so an unknown
  // session is a no-op rather than a throw the caller has to catch.
  it("is silent for an unknown session", async () => {
    const { mgr } = await startSession();

    expect(() => mgr.resize("no-such-session", 100, 30)).not.toThrow();
  });

  it.each([
    ["zero cols", 0, 30],
    ["zero rows", 100, 0],
    ["negative", -1, 30],
    ["fractional", 100.5, 30],
    ["NaN", Number.NaN, 30],
  ])("ignores %s rather than passing it to the pty", async (_label, cols, rows) => {
    const { mgr, session, proc } = await startSession();

    mgr.resize(session.id, cols, rows);

    expect(proc.resize).not.toHaveBeenCalled();
  });

  // node-pty throws if the fd closed between the guard and the call. The
  // session is going away; a resize for it is moot, not an error.
  it("swallows a pty that throws on resize", async () => {
    const { mgr, session, proc } = await startSession();
    proc.resize.mockImplementation(() => {
      throw new Error("ioctl failed: fd closed");
    });

    expect(() => mgr.resize(session.id, 100, 30)).not.toThrow();
  });
});
