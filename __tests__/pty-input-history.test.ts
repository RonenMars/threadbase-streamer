import { ConversationScanner } from "@threadbase-sh/scanner";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    mgr.dispose();
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
    mgr.dispose();
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
    mgr.dispose();
  });

  it("keeps a waiting picker waiting while raw navigation keys are written", async () => {
    const statuses: string[] = [];
    const mgr = new PTYManager({ onStatusChange: (session) => statuses.push(session.status) });
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);
    statuses.length = 0;

    mgr.sendRawKeys(session.id, "\x1b[B");

    expect(mgr.getSession(session.id)?.status).toBe("waiting_input");
    expect(statuses).toEqual([]);
    mgr.dispose();
  });

  it("marks the session running when Enter commits a selected option", async () => {
    const statuses: string[] = [];
    const mgr = new PTYManager({ onStatusChange: (session) => statuses.push(session.status) });
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);
    statuses.length = 0;

    mgr.sendKeys(session.id, "\r");

    expect(mgr.getSession(session.id)?.status).toBe("running");
    expect(statuses).toEqual(["running"]);
    mgr.dispose();
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
    mgr.dispose();
  });

  it("returns an empty history for an unknown session", () => {
    const mgr = new PTYManager();
    expect(mgr.getInputHistory("does-not-exist")).toEqual([]);
  });

  it("derives sessionName/firstMessageText from the first user message only", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    mgr.sendInput(session.id, "fix the login bug\nmore detail here");
    await settle();
    mgr.sendInput(session.id, "second message should not retitle");
    await settle();

    const updated = mgr.getSession(session.id);
    expect(updated?.firstMessageText).toBe("fix the login bug\nmore detail here");
    expect(updated?.sessionName).toBe("fix the login bug\nmore detail here");
    mgr.dispose();
  });

  it("stores a long multi-line first prompt in full", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    const prompt = ["a".repeat(190), "b".repeat(192), "c".repeat(197)].join("\n");
    mgr.sendInput(session.id, prompt);
    await settle();

    expect(mgr.getSession(session.id)?.sessionName).toBe(prompt);
    mgr.dispose();
  });

  it("does not let a slash command name the session; the next real prompt does", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);
    await makeReady(mgr, session.id);

    mgr.sendInput(session.id, "<command-name>/model</command-name>");
    await settle();
    expect(mgr.getSession(session.id)?.sessionName).toBeUndefined();

    mgr.sendInput(session.id, "Fix the login bug");
    await settle();
    mgr.sendInput(session.id, "second message should not retitle");
    await settle();
    expect(mgr.getSession(session.id)?.sessionName).toBe("Fix the login bug");
    mgr.dispose();
  });

  it.each([
    "Fix the login bug",
    "fix the login bug\nmore detail here",
    `first ${"a".repeat(190)}\nsecond ${"b".repeat(192)}\nthird ${"c".repeat(197)}`,
    '<pasted_content id="ab12">Refactor the parser</pasted_content id="ab12">',
  ])("names a live session the way the scanner names the same JSONL: %#", async (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), "live-name-parity-"));
    try {
      const projects = join(dir, "projects", "-tmp-test");
      mkdirSync(projects, { recursive: true });
      writeFileSync(
        join(projects, "sess-1.jsonl"),
        `${JSON.stringify({
          type: "user",
          sessionId: "sess-1",
          cwd: "/tmp/test",
          timestamp: "2026-02-01T10:00:00.000Z",
          message: { role: "user", content: prompt },
        })}\n`,
      );
      const scanner = new ConversationScanner({ persistent: false });
      const result = await scanner.scan({
        profiles: [{ id: "p", label: "p", configDir: dir, enabled: true }],
      });
      const scanned = (result.conversations as Array<{ sessionName: string }>)[0]?.sessionName;

      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      await makeReady(mgr, session.id);
      mgr.sendInput(session.id, prompt);
      await settle();

      expect(scanned).toBeTruthy();
      expect(mgr.getSession(session.id)?.sessionName).toBe(scanned);
      mgr.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives sessionName from queued input flushed on ready", async () => {
    const mgr = new PTYManager();
    const session = await spawnFresh(mgr);

    mgr.sendInput(session.id, "queued first message");
    await settle();
    await makeReady(mgr, session.id);

    const updated = mgr.getSession(session.id);
    expect(updated?.sessionName).toBe("queued first message");
    mgr.dispose();
  });
});
