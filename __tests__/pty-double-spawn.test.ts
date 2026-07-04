import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";

// ---------------------------------------------------------------------------
// Regression test for CRITICAL #3 (CODE-REVIEW-2026-07-04.md): a concurrent
// resume double-spawns a PTY for the same sessionId and corrupts its output.
//
// Root cause: PTYManager.start() (pty-manager.ts:202) unconditionally calls
// nodePty.spawn() and this.sessions.set(sessionId, session) with NO hasSession
// guard. server.ts's handleResume checks hasSession(sessionId) once, then does
// two awaits (readCwdFromJsonl, findConversationByUuid) before calling start(),
// so two resume requests arriving close together both pass the check and both
// spawn `claude --resume <id>`. The first process is never killed; its onData
// handler keeps calling handleOutput(sessionId, …), which does
// this.sessions.get(sessionId) — now the SECOND session — writing the orphan's
// bytes into the wrong buffer.
//
// These tests encode the intended contract: at most one PTY spawns per
// sessionId, and a second concurrent caller gets back the same live session
// rather than an independently-spawned one (which would leave the first as an
// orphan with a live onData handler still writing into the wrong buffer). The
// unit under test is PTYManager itself (the root cause); two overlapping
// start() calls stand in for the two racing handleResume calls.
// ---------------------------------------------------------------------------

interface MockProc {
  pid: number;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _emit: (event: string, data: unknown) => void;
}

const spawnedProcs: MockProc[] = [];

vi.mock("node-pty", () => {
  function makeMockProcess(): MockProc {
    const ee = new EventEmitter();
    return {
      pid: 10000 + Math.floor(Math.random() * 10000),
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return {
    spawn: vi.fn(() => {
      const p = makeMockProcess();
      spawnedProcs.push(p);
      return p;
    }),
  };
});

const RESUME_OPTS = { projectPath: "/tmp/test", projectName: "test" };
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  spawnedProcs.length = 0;
});

describe("CRITICAL #3 — concurrent resume must not double-spawn a PTY", () => {
  it("spawns at most one PTY when start() is called twice for the same sessionId", async () => {
    const mgr = new PTYManager({});

    // Two overlapping resume attempts for the SAME conversation id — the double
    // tap / client-retry scenario. Neither has finished before the other begins.
    await Promise.all([mgr.start("conv-1", RESUME_OPTS), mgr.start("conv-1", RESUME_OPTS)]);

    // Exactly one live PTY process should exist for the session. The current
    // code spawns two (and leaks the first).
    expect(spawnedProcs).toHaveLength(1);
  });

  it("a second concurrent resume returns the same session — no orphan to corrupt the buffer", async () => {
    const mgr = new PTYManager({});

    const [a, b] = await Promise.all([
      mgr.start("conv-1", RESUME_OPTS),
      mgr.start("conv-1", RESUME_OPTS),
    ]);
    await settle();

    // Only one PTY exists, and both concurrent callers got that SAME session
    // back (not two independently-spawned sessions that happen to share an
    // id) — so there is no orphaned process with a live onData handler left
    // around to interleave stray bytes into the survivor's buffer. Comparing
    // startedAt (set fresh on each spawn) proves identity, not just equal ids.
    expect(spawnedProcs).toHaveLength(1);
    expect(a.startedAt).toBe(b.startedAt);

    // The one real process's output lands in the buffer cleanly.
    spawnedProcs[0]._emit("data", "REAL-OUTPUT");
    await settle();
    expect(mgr.getOutput("conv-1")).toContain("REAL-OUTPUT");
  });
});
