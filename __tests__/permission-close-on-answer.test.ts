import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { PermissionOption } from "../src/services/questions/detectPermissionGate";
import { isPermissionAnswer } from "../src/services/questions/permissionAnswerKeys";

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
// Past SCRAPE_THROTTLE_MS (300), so the next chunk runs a full detection pass.
const settlePastThrottle = () => new Promise((r) => setTimeout(r, 350));

const GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

// What the PTY streams once the approved tool starts running. The leading
// erase-screen is the point: Claude wipes the gate box and repaints. The turn
// is NOT over — no end-of-turn OSC 777, and no ╭/❯ prompt marker — which is
// exactly why the detector alone cannot close the card here.
const TOOL_RUNNING = `\x1b[2J\x1b[H${[
  "⏺ Bash(git reflog -8)",
  "  ⎿  a0bfa77 HEAD@{0}: commit: fix the thing",
  "     b1c2d3e HEAD@{1}: checkout: moving from main",
].join("\r\n")}`;

// A repaint that does NOT erase the gate box — the screen still shows it.
const SPINNER_NO_ERASE = "\r\n· Pondering…";

async function openGate(): Promise<{
  mgr: PTYManager;
  sessionId: string;
  proc: { _emit: (e: string, d: string) => void };
  gates: Gate[];
}> {
  const gates: Gate[] = [];
  const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
  const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  const proc = getMockProc(mgr, session.id);

  proc._emit("data", GATE_PAINT);
  await settle();

  // Positive control: the gate really is open before we answer it. Every
  // "nothing was broadcast" assertion below is void without this.
  expect(gates.at(-1)?.options.map((o) => o.index)).toEqual([1, 2, 3]);
  gates.length = 0;
  return { mgr, sessionId: session.id, proc, gates };
}

describe("PTYManager — closing a permission gate on its answer", () => {
  it("closes the gate the moment the answer keys are written", async () => {
    const { mgr, sessionId, gates } = await openGate();

    mgr.sendKeys(sessionId, "1\r");

    // Synchronous with the write — no waiting on a repaint, an OSC, or the
    // end of the turn.
    expect(gates).toEqual([null]);
  });

  it("stays closed while the approved tool runs (the ~30s lingering card)", async () => {
    const { mgr, sessionId, proc, gates } = await openGate();

    mgr.sendKeys(sessionId, "1\r");
    expect(gates).toEqual([null]);

    gates.length = 0;
    await settlePastThrottle();
    proc._emit("data", TOOL_RUNNING);
    await settle();

    // The box is gone, so the paint-time claim finds nothing to reopen.
    expect(gates).toEqual([]);
  });

  it("does not close on keystrokes that are not this gate's answer", async () => {
    const { mgr, sessionId, gates } = await openGate();

    mgr.sendKeys(sessionId, "\x1b[B"); // arrow-down: moves the cursor, answers nothing
    mgr.sendKeys(sessionId, "\r"); // bare Enter: accepts the highlight, but we can't tell
    mgr.sendKeys(sessionId, "4\r"); // a number this gate does not offer
    expect(gates).toEqual([]);

    // Positive control for the three assertions above: the same session on the
    // same open gate DOES close for a real option index.
    mgr.sendKeys(sessionId, "3\r");
    expect(gates).toEqual([null]);
  });

  it("reopens the gate if the answer did not take and the box is still painted", async () => {
    const { mgr, sessionId, proc, gates } = await openGate();

    mgr.sendKeys(sessionId, "2\r");
    expect(gates).toEqual([null]);

    // Claude never consumed the keystroke — the box is still on screen, and the
    // next repaint does not erase it.
    gates.length = 0;
    await settlePastThrottle();
    proc._emit("data", SPINNER_NO_ERASE);
    await settle();

    expect(gates.at(-1)?.options.map((o) => o.index)).toEqual([1, 2, 3]);
  });
});

describe("isPermissionAnswer", () => {
  const gate = {
    options: [
      { index: 1, label: "Yes" },
      { index: 2, label: "Yes, and don't ask again" },
      { index: 3, label: "No" },
    ],
  };

  it("accepts the on-screen number plus Enter, for every option", () => {
    expect(isPermissionAnswer(gate, "1\r")).toBe(true);
    expect(isPermissionAnswer(gate, "2\r")).toBe(true);
    expect(isPermissionAnswer(gate, "3\r")).toBe(true);
  });

  it("rejects anything that is not one of this gate's answers", () => {
    for (const keys of ["\x1b[B", "\x1b[A", "\x1b", "\r", "1", "4\r", "13\r", "y\r", "hello"]) {
      expect(isPermissionAnswer(gate, keys)).toBe(false);
    }
  });

  it("accepts an option's literal answerKeys when the number is not the answer", () => {
    // The unstructured shell-prompt path (detectShellPrompt) answers y/N, not 1/2.
    const shell = {
      options: [
        { index: 1, label: "y", answerKeys: "y\r" },
        { index: 2, label: "N", answerKeys: "n\r" },
      ],
    };
    expect(isPermissionAnswer(shell, "y\r")).toBe(true);
    expect(isPermissionAnswer(shell, "n\r")).toBe(true);
    // The index is NOT the answer here, so it must not close the card.
    expect(isPermissionAnswer(shell, "1\r")).toBe(false);
  });

  it("never matches a gate whose options have not painted yet", () => {
    expect(isPermissionAnswer({ options: [] }, "1\r")).toBe(false);
    expect(isPermissionAnswer({ options: [] }, "\r")).toBe(false);
  });
});
