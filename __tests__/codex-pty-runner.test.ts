import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { tmpdir } from "os";
import { join } from "path";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import type { ManagedSession, PermissionOption } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 54321,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// Real-world status-bar line captured during Phase 0 live-PTY probing —
// Codex is booted and usable. Padded with leading rows so the "last
// non-blank line" check exercises real screen rendering, not just a single
// chunk.
const READY_STATUS_BAR = "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…\r\n";

// "Starting" state: MCP servers still loading. The compose box `›` prefix is
// already visible here — must NOT be treated as ready.
const STARTING_STATUS_BAR = "› \r\ngpt-5.5 medium · /path · gpt-5.5 · medium · Starting\r\n";

// Directory-trust gate, captured verbatim per Phase 0 findings.
const TRUST_GATE_SCREEN =
  "Do you want to trust the contents of this directory?\r\n" +
  "1. Yes, continue\r\n" +
  "2. No, quit\r\n" +
  "Press enter to continue\r\n";

// Hooks-review gate, captured verbatim from a live PTY probe (2026-07-14).
const HOOKS_GATE_SCREEN =
  "  Hooks need review\r\n" +
  "  1 hook is new or changed.\r\n" +
  "  Hooks can run outside the sandbox after you trust them.\r\n" +
  "\r\n" +
  "› 1. Review hooks\r\n" +
  "  2. Trust all and continue\r\n" +
  "  3. Continue without trusting (hooks won't run)\r\n" +
  "\r\n" +
  "  Press enter to confirm or esc to go back\r\n";

// Isolate the persisted gate-answer store per test — rememberedGateDigit /
// saveGateAnswer resolve the config dir at call time, so pointing the env var
// at a fresh temp dir keeps tests off the real ~/.threadbase.
let configDirBefore: string | undefined;
let testConfigDir: string;
beforeEach(() => {
  configDirBefore = process.env.THREADBASE_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "tb-gate-test-"));
  process.env.THREADBASE_CONFIG_DIR = testConfigDir;
});
afterEach(() => {
  if (configDirBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = configDirBefore;
});

function writeRememberedAnswers(answers: Record<string, string>): void {
  writeFileSync(join(testConfigDir, "gate-answers.json"), JSON.stringify(answers));
}

function readRememberedAnswers(): Record<string, string> {
  return JSON.parse(readFileSync(join(testConfigDir, "gate-answers.json"), "utf-8"));
}

async function spawnFresh(runner: CodexPtyRunner, projectPath = "/tmp/test") {
  return runner.startFresh({ projectPath, projectName: "test" });
}

async function spawnResume(runner: CodexPtyRunner, sessionId = "codex-session-id") {
  return runner.start(sessionId, {
    projectPath: "/tmp/test",
    projectName: "test",
    branch: "main",
  });
}

function getMockProc(runner: CodexPtyRunner, sessionId: string): any {
  return (runner as any).sessions.get(sessionId).process;
}

function spawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

describe("CodexPtyRunner — spawn args", () => {
  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns codex --cd <projectPath> --no-alt-screen with no other args", async () => {
    const runner = new CodexPtyRunner();
    const session = await spawnFresh(runner, "/tmp/proj");

    expect(session.provider).toBe("codex-cli");
    const args = spawnArgs();
    expect(args).toEqual(["--cd", "/tmp/proj", "--no-alt-screen"]);
  });

  it("startFresh appends systemPrompt as the trailing positional [PROMPT] arg", async () => {
    const runner = new CodexPtyRunner();
    await runner.startFresh({
      projectPath: "/tmp/proj",
      projectName: "test",
      systemPrompt: "stay in the sandbox",
    });

    const args = spawnArgs();
    expect(args).toEqual(["--cd", "/tmp/proj", "--no-alt-screen", "stay in the sandbox"]);
  });

  it("start (resume) spawns codex resume <sessionId> --cd <projectPath> --no-alt-screen", async () => {
    const runner = new CodexPtyRunner();
    await runner.start("abc-123", { projectPath: "/tmp/proj", projectName: "test" });

    const args = spawnArgs();
    expect(args).toEqual(["resume", "abc-123", "--cd", "/tmp/proj", "--no-alt-screen"]);
  });
});

type GateBroadcast = { prompt?: string; options: PermissionOption[] } | null;

function gateRunner() {
  const cards: GateBroadcast[] = [];
  const ready: ManagedSession[] = [];
  const runner = new CodexPtyRunner({
    onPermissionChange: (_sessionId, gate) => cards.push(gate as GateBroadcast),
    onReady: (s) => ready.push(s),
  });
  return { runner, cards, ready };
}

