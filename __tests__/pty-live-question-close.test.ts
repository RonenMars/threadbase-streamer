import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { AskQuestion } from "../src/types";

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

function getMockProc(
  mgr: PTYManager,
  sessionId: string,
): { _emit: (e: string, d: string) => void } {
  const m = mgr as any;
  return m.sessions.get(sessionId).process;
}

async function spawnFresh(mgr: PTYManager) {
  return mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// A rendered AskUserQuestion menu (the footer "Enter to select" is the trigger).
const MENU =
  "Which area are you focused on?\r\n" +
  "❯ 1. macOS / Chrome\r\n" +
  "  2. iOS / Safari\r\n" +
  "  3. Android\r\n" +
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel\r\n";

describe("PTYManager — AskUserQuestion screen menu open → close", () => {
  it("fires onLiveQuestion when the menu appears", async () => {
    const opened: AskQuestion[][] = [];
    const mgr = new PTYManager({ onLiveQuestion: (_id, qs) => opened.push(qs) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", MENU);
    await settle();

    expect(opened).toHaveLength(1);
    expect(opened[0][0].question).toBe("Which area are you focused on?");
  });

  it("treats an AskUserQuestion menu as a question even when an OSC-777 notify fired (footer wins)", async () => {
    // Claude emits OSC 777 for BOTH permission gates and AskUserQuestion menus.
    // The "Enter to select" footer is the discriminator — with it on screen this
    // is a question, NOT a permission gate.
    const opened: AskQuestion[][] = [];
    const gates: unknown[] = [];
    const mgr = new PTYManager({
      onLiveQuestion: (_id, qs) => opened.push(qs),
      onPermissionChange: (_id, gate) => gates.push(gate),
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    // OSC notify arrives first (no footer yet), then the menu paints.
    proc._emit("data", "\x1b]777;notify;Claude Code;A question is ready\x07");
    await settle();
    proc._emit("data", MENU);
    await settle();

    expect(opened).toHaveLength(1);
    expect(opened[0][0].question).toBe("Which area are you focused on?");
    // No permission gate should have been broadcast with the menu's options.
    const gateWithMenuOptions = gates.find(
      (g) =>
        g &&
        typeof g === "object" &&
        "options" in g &&
        Array.isArray((g as { options: { label: string }[] }).options) &&
        (g as { options: { label: string }[] }).options.some((o) => o.label === "macOS / Chrome"),
    );
    expect(gateWithMenuOptions).toBeUndefined();
  });

  it("fires onLiveQuestionGone once the menu is answered and the prompt marker returns", async () => {
    const opened: AskQuestion[][] = [];
    let goneCount = 0;
    const mgr = new PTYManager({
      onLiveQuestion: (_id, qs) => opened.push(qs),
      onLiveQuestionGone: () => {
        goneCount += 1;
      },
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", MENU);
    await settle();
    expect(opened).toHaveLength(1);
    expect(goneCount).toBe(0);

    // The user answered: the menu/footer is gone and Claude repainted its ❯ prompt.
    proc._emit("data", "\x1b[2J\x1b[H❯ ");
    await settle();

    expect(goneCount).toBe(1);
  });

  it("does not fire onLiveQuestionGone if no menu was ever shown", async () => {
    let goneCount = 0;
    const mgr = new PTYManager({
      onLiveQuestionGone: () => {
        goneCount += 1;
      },
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", "\x1b[2J\x1b[H❯ ");
    await settle();

    expect(goneCount).toBe(0);
  });
});

const SUBMIT_SCREEN =
  "Ready to submit your answers?\r\n" +
  "❯ 1. Submit answers\r\n" +
  "  2. Cancel\r\n" +
  "Enter to select · Esc to cancel\r\n";

describe("PTYManager — AskUserQuestion submit confirmation surfaces as a card", () => {
  it("broadcasts the 'Ready to submit your answers?' screen as a question (Submit answers / Cancel)", async () => {
    // The multi-question carousel doesn't reliably auto-submit, so the submit
    // screen is shown as a real tappable card instead of being suppressed.
    const opened: AskQuestion[][] = [];
    const mgr = new PTYManager({ onLiveQuestion: (_id, qs) => opened.push(qs) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", SUBMIT_SCREEN);
    await settle();

    expect(opened).toHaveLength(1);
    expect(opened[0][0].question).toBe("Ready to submit your answers?");
    expect(opened[0][0].options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  });
});
