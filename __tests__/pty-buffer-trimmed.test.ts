import { EventEmitter } from "events";
import { afterEach, beforeEach, vi } from "vitest";
import type { Logger } from "../src/logger";
import { PTYManager } from "../src/pty-manager";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 4242,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

const CAP = 65536;
const MARKER = "MARKER_SECRET_hunter2_7f3c";

type Fields = Record<string, unknown>;
type MockProc = { _emit: (event: string, data: string) => void };

function setup() {
  const entries: Fields[] = [];
  const record = (_msg: string, fields?: Fields) => {
    if (fields) entries.push(fields);
  };
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    log: (_l: unknown, msg: string, fields?: Fields) => record(msg, fields),
    pino: {} as Logger["pino"],
  } as Logger;
  const mgr = new PTYManager({ logger });
  const trimmed = () => entries.filter((e) => e.event === "pty.buffer_trimmed");
  return { mgr, entries, trimmed };
}

async function open(mgr: PTYManager) {
  const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  const entry = (mgr as unknown as { sessions: Map<string, { process: MockProc }> }).sessions.get(
    session.id,
  );
  if (!entry) throw new Error("no mock process");
  const proc = entry.process;
  return { id: session.id, emit: (s: string) => proc._emit("data", s) };
}

describe("PTYManager pty.buffer_trimmed", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("stays silent while the ring buffer is under its cap", async () => {
    const { mgr, trimmed } = setup();
    const s = await open(mgr);
    s.emit("x".repeat(CAP));
    expect(trimmed()).toHaveLength(0);
    mgr.dispose();
  });

  it("logs sessionId and the exact dropped byte count, never the content", async () => {
    const { mgr, entries, trimmed } = setup();
    const s = await open(mgr);
    s.emit(`${MARKER}${"x".repeat(CAP + 100 - MARKER.length)}`);
    expect(trimmed()).toHaveLength(1);
    expect(trimmed()[0]).toMatchObject({ sessionId: s.id, droppedBytes: 100 });
    expect(JSON.stringify(entries)).not.toContain(MARKER);
    mgr.dispose();
  });

  it("aggregates trims inside the throttle window and flushes the total on the next trim after it", async () => {
    const { mgr, trimmed } = setup();
    const s = await open(mgr);
    s.emit("x".repeat(CAP + 10)); // trim 10 -> logged
    now += 100;
    s.emit("y".repeat(20)); // trim 20 -> held
    now += 100;
    s.emit("y".repeat(30)); // trim 30 -> held
    expect(trimmed()).toHaveLength(1);
    now += 5_000;
    s.emit("y".repeat(40)); // trim 40 -> flushes 20+30+40
    expect(trimmed()).toHaveLength(2);
    expect(trimmed()[1]).toMatchObject({ sessionId: s.id, droppedBytes: 90 });
    mgr.dispose();
  });

  it("throttles per session", async () => {
    const { mgr, trimmed } = setup();
    const a = await open(mgr);
    const b = await open(mgr);
    a.emit("x".repeat(CAP + 1));
    b.emit("x".repeat(CAP + 2));
    expect(trimmed().map((e) => [e.sessionId, e.droppedBytes])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
    mgr.dispose();
  });
});