describe("CodexPtyRunner — directory-trust gate", () => {
  it("broadcasts a question card (Yes/No + remember variant) and writes nothing", async () => {
    const { runner, cards, ready } = gateRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", TRUST_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proc.write).not.toHaveBeenCalled();
    expect(ready).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.prompt).toContain("trust the contents");
    expect(cards[0]?.options).toEqual([
      { index: 1, label: "Yes, continue", answerKeys: "1\r" },
      { index: 2, label: "No, quit", answerKeys: "2\r" },
      { index: 3, label: "Yes, continue (remember for all projects)", answerKeys: "3\r" },
    ]);

    // A repaint of the same gate must not re-broadcast.
    proc._emit("data", TRUST_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards).toHaveLength(1);
  });

  it("auto-answers with 1 when codexTrustGate is remembered", async () => {
    writeRememberedAnswers({ codexTrustGate: "yes" });
    const { runner, cards } = gateRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", TRUST_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cards).toHaveLength(0);
    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith("1");
  });
});

describe("CodexPtyRunner — hooks-review gate", () => {
  it("broadcasts a card with real + remember options (Review hooks omitted)", async () => {
    const { runner, cards } = gateRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", HOOKS_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(proc.write).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.prompt).toContain("Hooks need review");
    expect(cards[0]?.prompt).toContain("1 hook is new or changed.");
    expect(cards[0]?.options).toEqual([
      { index: 2, label: "Trust all and continue", answerKeys: "2\r" },
      { index: 3, label: "Continue without trusting (hooks won't run)", answerKeys: "3\r" },
      { index: 4, label: "Trust all and continue (remember for all projects)", answerKeys: "4\r" },
      {
        index: 5,
        label: "Continue without trusting (remember for all projects)",
        answerKeys: "5\r",
      },
    ]);
  });

  it("auto-answers with the remembered digit and no card", async () => {
    writeRememberedAnswers({ codexHooksGate: "continue_untrusted" });
    const { runner, cards } = gateRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", HOOKS_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cards).toHaveLength(0);
    expect(proc.write).toHaveBeenCalledTimes(1);
    expect(proc.write).toHaveBeenCalledWith("3");
  });
});

describe("CodexPtyRunner — gate answer interception (sendKeys)", () => {
  async function openHooksGate() {
    const { runner, cards } = gateRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);
    proc._emit("data", HOOKS_GATE_SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards).toHaveLength(1);
    proc.write.mockClear();
    return { runner, session, proc, cards };
  }

  it("synthetic remember digit persists the choice and writes the real digit", async () => {
    const { runner, session, proc } = await openHooksGate();

    runner.sendKeys(session.id, "4\r");
    expect(proc.write).toHaveBeenCalledWith("2");
    expect(readRememberedAnswers()).toEqual({ codexHooksGate: "trust_all" });
  });

  it("synthetic continue-untrusted digit persists and maps to 3", async () => {
    const { runner, session, proc } = await openHooksGate();

    runner.sendKeys(session.id, "5\r");
    expect(proc.write).toHaveBeenCalledWith("3");
    expect(readRememberedAnswers()).toEqual({ codexHooksGate: "continue_untrusted" });
  });

  it("real digits pass through (Enter stripped) and persist nothing", async () => {
    const { runner, session, proc } = await openHooksGate();

    runner.sendKeys(session.id, "2\r");
    expect(proc.write).toHaveBeenCalledWith("2");
    expect(() => readRememberedAnswers()).toThrow();
  });

  it("non-digit keys and keys outside an open gate are untouched", async () => {
    const { runner, session, proc } = await openHooksGate();

    runner.sendKeys(session.id, "\x1b[B");
    expect(proc.write).toHaveBeenCalledWith("\x1b[B");

    // Close the gate (normal boot screen) — digits now pass through verbatim.
    proc._emit("data", "\x1b[2J\x1b[H› compose\r\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.write.mockClear();
    runner.sendKeys(session.id, "4\r");
    expect(proc.write).toHaveBeenCalledWith("4\r");
  });
});

