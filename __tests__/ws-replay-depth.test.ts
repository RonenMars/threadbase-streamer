import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import { PTYManager } from "../src/pty-manager";
import { REPLAY_MAX_LINES } from "../src/pty-shared";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";

/**
 * `subscribe_session` used to replay a fixed 200 lines while the render
 * terminal holds REPLAY_MAX_LINES, so a client that could display far more
 * still saw only the tail. A line-count assertion passes on that bug — the
 * defect is *which* lines arrive — so this asserts on the earliest line the
 * terminal still holds.
 */

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

it("replays the whole render terminal, not just its tail", async () => {
  const mgr = new PTYManager();
  const session = await mgr.start("uuid-replay-depth", {
    projectPath: "/tmp/test",
    projectName: "test",
    branch: "main",
  });

  const nodePty = await import("node-pty");
  const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
  // Half the terminal's capacity: comfortably past the old 200, comfortably
  // inside the scrollback, so every fed line is still retained.
  const total = Math.floor(REPLAY_MAX_LINES / 2);
  mockProc._emit("data", `${Array.from({ length: total }, (_, i) => `line${i}`).join("\r\n")}\r\n`);

  const sent: string[] = [];
  const ws = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
  const { handleWsMessage } = createApiDeps({
    addSessionSubscriber: vi.fn(),
    wsToClientId: new Map(),
    clientIdToWs: new Map(),
    sessionSubscribers: new Map(),
    terminalSeq: new Map(),
    pendingPermission: new Map(),
    pendingQuestions: new Map(),
    ptyManager: mgr,
    log: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  } as unknown as ApiDepsWiring);

  handleWsMessage(ws, JSON.stringify({ type: "subscribe_session", sessionId: session.id }), null);
  await new Promise((r) => setTimeout(r, 20));

  const replay = sent.map((s) => JSON.parse(s)).find((m) => m.type === "terminal_replay");
  expect(replay).toBeDefined();
  expect(replay.lines).toContain("line0");
  expect(replay.lines).toContain(`line${total - 1}`);

  mgr.dispose();
});
