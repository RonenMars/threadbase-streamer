import type { WebSocket } from "ws";
import type { ApiDepsWiring } from "../src/server-wiring";
import { createApiDeps } from "../src/server-wiring";
import { capabilitiesForPreset, type Principal } from "../src/services/security/capabilities";
import { WSHub } from "../src/ws-hub";

/**
 * Issue #491: a `subscribe_session` frame left no trace, so "did the client
 * ever subscribe?" could not be answered from the log. The line carries ids
 * only, never frame content.
 */

function build() {
  const debug = vi.fn();
  const wiring = {
    startGraceTimer: vi.fn(),
    armHoldWhenIdle: vi.fn(),
    addSessionSubscriber: vi.fn(),
    removeSessionSubscriber: vi.fn(),
    ptyGracePeriodMs: 1000,
    wsToClientId: new Map(),
    clientIdToWs: new Map(),
    sessionSubscribers: new Map(),
    terminalSeq: new Map(),
    pendingPermission: new Map(),
    pendingQuestions: new Map(),
    ptyManager: { hasSession: () => false },
    wsHub: new WSHub(),
    log: () => ({ warn: vi.fn(), info: vi.fn(), debug, error: vi.fn() }),
  } as unknown as ApiDepsWiring;
  return { debug, handleWsMessage: createApiDeps(wiring).handleWsMessage };
}

const ws = { send: () => {} } as unknown as WebSocket;
const full: Principal = { kind: "device", capabilities: capabilitiesForPreset("full") };
const none: Principal = { kind: "device", capabilities: [] };
const frame = (m: object) => JSON.stringify(m);

describe("subscribe_session receipt log", () => {
  it("logs the session id and the registered client id", () => {
    const { debug, handleWsMessage } = build();
    handleWsMessage(ws, frame({ type: "register", clientId: "c1" }), full);
    handleWsMessage(ws, frame({ type: "subscribe_session", sessionId: "s1" }), full);
    expect(debug).toHaveBeenCalledWith(
      "[ws] subscribe_session",
      expect.objectContaining({ event: "ws.subscribe_session", sessionId: "s1", clientId: "c1" }),
    );
  });

  it("logs with no client id when the socket never registered", () => {
    const { debug, handleWsMessage } = build();
    handleWsMessage(ws, frame({ type: "subscribe_session", sessionId: "s1" }), full);
    expect(debug).toHaveBeenCalledWith(
      "[ws] subscribe_session",
      expect.objectContaining({ event: "ws.subscribe_session", sessionId: "s1" }),
    );
  });

  it("logs a frame the capability check then refuses", () => {
    const { debug, handleWsMessage } = build();
    handleWsMessage(ws, frame({ type: "subscribe_session", sessionId: "s1" }), none);
    expect(debug).toHaveBeenCalledWith(
      "[ws] subscribe_session",
      expect.objectContaining({ event: "ws.subscribe_session", sessionId: "s1" }),
    );
  });

  it("logs ids only, never other frame content", () => {
    const { debug, handleWsMessage } = build();
    handleWsMessage(
      ws,
      frame({ type: "subscribe_session", sessionId: "s1", secret: "hunter2" }),
      full,
    );
    const fields = debug.mock.calls.find((c) => c[0] === "[ws] subscribe_session")?.[1];
    expect(Object.keys(fields).sort()).toEqual(["clientId", "event", "sessionId"]);
  });

  it("does not log other frame types as subscribe_session", () => {
    const { debug, handleWsMessage } = build();
    handleWsMessage(ws, frame({ type: "unsubscribe_session", sessionId: "s1" }), full);
    expect(debug).not.toHaveBeenCalledWith("[ws] subscribe_session", expect.anything());
  });
});
