import { EventEmitter } from "events";
import type { WSMessage } from "../src/types";
import { WSHub } from "../src/ws-hub";

// Minimal mock WebSocket that implements what WSHub needs
function mockWs(readyState = 1): any {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  return Object.assign(emitter, {
    readyState,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: () => emitter.emit("close"),
    _sent: sent,
    on: emitter.on.bind(emitter),
  });
}

describe("WSHub", () => {
  let hub: WSHub;

  beforeEach(() => {
    hub = new WSHub();
  });

  afterEach(() => {
    hub.dispose();
  });

  it("starts with zero connections", () => {
    expect(hub.connectionCount).toBe(0);
  });

  it("tracks added clients", () => {
    hub.addClient(mockWs());
    hub.addClient(mockWs());
    expect(hub.connectionCount).toBe(2);
  });

  it("removes clients on close", () => {
    const ws = mockWs();
    hub.addClient(ws);
    expect(hub.connectionCount).toBe(1);

    ws.emit("close");
    expect(hub.connectionCount).toBe(0);
  });

  it("removes clients on error", () => {
    const ws = mockWs();
    hub.addClient(ws);

    ws.emit("error", new Error("connection lost"));
    expect(hub.connectionCount).toBe(0);
  });

  it("broadcasts a message to all open clients", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    hub.addClient(ws1);
    hub.addClient(ws2);

    const msg: WSMessage = { type: "ping", ts: 12345 };
    hub.broadcast(msg);

    const expected = JSON.stringify(msg);
    expect(ws1._sent).toEqual([expected]);
    expect(ws2._sent).toEqual([expected]);
  });

  it("skips clients that are not in OPEN state", () => {
    const open = mockWs(1);
    const closed = mockWs(3); // CLOSED
    hub.addClient(open);
    hub.addClient(closed);

    hub.broadcast({ type: "ping", ts: 1 });

    expect(open._sent).toHaveLength(1);
    expect(closed._sent).toHaveLength(0);
  });

  it("removes dead clients during broadcast", () => {
    const ws = mockWs(3); // Already closed
    hub.addClient(ws);
    expect(hub.connectionCount).toBe(1);

    hub.broadcast({ type: "ping", ts: 1 });
    // Dead client should be pruned
    expect(hub.connectionCount).toBe(0);
  });

  it("broadcasts terminal_output messages", () => {
    const ws = mockWs();
    hub.addClient(ws);

    const msg: WSMessage = {
      type: "terminal_output",
      sessionId: "ses_123",
      data: "hello world",
    };
    hub.broadcast(msg);

    const parsed = JSON.parse(ws._sent[0]);
    expect(parsed.type).toBe("terminal_output");
    expect(parsed.sessionId).toBe("ses_123");
    expect(parsed.data).toBe("hello world");
  });

  it("dispose closes all clients", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    hub.addClient(ws1);
    hub.addClient(ws2);

    hub.dispose();
    expect(hub.connectionCount).toBe(0);
  });
});
