import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import type { Logger } from "../src/logger";
import { PTYManager } from "../src/pty-manager";

// Default logs must be content-free: what the user typed, what the agent
// painted, and what a prompt asked are never allowed into a log line, at any
// level. The old `digestBytes` "digest" was 200 chars of reversible plaintext,
// and the debug-level prompt_detect dump carried the rendered screen and the
// scraped gate/question objects.
//
// Method: drive the REAL runners through the mocked PTY, tap the logger they
// are constructed with, push a marker through every content path (input,
// keys, output chunk, gate screen), then assert the marker appears nowhere in
// the serialized log stream. Each test first proves the tap saw the exact
// event under test (positive control) so an empty log cannot pass by accident.

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

const MARKER = "MARKER_SECRET_hunter2_7f3c";

type MockProc = { _emit: (event: string, data: string) => void };

function getMockProc(runner: object, sessionId: string): MockProc {
  const internals = runner as { sessions: Map<string, { process: MockProc }> };
  const entry = internals.sessions.get(sessionId);
  if (!entry) throw new Error(`No mock process for ${sessionId}`);
  return entry.process;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

interface Entry {
  msg: string;
  fields?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; entries: Entry[]; text: () => string } {
  const entries: Entry[] = [];
  const record = (msg: string, fields?: Record<string, unknown>) => {
    entries.push({ msg, fields });
  };
  const logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    log: (_l: unknown, msg: string, fields?: Record<string, unknown>) => record(msg, fields),
    pino: {} as Logger["pino"],
  } as Logger;
  return { logger, entries, text: () => JSON.stringify(entries) };
}

const eventsOf = (entries: Entry[]) => entries.map((e) => e.fields?.event).filter(Boolean);

describe("PTYManager (Claude) default logs are content-free", () => {
  it("keeps input, keys and output chunks out of the logs", async () => {
    const { logger, entries, text } = captureLogger();
    const mgr = new PTYManager({ logger });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);
    proc._emit("data", "❯ "); // prompt marker → ready, so sendInput takes the direct path
    await settle();

    mgr.sendInput(session.id, MARKER);
    mgr.sendKeys(session.id, `${MARKER}\r`);
    proc._emit("data", `echo ${MARKER}\r\n`);
    await settle();

    // Positive control: the tap saw the exact lines under test.
    const events = eventsOf(entries);
    expect(events).toContain("pty.input_write");
    expect(events).toContain("pty.keys_write");
    expect(events).toContain("pty.chunk");
    const write = entries.find((e) => e.fields?.event === "pty.input_write");
    expect(write?.fields?.byteLen).toBeGreaterThan(0);

    expect(text()).not.toContain(MARKER);
    mgr.dispose();
  });

  it("prompt_detect reports detector verdicts, not the rendered screen", async () => {
    const { logger, entries, text } = captureLogger();
    const mgr = new PTYManager({ logger });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);
    proc._emit("data", "❯ ");
    await settle();

    // A real gate shape (see detect-permission-gate.test.ts) with the marker
    // in the prompt line, then the OSC 777 notify that triggers detection.
    proc._emit(
      "data",
      `\x1b[2J\x1b[HClaude needs your permission to use Bash ${MARKER}\r\n\r\n` +
        "❯ 2. Yes\r\n  3. No, and tell Claude what to do differently\r\nEsc to cancel\r\n",
    );
    await settle();
    proc._emit("data", "\x1b]777;notify;Claude Code;Claude needs your permission\x07");
    await settle();

    const detect = entries.find((e) => e.fields?.event === "pty.prompt_detect");
    expect(detect).toBeDefined();
    expect(detect?.fields).toMatchObject({ permGateDetected: true, permGateOptionCount: 2 });

    expect(text()).not.toContain(MARKER);
    expect(text()).not.toContain("Esc to cancel");
    mgr.dispose();
  });
});

describe("CodexPtyRunner default logs are content-free", () => {
  // The trust gate is only carded when it has not already been answered, and
  // the runner reads gate-answers.json from the config dir at call time.
  let configDirBefore: string | undefined;
  beforeEach(() => {
    configDirBefore = process.env.THREADBASE_CONFIG_DIR;
    process.env.THREADBASE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tb-content-free-"));
  });
  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
    else process.env.THREADBASE_CONFIG_DIR = configDirBefore;
  });

  it("keeps input, keys and the gate prompt out of the logs", async () => {
    const { logger, entries, text } = captureLogger();
    const runner = new CodexPtyRunner({ logger });
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
    const proc = getMockProc(runner, session.id);
    proc._emit("data", "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…\r\n");
    await settle();

    runner.sendInput(session.id, MARKER);
    runner.sendKeys(session.id, `${MARKER}\r`);
    proc._emit(
      "data",
      `Do you want to trust the contents of this directory? ${MARKER}\r\n` +
        "1. Yes, continue\r\n2. No, quit\r\nPress enter to continue\r\n",
    );
    await settle();

    const events = eventsOf(entries);
    expect(events).toContain("codex.input_write");
    expect(events).toContain("codex.keys_write");
    expect(events).toContain("codex.gate_prompt");

    expect(text()).not.toContain(MARKER);
    expect(text()).not.toContain("trust the contents");
    runner.dispose();
  });

  // codex.screen used to log the bottom rendered line as `statusBar` (and
  // `bar=` in the message). Outside the Ready state that line is whatever the
  // TUI last painted — a prompt, tool output, anything.
  it("keeps the bottom screen line out of codex.screen", async () => {
    const { logger, entries, text } = captureLogger();
    const runner = new CodexPtyRunner({ logger });
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
    const proc = getMockProc(runner, session.id);

    proc._emit("data", `Starting MCP servers…\r\nlast line ${MARKER}\r\n`);
    await settle();

    expect(eventsOf(entries)).toContain("codex.screen");
    expect(text()).not.toContain(MARKER);
    runner.dispose();
  });
});
