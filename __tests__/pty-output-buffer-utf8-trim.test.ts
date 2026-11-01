import { EventEmitter } from "events";
import { spawn } from "node-pty";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { CopilotPtyRunner } from "../src/copilot-pty-runner";
import { CursorPtyRunner } from "../src/cursor-pty-runner";
import { PTYManager } from "../src/pty-manager";
import { trimOutputBuffer } from "../src/pty-shared";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const events = new EventEmitter();
    return {
      pid: 54321,
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      onData: (cb: (s: string) => void) => events.on("data", cb),
      onExit: (cb: (s: { exitCode: number }) => void) => events.on("exit", cb),
      emit: events.emit.bind(events),
    };
  }),
}));
vi.mock("../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform")>()),
  resolveCopilotExe: () => "/bin/copilot",
}));

const MAX = 65536;
// "─" is 3 bytes in UTF-8 (E2 94 80). 65536 is not a multiple of 3, so a raw
// cut of an all-"─" buffer always lands inside a character.
const BOX = "─";

describe("trimOutputBuffer", () => {
  it("returns a buffer at or under the cap untouched", () => {
    const buf = Buffer.from(BOX.repeat(10));
    expect(trimOutputBuffer(buf, 30)).toBe(buf);
  });

  it("drops the orphaned continuation bytes when the cut lands inside a character", () => {
    const buf = Buffer.from(BOX.repeat(100)); // 300 bytes
    for (const max of [200, 199, 198]) {
      const out = trimOutputBuffer(buf, max).toString("utf-8");
      expect(out).not.toContain("�");
      expect(out).toBe(BOX.repeat(out.length));
    }
  });

  it("keeps the cap when the cut already lands on a character boundary", () => {
    const buf = Buffer.from(BOX.repeat(100));
    expect(trimOutputBuffer(buf, 150)).toHaveLength(150);
  });
});

// Every runner keeps its own copy of the 64KB ring; each must trim on a
// character boundary, so each is driven through getOutput().
describe("PTY output ring trim keeps UTF-8 intact", () => {
  const overflow = BOX.repeat(Math.ceil((MAX + 100) / 3));

  const runners = [
    ["claude", () => new PTYManager()],
    ["codex", () => new CodexPtyRunner()],
    ["cursor", () => new CursorPtyRunner()],
    ["copilot", () => new CopilotPtyRunner()],
  ] as const;

  it.each(runners)("%s runner", async (_name, make) => {
    const runner = make();
    const session = await runner.startFresh({ projectPath: "/tmp/proj", projectName: "test" });
    const proc = vi.mocked(spawn).mock.results.at(-1)?.value;
    proc.emit("data", overflow);
    const out = runner.getOutput(session.id);
    expect(out).not.toContain("�");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX);
    expect(Buffer.byteLength(out)).toBeGreaterThan(MAX - 3);
    runner.dispose();
  });
});
