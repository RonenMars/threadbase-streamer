import { EventEmitter } from "events";
import type { WebSocket } from "ws";
import { PTYManager } from "../src/pty-manager";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";
import { PromptRegistry } from "../src/services/prompts/promptRegistry";
import { WSHub } from "../src/ws-hub";

/**
 * Routing the six inline `ws.send(JSON.stringify(...))` sites in
 * `server-wiring.ts` through `WSHub.unicast` must not change a single byte on
 * the wire. `unicast` serialises the same object literal with the same
 * `JSON.stringify`, so key order and therefore the emitted string are
 * unchanged — but "must not change" is the sort of claim that is only worth
 * anything if something checks it.
 *
 * EXPECTED_FRAMES below was captured by running this exact harness against the
 * pre-refactor tree (76d6d420) and pasting the result. The test passing after
 * the refactor IS the before/after comparison.
 *
 * This is a wire-contract test, not a snapshot of convenience: a deliberate
 * change to any of these six frames is supposed to fail here and be updated
 * with the change that caused it.
 */

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
      onData: (cb: (d: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const EXPECTED_FRAMES = [
  '{"type":"session_list","sessions":[{"id":"fixed-session","status":"running"}]}',
  '{"type":"cache_ready"}',
  '{"type":"prompt_snapshot","schemaVersion":1,"sessionId":"uuid-wire-identity","sequence":0,"prompts":[]}',
  '{"type":"terminal_replay","sessionId":"uuid-wire-identity","lines":["alpha","beta"],"userMessages":[]}',
  '{"type":"permission","sessionId":"uuid-wire-identity","prompt":"Allow write?","detail":"src/a.ts","options":[{"label":"Yes","value":"1"}],"cursor":0,"contentKey":"Allow write?::src/a.ts::undefined.Yes::","gateId":"gate-fixed-1"}',
  '{"type":"question","sessionId":"uuid-wire-identity","toolUseId":"tool-fixed-1","questions":[{"question":"Which?","header":"H","options":[]}]}',
];

async function captureOpenAndSubscribe(): Promise<string[]> {
  const mgr = new PTYManager();
  const session = await mgr.start("uuid-wire-identity", {
    projectPath: "/tmp/test",
    projectName: "test",
    branch: "main",
  });
  const nodePty = await import("node-pty");
  const mockProc = (nodePty.spawn as any).mock.results.at(-1).value;
  mockProc._emit("data", "alpha\r\nbeta\r\n");

  const sent: string[] = [];
  // `readyState` and `OPEN` are set explicitly, not left undefined. `unicast`
  // gates on `ws.readyState === ws.OPEN`, and on a bare `{ send }` fake that
  // compares `undefined === undefined` — so the frames would flow by accident
  // and this test would pass without ever exercising the gate.
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    on: () => {},
    terminate: () => {},
  } as unknown as WebSocket;

  const hub = new WSHub();
  const deps = createApiDeps({
    wsHub: hub,
    withReconciledLifecycle: (s: unknown) => s,
    sessionStore: { list: () => [{ id: "fixed-session", status: "running" }] },
    ptyAttachedIds: () => new Set<string>(),
    currentWarmupState: () => null,
    cacheMonitor: () => null,
    hostPressureMonitor: () => null,
    addSessionSubscriber: vi.fn(),
    removeSessionSubscriber: vi.fn(),
    wsToClientId: new Map(),
    clientIdToWs: new Map(),
    sessionSubscribers: new Map(),
    terminalSeq: new Map(),
    pendingPermission: new Map([
      [
        session.id,
        {
          prompt: "Allow write?",
          detail: "src/a.ts",
          options: [{ label: "Yes", value: "1" }],
          cursor: 0,
          gateId: "gate-fixed-1",
        },
      ],
    ]),
    pendingQuestions: new Map([
      [
        session.id,
        {
          toolUseId: "tool-fixed-1",
          questions: [{ question: "Which?", header: "H", options: [] }],
        },
      ],
    ]),
    promptRegistry: new PromptRegistry(),
    ptyManager: mgr,
    log: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  } as unknown as ApiDepsWiring);

  deps.handleWsOpen(ws);
  await deps.handleWsMessage(
    ws,
    JSON.stringify({ type: "subscribe_session", sessionId: session.id }),
    null,
  );
  await new Promise((r) => setTimeout(r, 30));

  hub.dispose();
  mgr.dispose();
  return sent;
}

describe("WSHub routing leaves the wire unchanged", () => {
  it("emits all six frames — a harness that captured nothing must not pass", async () => {
    const sent = await captureOpenAndSubscribe();
    // Without a `promptRegistry` in the wiring, site :756 is skipped by its own
    // `if` guard and this harness silently covers five of six sites.
    expect(sent).toHaveLength(6);
    expect(sent.map((s) => JSON.parse(s).type)).toEqual([
      "session_list",
      "cache_ready",
      "prompt_snapshot",
      "terminal_replay",
      "permission",
      "question",
    ]);
  });

  it("emits the pre-refactor bytes exactly", async () => {
    const sent = await captureOpenAndSubscribe();
    expect(sent).toEqual(EXPECTED_FRAMES);
  });
});
