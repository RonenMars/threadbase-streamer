import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { spawn as mockSpawn } from "node-pty";
import { join } from "path";
import { CursorPtyRunner } from "../src/cursor-pty-runner";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 54321,
      onData: (cb: (data: string) => void) => ee.on("data", cb),
      onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// Raw PTY capture of a real Cursor Agent 2026.09.23 boot + turn, verbatim:
// `{ submitAt, chunks: [[msSinceSpawn, data]] }`. Only the boot is used here:
// the first burst of output (~150ms); the next chunk, 16s later, is the echo.
const CURSOR_TURN: { submitAt: number; chunks: [number, string][] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "turn-signals", "cursor-2026.09.23-turn.json"), "utf8"),
);
const BOOT = CURSOR_TURN.chunks.filter(([ms]) => ms < CURSOR_TURN.chunks[0][0] + 1_000);
const BOOT_MARKER = "\x1b[?2004h";
// Cursor's repaint of the typed prompt, the first chunk after the boot.
const ECHO = CURSOR_TURN.chunks[BOOT.length][1];
// The same Cursor fed Ctrl+U, the text, then \r 17ms later — before its echo.
// `{ variant, writes: [[ms, data]], chunks: [[ms, data]] }`, verbatim.
const FAST_SUBMIT: { writes: [number, string][]; chunks: [number, string][] } = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "turn-signals", "cursor-2026.09.23-fast-submit.json"),
    "utf8",
  ),
);
const BUSY = "ctrl+c to stop";

function emitBoot(proc: { _emit: (event: string, data: string) => boolean }): void {
  for (const [, d] of BOOT) proc._emit("data", d);
}

function spawnArgs(): string[] {
  const calls = (mockSpawn as any).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

function getMockProc(
  runner: CursorPtyRunner,
  sessionId: string,
): {
  write: ReturnType<typeof vi.fn>;
  _emit: (event: string, data: string) => boolean;
} {
  const session = (runner as any).sessions.get(sessionId);
  return session.process;
}

describe("CursorPtyRunner — spawn args", () => {
  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns agent --workspace --trust with no session id", async () => {
    const runner = new CursorPtyRunner();
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });

    expect(session.provider).toBe("cursor");
    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust"]);
  });

  it("startFresh appends systemPrompt as the trailing positional prompt", async () => {
    const runner = new CursorPtyRunner();
    await runner.startFresh({
      projectPath: "/tmp/proj",
      projectName: "test",
      systemPrompt: "stay in the sandbox",
    });

    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust", "stay in the sandbox"]);
  });

  it("start (resume) passes --resume=<id> and keeps the session id", async () => {
    const runner = new CursorPtyRunner();
    const session = await runner.start("placeholder-uuid", {
      projectPath: "/tmp/proj",
      projectName: "test",
      resumeId: "chat-id",
    });

    expect(spawnArgs()).toEqual(["--workspace", "/tmp/proj", "--trust", "--resume=chat-id"]);
    expect(session.id).toBe("placeholder-uuid");
  });
});

describe("CursorPtyRunner — sendInput clears compose before write", () => {
  it("pins: a \\r that beats the echo runs the turn but never shows the busy hint", () => {
    const submitAt = FAST_SUBMIT.writes.find(([, d]) => d === "\r")?.[0] ?? 0;
    const after = FAST_SUBMIT.chunks.filter(([ms]) => ms >= submitAt).map(([, d]) => d);
    // Nothing was painted between the text and the \r...
    expect(FAST_SUBMIT.chunks.some(([ms]) => ms > FAST_SUBMIT.writes[0][0] && ms < submitAt)).toBe(
      false,
    );
    // ...and the turn ran, but with the prompt still in the compose box.
    expect(after.some((d) => d.includes("Working"))).toBe(true);
    expect(after.some((d) => d.includes(BUSY))).toBe(false);
    expect(CURSOR_TURN.chunks.some(([, d]) => d.includes(BUSY))).toBe(true);
  });

  it("writes Ctrl+U on its own, then the text, then \\r once Cursor has echoed it", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);
      const writes = () => proc.write.mock.calls.map((c: unknown[]) => c[0]);

      // Settle boot so sendInput is not queued.
      emitBoot(proc);
      await vi.advanceTimersByTimeAsync(600);
      proc.write.mockClear();

      // Cursor discards a read that starts with Ctrl+U and carries more bytes:
      // "\x15" + text in one write never reached the compose box.
      runner.sendInput(session.id, "Yes, commit it");
      expect(writes()).toEqual(["\x15"]);

      await vi.advanceTimersByTimeAsync(20);
      expect(writes()).toEqual(["\x15", "Yes, commit it"]);

      // No echo yet: the PTY being quiet is not enough.
      await vi.advanceTimersByTimeAsync(100);
      expect(writes()).toEqual(["\x15", "Yes, commit it"]);

      proc._emit("data", ECHO);
      await vi.advanceTimersByTimeAsync(40);
      expect(writes()).toEqual(["\x15", "Yes, commit it", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes queued turns one at a time, each cleared first", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);

      runner.sendInput(session.id, "Commit it");
      runner.sendInput(session.id, "Yes, commit it");
      expect(proc.write).not.toHaveBeenCalled();

      // No echo, so each \r waits out CURSOR_SUBMIT_MAX_WAIT_MS; the second
      // turn must still not start before the first one's \r.
      emitBoot(proc);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(proc.write.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        "\x15",
        "Commit it",
        "\r",
        "\x15",
        "Yes, commit it",
        "\r",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CursorPtyRunner — boot readiness waits for the compose box", () => {
  it("pins: Cursor is silent past the 8s fallback, then paints the boot marker", () => {
    // What the fix relies on: the old flat 8s fallback fired before Cursor's
    // first byte, flushing queued input into a cooked-mode tty that ate the \r.
    expect(BOOT[0][0]).toBeGreaterThan(8_000);
    expect(BOOT.some(([, d]) => d.includes(BOOT_MARKER))).toBe(true);
  });

  it("holds queued input until the captured boot paints, on its real timeline", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);
      runner.sendInput(session.id, "hi");

      let t = 0;
      for (const [ms, d] of BOOT) {
        await vi.advanceTimersByTimeAsync(ms - t);
        t = ms;
        expect(proc.write).not.toHaveBeenCalled();
        expect(runner.getSession(session.id)?.status).toBe("running");
        proc._emit("data", d);
      }
      // Quiet boot (500ms), then the \r's wait for an echo the mock never sends.
      await vi.advanceTimersByTimeAsync(1_200);

      expect(proc.write.mock.calls.map((c: unknown[]) => c[0])).toEqual(["\x15", "hi", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a boot that never paints the marker, but only at the backstop", async () => {
    vi.useFakeTimers();
    try {
      const runner = new CursorPtyRunner();
      const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
      const proc = getMockProc(runner, session.id);
      proc._emit("data", "no marker here\r\n");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(runner.getSession(session.id)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(40_000);
      expect(runner.getSession(session.id)?.status).toBe("waiting_input");
    } finally {
      vi.useRealTimers();
    }
  });
});
