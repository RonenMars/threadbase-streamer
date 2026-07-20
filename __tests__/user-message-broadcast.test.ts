import { EventEmitter } from "events";
import { LiveSessionManager } from "../src/live-session-manager";
import type { WSMessage } from "../src/types";
import { WSHub } from "../src/ws-hub";

// Mock node-pty the same way the other PTY tests do.
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

const settle = () => new Promise((r) => setTimeout(r, 10));

async function lastMockProc() {
  const nodePty = await import("node-pty");
  return (nodePty.spawn as any).mock.results.at(-1).value;
}

// Wire LiveSessionManager → WSHub exactly as server.ts does for onUserMessage.
function makeManagerWithHub() {
  const hub = new WSHub();
  const mgr = new LiveSessionManager({
    onUserMessage: (sessionId, text, ts) => {
      hub.broadcast({ type: "user_message", sessionId, text, ts });
    },
  });
  return { mgr, hub };
}

function mockWs(): any {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  return Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    sentParsed: (): WSMessage[] => sent.map((s) => JSON.parse(s)),
  });
}

describe("user_message broadcast + terminal_replay userMessages", () => {
  it("broadcasts a user_message when input is submitted to the PTY", async () => {
    const { mgr, hub } = makeManagerWithHub();
    const ws = mockWs();
    hub.addClient(ws);

    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    // Reach the prompt so sendInput takes the direct write path.
    (await lastMockProc())._emit("data", "❯ ");
    await settle();

    mgr.sendInput(session.id, "ship it");
    await settle();

    const msgs = ws.sentParsed().filter((m) => m.type === "user_message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: "user_message", sessionId: session.id, text: "ship it" });
    expect(typeof (msgs[0] as any).ts).toBe("number");

    hub.dispose();
    mgr.dispose();
  });

  it("includes userMessages in the terminal_replay payload sourced from input history", async () => {
    const { mgr } = makeManagerWithHub();
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    (await lastMockProc())._emit("data", "❯ ");
    await settle();

    mgr.sendInput(session.id, "first");
    mgr.sendInput(session.id, "second");
    await settle();

    // Server builds the replay from getOutputLines + getInputHistory.
    const userMessages = mgr.getInputHistory(session.id);
    const replay: WSMessage = {
      type: "terminal_replay",
      sessionId: session.id,
      lines: await mgr.getOutputLines(session.id, 200),
      userMessages,
    };

    expect(replay.type).toBe("terminal_replay");
    expect(userMessages.map((m) => m.text)).toEqual(["first", "second"]);
    mgr.dispose();
  });
});
