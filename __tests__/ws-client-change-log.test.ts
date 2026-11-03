import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WSHub } from "../src/ws-hub";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ level: string; msg: string; fields: any }>,
}));

vi.mock("../src/logger", () => {
  const push = (level: string) => (msg: string, fields: any) =>
    h.calls.push({ level, msg, fields });
  const fake = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    log: () => {},
    pino: { isLevelEnabled: () => false },
  };
  return { getLogger: () => fake, logger: fake };
});

function mockWs(): any {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { readyState: 1, OPEN: 1, send: () => {}, close: () => {} });
}

const changes = () => h.calls.filter((c) => c.fields?.event === "ws.client_change");

describe("ws.client_change log (#488)", () => {
  let hub: WSHub;
  beforeEach(() => {
    h.calls.length = 0;
    hub = new WSHub();
  });
  afterEach(() => hub.dispose());

  it("logs the count after each connect, at info, with only event and count", () => {
    hub.addClient(mockWs());
    hub.addClient(mockWs());
    expect(changes().map((c) => c.fields)).toEqual([
      { event: "ws.client_change", count: 1 },
      { event: "ws.client_change", count: 2 },
    ]);
    expect(changes()[0].level).toBe("info");
  });

  it("logs the count after a close", () => {
    const a = mockWs();
    const b = mockWs();
    hub.addClient(a);
    hub.addClient(b);
    h.calls.length = 0;
    a.emit("close");
    b.emit("close");
    expect(changes().map((c) => c.fields.count)).toEqual([1, 0]);
  });

  it("does not log a second change when a socket closes twice", () => {
    const a = mockWs();
    hub.addClient(a);
    h.calls.length = 0;
    a.emit("close");
    a.emit("close");
    expect(changes().map((c) => c.fields.count)).toEqual([0]);
  });

  it("logs one change when a socket errors and then closes", () => {
    const a = mockWs();
    hub.addClient(a);
    h.calls.length = 0;
    a.emit("error", new Error("x"));
    a.emit("close");
    expect(changes().map((c) => c.fields.count)).toEqual([0]);
  });
});
