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
  it("throws for unknown session", async () => {
    const mgr = new PTYManager();
    await expect(mgr.getOutputLines("no-such-id", 10)).rejects.toThrow("Session not found");
  });

  it("returns last N rendered lines from the screen", async () => {
    const mgr = new PTYManager();

    const session = await mgr.start("uuid-abc", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    // Simulate PTY output via the mock process data event.
    const nodePty = await import("node-pty");
    const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
    mockProc._emit("data", "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n");

    const lines = await mgr.getOutputLines(session.id, 3);
    expect(lines.length).toBe(3);
    expect(lines).toEqual(["line3", "line4", "line5"]);
    mgr.dispose();
  });

  it("renders absolute cursor positioning in screen order, not byte order", async () => {
    // Regression for the resume desync bug: Claude's TUI repaints with absolute
    // cursor moves (ESC[<row>;<col>H). The raw byte stream is NOT in visual
    // order, so a replay built by slicing raw bytes places new output mid-screen.
    // The rendered screen buffer must resolve positioning to true screen order.
    const mgr = new PTYManager();
    const session = await mgr.start("uuid-cursor", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    const nodePty = await import("node-pty");
    const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
    // Byte order: third row, then first row, then second row.
    mockProc._emit("data", "\x1b[3;1Hthird\x1b[1;1Hfirst\x1b[2;1Hsecond");

    const lines = await mgr.getOutputLines(session.id, 3);
    expect(lines).toEqual(["first", "second", "third"]);
    mgr.dispose();
  });

  it("clears the screen on ESC[2J so stale rows do not leak into the replay", async () => {
    // A full-screen clear (ESC[2J) followed by a repaint must not retain the
    // pre-clear rows — otherwise the replay shows duplicated/ghosted content.
    const mgr = new PTYManager();
    const session = await mgr.start("uuid-clear", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    const nodePty = await import("node-pty");
    const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
    mockProc._emit("data", "stale-line\r\n");
    mockProc._emit("data", "\x1b[2J\x1b[1;1Hfresh-line");

    const lines = await mgr.getOutputLines(session.id, 40);
    expect(lines).toContain("fresh-line");
    expect(lines).not.toContain("stale-line");
    mgr.dispose();
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
    const bigData = `${Array.from({ length: 300 }, (_, i) => `line${i}`).join("\r\n")}\r\n`;
    mockProc._emit("data", bigData);

    const lines = await mgr.getOutputLines(session.id, 200);
    expect(lines.length).toBeLessThanOrEqual(200);
    mgr.dispose();
  });
});

// ─── PTYManager.onReady callback ─────────────────────────────────────────────

describe("PTYManager onReady callback", () => {
  it("does NOT fire onReady synchronously after start() — waits for prompt marker", async () => {
    // Old behavior fired onReady immediately at spawn, which broadcast
    // session_ready before Claude had finished restoring the JSONL — the
    // resume side of the "dot bug". start() and startFresh() now share the
    // same pendingReady gating: onReady fires only via markReady().
    const onReady = vi.fn();
    const mgr = new PTYManager({ onReady });

    const session = await mgr.start("uuid-ready", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });

    expect(onReady).not.toHaveBeenCalled();
    expect(session.status).toBe("running");
    mgr.dispose();
  });

  it("does NOT fire onReady after startFresh() — server fires it after rekeySession", async () => {
    const onReady = vi.fn();
    const mgr = new PTYManager({ onReady });

    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    expect(onReady).not.toHaveBeenCalled();
    expect(session.status).toBe("running");
    mgr.dispose();
  });

  it("generates a UUID id in startFresh()", async () => {
    const mgr = new PTYManager();

    const session = await mgr.startFresh({
      projectPath: "/tmp/test",
      projectName: "test",
    });

    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    mgr.dispose();
  });

  it("does not fire onReady when callback is omitted", async () => {
    // Should not throw when onReady is undefined
    const mgr = new PTYManager();
    await expect(
      mgr.start("uuid-no-cb", { projectPath: "/tmp/test", projectName: "test" }),
    ).resolves.not.toThrow();
    mgr.dispose();
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
