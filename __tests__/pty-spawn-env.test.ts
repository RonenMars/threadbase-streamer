import { spawn as mockSpawn } from "node-pty";
import { PTYManager } from "../src/pty-manager";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    return {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

function lastSpawnEnv(): Record<string, string> {
  const calls = (mockSpawn as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][2].env;
}

describe("PTYManager — spawn env sanitization", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_API_KEY",
    "TERM",
  ];

  beforeEach(() => {
    for (const k of KEYS) SAVED[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("strips inherited Claude-session markers so spawned sessions persist JSONL", async () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "parent-session";
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

    const mgr = new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    const env = lastSpawnEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    // Unrelated env passes through.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("still maps CLAUDE_API_KEY to ANTHROPIC_API_KEY", async () => {
    process.env.CLAUDE_API_KEY = "sk-test-123";

    const mgr = new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    const env = lastSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-123");
    expect(env.CLAUDE_API_KEY).toBe("sk-test-123");
  });

  // Claude Code paints ASCII fallbacks (`>` for the composer prompt, `>` for the
  // gate cursor) when TERM is absent, which permanently defeats
  // CLAUDE_PROMPT_MARKERS and pins a session at `running`. A supervised streamer
  // inherits no TERM, and node-pty's `name` does not supply one through Windows
  // ConPTY, so the spawn has to.
  it("declares TERM so Claude Code renders its Unicode chrome, not ASCII fallbacks", async () => {
    delete process.env.TERM;

    const mgr = new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    expect(lastSpawnEnv().TERM).toBe("xterm-256color");
  });

  it("does not override a TERM the operator already set", async () => {
    process.env.TERM = "screen-256color";

    const mgr = new PTYManager({ onOutput: () => {}, onStatusChange: () => {} });
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });

    expect(lastSpawnEnv().TERM).toBe("screen-256color");
  });
});
