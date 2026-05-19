import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { ManagedSession } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// Real-world boot chunk from the connector/MCP-status splash variant — does
// NOT contain ╭ anywhere. Captured from a stuck session in production logs.
const MCP_SPLASH_BOOT =
  "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h" +
  "\x1b]0;✳ Claude Code\x07\x1b[38;5;174m ▐\x1b[48;5;16m▛███▜\x1b[49m▌" +
  "\x1b[3C\x1b[39m\x1b[1mClaude\x1b[1CCode\x1b[1C\x1b[22m\x1b[38;5;246mv2.1.138\x1b[39m\r\r\n" +
  '❯\xa0Try "how does docusaurus.config.ts work?"\r\n';

// Real-world boot chunk from the Tips banner variant — contains ╭.
const TIPS_BANNER_BOOT =
  "\x1b[38;5;174m╭───\x1b[1CClaude Code v2.1.138" + "─────────────────────────────────────╮\r\r\n";

async function spawnFresh(mgr: PTYManager, projectPath = "/tmp/test") {
  const session = await mgr.startFresh({
    projectPath,
    projectName: "test",
  });
  // The mock spawn function is shared; grab the most recent process via the
  // private map. We expose it via the session's internal process by reaching
  // through the public API: drive the mock by emitting data and check status.
  return session;
}

function getMockProc(mgr: PTYManager, sessionId: string): any {
  // biome-ignore lint/suspicious/noExplicitAny: test reaches into private state
  return (mgr as any).sessions.get(sessionId).process;
}

describe("PTYManager — ready detection", () => {
  it("detects ╭ marker (Tips banner variant)", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", TIPS_BANNER_BOOT);

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it("detects ❯ marker when ╭ is absent (MCP splash variant)", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", MCP_SPLASH_BOOT);

    expect(MCP_SPLASH_BOOT.includes("╭")).toBe(false);
    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it("flushes queued input once ❯ marker fires", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    // User types before Claude is ready — input gets queued.
    const promptCount = mgr.sendInput(session.id, "hi");
    expect(promptCount).toBe(1);
    expect(proc.write).not.toHaveBeenCalled();

    // Claude's TUI shows the MCP splash with ❯ — should flush "hi" now.
    proc._emit("data", MCP_SPLASH_BOOT);

    expect(proc.write).toHaveBeenCalledWith("hi\r");
  });

  it("flushes queued input via time-fallback when no marker ever fires", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      mgr.sendInput(session.id, "hello");
      expect(proc.write).not.toHaveBeenCalled();

      // Tick #1: small chunk, no marker, well under the 10s window.
      proc._emit("data", "\x1b[?2004h booting...");
      expect(proc.write).not.toHaveBeenCalled();

      // Advance past the 10s fallback window.
      vi.advanceTimersByTime(10_500);

      // Tick #2: another chunk with no marker — but now elapsed > 10s, so the
      // fallback should fire and flush the queued input.
      proc._emit("data", "still booting...");

      expect(proc.write).toHaveBeenCalledWith("hello\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-fire markReady on subsequent matching chunks", async () => {
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({ onReady: (s) => ready.push(s) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", TIPS_BANNER_BOOT);
    proc._emit("data", TIPS_BANNER_BOOT);
    proc._emit("data", "❯ another prompt arrow somewhere");

    // onReady should only have fired once — pendingReady was cleared after
    // the first match.
    expect(ready).toHaveLength(1);
  });
});
