import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { UserMessage } from "../src/types";

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
  return (mgr as any).sessions.get(sessionId).process;
}

async function spawnFresh(mgr: PTYManager) {
  return mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// Drive the session out of pendingReady so sendInput() takes the direct path.
async function makeReady(mgr: PTYManager, sessionId: string) {
  getMockProc(mgr, sessionId)._emit("data", "❯ ");
  await settle();
}

describe("PTYManager — user message input history", () => {
  it("records submitted input into inputHistory and fires onUserMessage", async () => {
    const events: UserMessage[] = [];
    const mgr = new PTYManager({ onUserMessage: (_id, text, ts) => events.push({ text, ts }) });
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    mgr.sendInput(session.id, "hello world");
    await settle();

    const history = mgr.getInputHistory(session.id);
    expect(history.map((m) => m.text)).toEqual(["hello world"]);
    expect(typeof history[0].ts).toBe("number");
    expect(events.map((e) => e.text)).toEqual(["hello world"]);
    expect(events[0].ts).toBe(history[0].ts);
  });

  it("caps inputHistory at 50 entries, dropping oldest", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    for (let i = 0; i < 55; i++) {
      mgr.sendInput(session.id, `msg-${i}`);
    }
    await settle();

    const history = mgr.getInputHistory(session.id);
    expect(history).toHaveLength(50);
    expect(history[0].text).toBe("msg-5");
    expect(history[49].text).toBe("msg-54");
  });

  it("does not record sendKeys (raw keystrokes are not messages)", async () => {
    const events: string[] = [];
    const mgr = new PTYManager({ onUserMessage: (_id, text) => events.push(text) });
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    mgr.sendKeys(session.id, "2\r");
    await settle();

    expect(mgr.getInputHistory(session.id)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("records queued input once flushed on ready", async () => {
    const events: string[] = [];
    const mgr = new PTYManager({ onUserMessage: (_id, text) => events.push(text) });
    const session = await spawnFresh(mgr);

    // Session is still booting (pendingReady) — input is queued, not written yet.
    mgr.sendInput(session.id, "queued message");
    await settle();
    expect(mgr.getInputHistory(session.id)).toHaveLength(0);
    expect(events).toHaveLength(0);

    // Prompt marker arrives → flushQueuedInputs writes+records it.
    await makeReady(mgr, session.id);

    expect(mgr.getInputHistory(session.id).map((m) => m.text)).toEqual(["queued message"]);
    expect(events).toEqual(["queued message"]);
  });

  it("returns an empty history for an unknown session", () => {
    const mgr = new PTYManager();
    expect(mgr.getInputHistory("does-not-exist")).toEqual([]);
  });
});
