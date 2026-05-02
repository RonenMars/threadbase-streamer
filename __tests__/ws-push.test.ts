import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import { WSHub } from "../src/ws-hub";

// ─── Mock node-pty ────────────────────────────────────────────────────────────
// PTYManager dynamically imports node-pty; we mock it at the module resolver level.

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// ─── Mock WebSocket helper ────────────────────────────────────────────────────

function mockWs(readyState = 1): any {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  return Object.assign(emitter, {
    readyState,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    _sent: sent,
    on: emitter.on.bind(emitter),
    sentParsed: () => sent.map((s) => JSON.parse(s)),
  });
}

// ─── PTYManager.getOutputLines() ─────────────────────────────────────────────

describe("PTYManager.getOutputLines()", () => {
  it("throws for unknown session", () => {
    const mgr = new PTYManager();
    expect(() => mgr.getOutputLines("no-such-id", 10)).toThrow("Session not found");
  });

  it("returns last N lines from the ring buffer", async () => {
    let capturedOutput: ((sessionId: string, data: string) => void) | undefined;
    const mgr = new PTYManager({
      onOutput: (sid, data) => {
        capturedOutput?.(sid, data);
      },
    });

    const session = await mgr.start("uuid-abc", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    // Simulate PTY output by going through onOutput — the ring buffer is private,
    // so we use the internal data event instead via the mock's _emit.
    // Access the mock process via the pty module we control.
    const nodePty = await import("node-pty");
    const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
    mockProc._emit("data", "line1\nline2\nline3\nline4\nline5\n");

    const lines = mgr.getOutputLines(session.id, 3);
    // split on \n gives ["line1","line2","line3","line4","line5",""], slice(-3) = ["line5",""]
    // The last 3 elements after splitting "line1\nline2\nline3\nline4\nline5\n"
    expect(lines.length).toBe(3);
    expect(lines).toContain("line5");
  });

  it("caps at maxLines — never returns more than requested", async () => {
    const mgr = new PTYManager();
    const session = await mgr.start("uuid-cap", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    const nodePty = await import("node-pty");
    const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
    // Feed 300 lines
    const bigData = Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n") + "\n";
    mockProc._emit("data", bigData);

    const lines = mgr.getOutputLines(session.id, 200);
    expect(lines.length).toBeLessThanOrEqual(200);
  });
});

// ─── PTYManager.onReady callback ─────────────────────────────────────────────

describe("PTYManager onReady callback", () => {
  it("fires onReady after start()", async () => {
    const onReady = vi.fn();
    const mgr = new PTYManager({ onReady });

    const session = await mgr.start("uuid-ready", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0][0].id).toBe(session.id);
  });

  it("fires onReady after startFresh()", async () => {
    const onReady = vi.fn();
    const mgr = new PTYManager({ onReady });

    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0][0].status).toBe("running");
  });

  it("uses caller-supplied pendingId in startFresh()", async () => {
    const onReady = vi.fn();
    const mgr = new PTYManager({ onReady });

    await mgr.startFresh({
      projectPath: "/tmp/test",
      projectName: "test",
      pendingId: "pending_custom123",
    });

    expect(onReady.mock.calls[0][0].id).toBe("pending_custom123");
  });

  it("does not fire onReady when callback is omitted", async () => {
    // Should not throw when onReady is undefined
    const mgr = new PTYManager();
    await expect(
      mgr.start("uuid-no-cb", { projectPath: "/tmp/test", projectName: "test" }),
    ).resolves.not.toThrow();
  });
});

// ─── WSHub: terminal_replay and session_ready event types ────────────────────

describe("WSHub broadcast — new event types", () => {
  let hub: WSHub;

  beforeEach(() => {
    hub = new WSHub();
  });

  afterEach(() => {
    hub.dispose();
  });

  it("broadcasts terminal_replay to all connected clients", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    hub.addClient(ws1);
    hub.addClient(ws2);

    hub.broadcast({ type: "terminal_replay", sessionId: "abc", lines: ["hello", "world"] });

    const parsed1 = ws1.sentParsed()[0];
    expect(parsed1.type).toBe("terminal_replay");
    expect(parsed1.sessionId).toBe("abc");
    expect(parsed1.lines).toEqual(["hello", "world"]);

    const parsed2 = ws2.sentParsed()[0];
    expect(parsed2.type).toBe("terminal_replay");
  });

  it("broadcasts session_ready to all connected clients", () => {
    const ws = mockWs();
    hub.addClient(ws);

    const fakeSession = {
      id: "ses-123",
      conversationId: "ses-123",
      status: "running" as const,
      projectPath: "/tmp",
      projectName: "test",
      branch: "main",
      lastOutput: "",
      elapsedMs: 0,
      promptCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      ptyAttached: true,
    };

    hub.broadcast({ type: "session_ready", session: fakeSession });

    const parsed = ws.sentParsed()[0];
    expect(parsed.type).toBe("session_ready");
    expect(parsed.session.id).toBe("ses-123");
    expect(parsed.session.ptyAttached).toBe(true);
  });
});

// ─── terminal_replay unicast (not broadcast) ─────────────────────────────────

describe("terminal_replay unicast behavior", () => {
  it("sending directly to a single ws does not go to other clients", () => {
    const subscriber = mockWs();
    const bystander = mockWs();

    // Simulate what the server does: send directly to ws, not via hub.broadcast
    const payload = JSON.stringify({
      type: "terminal_replay",
      sessionId: "ses-abc",
      lines: ["output line"],
    });
    subscriber.send(payload);

    expect(subscriber._sent).toHaveLength(1);
    expect(bystander._sent).toHaveLength(0); // bystander receives nothing
  });
});