describe("CodexPtyRunner — gate close", () => {
  it("dismisses the card and flushes input held while the gate was open", async () => {
    vi.useFakeTimers();
    try {
      const { runner, cards, ready } = gateRunner();
      const session = await spawnFresh(runner);
      const proc = getMockProc(runner, session.id);

      proc._emit("data", HOOKS_GATE_SCREEN);
      await vi.advanceTimersByTimeAsync(0);
      expect(cards).toHaveLength(1);

      runner.sendInput(session.id, "hello");

      // Quiet fires while the gate is open: ready is marked (mobile navigates
      // in and sees the card) but the queued input stays held.
      await vi.advanceTimersByTimeAsync(600);
      expect(ready).toHaveLength(1);
      expect(proc.write).not.toHaveBeenCalled();

      // Gate answered elsewhere → screen moves on → card dismissed, queue drains.
      proc._emit("data", `\x1b[2J\x1b[H${READY_STATUS_BAR}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(cards[cards.length - 1]).toBeNull();

      await vi.advanceTimersByTimeAsync(60);
      const writes = proc.write.mock.calls.map((c: unknown[]) => c[0]);
      expect(writes).toContain("hello");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexPtyRunner — ready fallbacks", () => {
  it("marks ready after 500ms of PTY silence even without the Ready marker", async () => {
    vi.useFakeTimers();
    try {
      const { runner, ready } = gateRunner();
      const session = await spawnFresh(runner);
      const proc = getMockProc(runner, session.id);

      proc._emit("data", STARTING_STATUS_BAR);
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(400);
      expect(ready).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(200);
      expect(ready).toHaveLength(1);
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks ready via the flat 8s fallback when the PTY never produces output", async () => {
    vi.useFakeTimers();
    try {
      const { runner, ready } = gateRunner();
      const session = await spawnFresh(runner);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(ready).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(ready).toHaveLength(1);
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexPtyRunner — ready detection", () => {
  it("fires onReady and transitions to waiting_input when status bar contains Ready", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", READY_STATUS_BAR);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it("does NOT fire onReady on › alone without Ready in the status line", async () => {
    const ready: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onReady: (s) => ready.push(s) });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    proc._emit("data", STARTING_STATUS_BAR);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(0);
    expect(runner.getSession(session.id)?.status).toBe("running");
  });
});

describe("CodexPtyRunner — input queueing", () => {
  it("queues sendInput while pending-ready, then flushes in order once ready", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CodexPtyRunner();
      const session = await spawnFresh(runner);
      const proc = getMockProc(runner, session.id);

      const promptCount1 = runner.sendInput(session.id, "first");
      const promptCount2 = runner.sendInput(session.id, "second");
      expect(promptCount1).toBe(1);
      expect(promptCount2).toBe(2);
      expect(proc.write).not.toHaveBeenCalled();

      proc._emit("data", READY_STATUS_BAR);
      await vi.advanceTimersByTimeAsync(0);

      // First input's raw text lands immediately; its \r is deferred.
      expect(proc.write.mock.calls[0][0]).toBe("first");

      // Timeline: 0=first, 16ms=\r(first), 32ms=second, 48ms=\r(second).
      await vi.advanceTimersByTimeAsync(60);

      const writes = proc.write.mock.calls.map((c: any[]) => c[0]);
      expect(writes).toContain("first");
      expect(writes).toContain("second");
      // \r appears at least twice (once per submit).
      expect(writes.filter((w: string) => w === "\r").length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendInput after ready writes directly (not queued)", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CodexPtyRunner();
      const session = await spawnResume(runner);
      const proc = getMockProc(runner, session.id);

      proc._emit("data", READY_STATUS_BAR);
      await vi.advanceTimersByTimeAsync(0);
      proc.write.mockClear();

      runner.sendInput(session.id, "hello");
      expect(proc.write).toHaveBeenCalledWith("hello");
      expect(proc.write).not.toHaveBeenCalledWith("\r");

      await vi.advanceTimersByTimeAsync(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexPtyRunner — cancel / putOnHold", () => {
  it("cancel sends SIGINT", async () => {
    const runner = new CodexPtyRunner();
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    runner.cancel(session.id);
    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("putOnHold sends SIGINT and cleans up session state", async () => {
    const statusChanges: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(runner);
    const proc = getMockProc(runner, session.id);

    runner.putOnHold(session.id);

    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
    expect(runner.hasSession(session.id)).toBe(false);
    expect(statusChanges.some((s) => s.status === "idle")).toBe(true);
  });
});

describe("CodexPtyRunner — exit handling", () => {
  it("sets failureReason on instant non-zero exit with no output", async () => {
    const statusChanges: ManagedSession[] = [];
    const runner = new CodexPtyRunner({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(runner, "/tmp/test");
    const proc = getMockProc(runner, session.id);

    proc._emit("exit", { exitCode: 1 });

    const finalUpdate = statusChanges[statusChanges.length - 1];
    expect(finalUpdate.status).toBe("idle");
    expect(finalUpdate.failureReason).toBeTruthy();
    expect(runner.hasSession(session.id)).toBe(false);
  });
});
