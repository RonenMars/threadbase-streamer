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

// Wire LiveSessionManager → WSHub exactly as server.ts's onOutput does: a
// per-session counter stamped onto every terminal_output broadcast.
function makeManagerWithSeq() {
  const hub = new WSHub();
  const terminalSeq = new Map<string, number>();
  const mgr = new LiveSessionManager({
    onOutput: (sessionId, data) => {
      const seq = (terminalSeq.get(sessionId) ?? 0) + 1;
      terminalSeq.set(sessionId, seq);
      hub.broadcast({ type: "terminal_output", sessionId, data, seq });
    },
  });
  return { mgr, hub };
}

describe("terminal_output seq", () => {
  it("increments per chunk, starting at 1, independently per session", async () => {
    const { mgr, hub } = makeManagerWithSeq();
    const ws = mockWs();
    hub.addClient(ws);

    const sessionA = await mgr.startFresh({ projectPath: "/tmp/a", projectName: "a" });
    const sessionB = await mgr.startFresh({ projectPath: "/tmp/b", projectName: "b" });

    const procs = (await import("node-pty")).spawn as any;
    const procA = procs.mock.results[procs.mock.results.length - 2].value;
    const procB = procs.mock.results[procs.mock.results.length - 1].value;

    procA._emit("data", "chunk-a1");
    procB._emit("data", "chunk-b1");
    procA._emit("data", "chunk-a2");
    await settle();

    const outputs = ws.sentParsed().filter((m) => m.type === "terminal_output") as Array<{
      sessionId: string;
      data: string;
      seq?: number;
    }>;
    const seqA = outputs.filter((m) => m.sessionId === sessionA.id).map((m) => m.seq);
    const seqB = outputs.filter((m) => m.sessionId === sessionB.id).map((m) => m.seq);

    expect(seqA).toEqual([1, 2]);
    expect(seqB).toEqual([1]);

    hub.dispose();
    mgr.dispose();
  });

  it("passes seq through terminal_replay for a resubscribing client to baseline", async () => {
    const hub = new WSHub();
    const ws = mockWs();
    hub.addClient(ws);

    hub.unicast(ws, {
      type: "terminal_replay",
      sessionId: "sess-1",
      lines: ["hello"],
      seq: 3,
    });

    const [replay] = ws.sentParsed();
    expect(replay).toMatchObject({ type: "terminal_replay", seq: 3 });

    hub.dispose();
  });
});
