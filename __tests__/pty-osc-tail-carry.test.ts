import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { PermissionOption } from "../src/services/questions/detectPermissionGate";

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

type Gate = { prompt?: string; options: PermissionOption[]; cursor?: number } | null;

function getMockProc(
  mgr: PTYManager,
  sessionId: string,
): { _emit: (e: string, d: string) => void } {
  const m = mgr as any;
  return m.sessions.get(sessionId).process;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// Box-guttered options: the │ gutter keeps the chunk-level shell-prompt hint
// from firing AND makes detectShellPrompt bail on Claude chrome — so with a
// split (unmatched) OSC, NOTHING detects this gate today. No gate footer on
// purpose: once Task 3 lands, a footer would let the screen classifier claim
// it and mask a tail-carry regression.
const GATE_OPTIONS =
  "\r\n│ Do you want to proceed?  │" +
  "\r\n│ ❯ 1. Yes                 │" +
  "\r\n│   2. No                  │\r\n";

describe("PTYManager — OSC 777 split across chunk boundaries", () => {
  it("fires the permission gate when the notify escape is split mid-sequence", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // The ~54-byte escape cut mid-word: neither half matches the OSC regex.
    proc._emit("data", "\x1b]777;notify;Claude Code;Claude nee");
    await settle();
    proc._emit("data", `ds your permission\x07${GATE_OPTIONS}`);
    await settle();

    const gate = gates.find((g) => g && g.options.length === 2);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    mgr.dispose();
  });

  it("still fires when the escape arrives whole (positive control for the harness)", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit(
      "data",
      `\x1b]777;notify;Claude Code;Claude needs your permission\x07${GATE_OPTIONS}`,
    );
    await settle();

    expect(gates.find((g) => g && g.options.length === 2)).toBeTruthy();
    mgr.dispose();
  });

  it("closes the gate when the waiting-for-input notify is split mid-sequence", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // Open via a WHOLE permission notify (known-good path)…
    proc._emit(
      "data",
      `\x1b]777;notify;Claude Code;Claude needs your permission\x07${GATE_OPTIONS}`,
    );
    await settle();
    expect(gates.some((g) => g && g.options.length === 2)).toBe(true);

    // …then split the CLOSE notify. Without tail-carry neither half matches,
    // and the still-painted options make the open-gate branch re-affirm the
    // gate instead of closing it.
    proc._emit("data", "\x1b]777;notify;Claude Code;Claude is wait");
    await settle();
    proc._emit("data", "ing for your input\x07");
    await settle();

    expect(gates[gates.length - 1]).toBeNull();
    mgr.dispose();
  });

  it("fires when the notify escape is split across THREE chunks", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // The 54-byte notify split three ways. The tail-carry bug stores only the
    // last CHUNK (not the rolling window), so after chunk B the tail is just
    // B — chunk A's "\x1b]777;notify;Claude Cod" prefix is lost, and chunk C's
    // window (B+C) never matches.
    proc._emit("data", "\x1b]777;notify;Claude Cod");
    await settle();
    proc._emit("data", "e;Claude needs your");
    await settle();
    proc._emit("data", ` permission\x07${GATE_OPTIONS}`);
    await settle();

    const gate = gates.find((g) => g && g.options.length === 2);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    mgr.dispose();
  });
});
