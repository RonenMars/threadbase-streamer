// An Enter that lands while Claude Code is still attaching an `@<image path>`
// mention is swallowed: the prompt stays in the input box and no turn starts
// (reproduced on Claude Code 2.1.329 with the \r 20-300 ms after the paste).
// The streamer sends the Enter once more when the first one started no turn
// and the prompt is still sitting in the composer.
import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";
import type { ManagedSession } from "../src/types";

vi.mock("node-pty", () => {
  function makeMockProcess() {
    const ee = new EventEmitter();
    return {
      pid: 12345,
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

const CAP: { submitAt: number; chunks: [number, string][] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "turn-signals", "claude-2.1.280-turn.json"), "utf8"),
);
const SUBMIT_IDX = CAP.chunks.findIndex(([ms]) => ms >= CAP.submitAt);
const PROMPT = "see that screenshot: @/tmp/shot@2x.png";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootWaiting() {
  const changes: ManagedSession[] = [];
  const mgr = new PTYManager({ onStatusChange: (s) => changes.push({ ...s }) });
  const session = await mgr.startFresh({ projectPath: "/tmp", projectName: "proj" });
  const proc = (mgr as any).sessions.get(session.id).process;
  for (const [, d] of CAP.chunks.slice(0, SUBMIT_IDX)) proc._emit("data", d);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), { timeout: 2_000 });
  await sleep(700);
  proc.write.mockClear();
  return { mgr, id: session.id, proc };
}

const enters = (proc: { write: { mock: { calls: unknown[][] } } }) =>
  proc.write.mock.calls.filter(([b]) => b === "\r").length;

// Claude repaints the composer with the prompt still in it.
const paintComposer = (text: string) =>
  `\x1b[2J\x1b[H${"─".repeat(40)}\r\n❯ ${text}\r\n${"─".repeat(40)}`;

describe("Claude submit retry", () => {
  it("sends Enter again when the first started no turn and the prompt is still in the box", async () => {
    const { mgr, id, proc } = await bootWaiting();
    mgr.sendInput(id, PROMPT);
    proc._emit("data", paintComposer(PROMPT));
    await vi.waitFor(() => expect(enters(proc)).toBe(1), { timeout: 1_000 });
    await vi.waitFor(() => expect(enters(proc)).toBe(2), { timeout: 3_000 });
    await sleep(2_000);
    expect(enters(proc)).toBe(2);
    mgr.dispose();
  }, 15_000);

  it("does not resend when the turn started", async () => {
    const { mgr, id, proc } = await bootWaiting();
    mgr.sendInput(id, PROMPT);
    proc._emit("data", paintComposer(PROMPT));
    await vi.waitFor(() => expect(enters(proc)).toBe(1), { timeout: 1_000 });
    proc._emit("data", "\x1b]0;◐ Claude Code\x07");
    await sleep(2_500);
    expect(enters(proc)).toBe(1);
    mgr.dispose();
  }, 15_000);

  it("does not resend when the prompt is no longer in the box", async () => {
    const { mgr, id, proc } = await bootWaiting();
    mgr.sendInput(id, "/model");
    proc._emit("data", paintComposer(""));
    await vi.waitFor(() => expect(enters(proc)).toBe(1), { timeout: 1_000 });
    await sleep(2_500);
    expect(enters(proc)).toBe(1);
    mgr.dispose();
  }, 15_000);
});
