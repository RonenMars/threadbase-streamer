// A prompt sent while a session is still booting is queued and written once
// boot settles (#1041). That flush used to write the prompt without flipping
// the session to `running` or opening a turn, so the whole first turn was
// reported `waiting_input` and its end never carried `statusSource:
// "turn-signal"`, the only source that sends the "finished" push.
//
// Each runner replays a raw capture of one real turn (see
// turn-signal-replay.test.ts for the fixture format), with the prompt sent
// before the first boot chunk instead of after boot.
import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import { CodexPtyRunner } from "../src/codex-pty-runner";
import { CursorPtyRunner } from "../src/cursor-pty-runner";
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

interface Capture {
  submitAt: number;
  chunks: [number, string][];
}

const load = (name: string): Capture =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "turn-signals", name), "utf8"));

const CLAUDE_TURN = load("claude-2.1.280-turn.json");
const CODEX_TURN = load("codex-0.156.1-turn.json");
const CURSOR_TURN = load("cursor-2026.09.23-turn.json");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
const CLAUDE_TITLE = /\x1b\]0;([◐◓◑◒✳])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
const CODEX_TITLE = /\x1b\]0;([^\x07]*)\x07/g;
const CODEX_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const CURSOR_BUSY = "ctrl+c to stop";

/** Index of the first post-submit chunk whose title reads idle. */
function firstIdleTitleChunk(cap: Capture, re: RegExp, isBusy: (t: string) => boolean) {
  const from = cap.chunks.findIndex(([ms]) => ms >= cap.submitAt);
  return cap.chunks.findIndex(
    ([, d], i) => i >= from && [...d.matchAll(re)].some((m) => !isBusy(m[1])),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Runner = {
  startFresh(o: { projectPath: string; projectName: string }): Promise<ManagedSession>;
  sendInput(id: string, input: string): number;
  dispose(): void;
};

async function replayBootQueuedTurn(
  make: (onStatusChange: (s: ManagedSession) => void) => Runner,
  cap: Capture,
  endIdx: number,
  bootSettleMs: number,
) {
  const changes: ManagedSession[] = [];
  const runner = make((s) => changes.push({ ...s }));
  const session = await runner.startFresh({ projectPath: "/tmp", projectName: "proj" });
  const proc = (runner as any).sessions.get(session.id).process;
  const emit = (from: number, to: number) => {
    for (const [, d] of cap.chunks.slice(from, to)) proc._emit("data", d);
  };
  const submitIdx = cap.chunks.findIndex(([ms]) => ms >= cap.submitAt);

  // Sent before any output: the session is still booting, so this is queued.
  runner.sendInput(session.id, "prompt");
  const queued = proc.write.mock.calls.length;

  emit(0, submitIdx);
  await vi.waitFor(() => expect(changes.some((c) => c.status === "waiting_input")).toBe(true), {
    timeout: bootSettleMs,
  });
  // The flush runs inside the boot settle; give its status change a tick.
  await sleep(50);
  const afterFlush = changes.at(-1);
  const flushed = proc.write.mock.calls.length;

  emit(submitIdx, endIdx);
  // Past every early settle: the ❯ marker, the 500ms quiet check, the 2s
  // submit-stale and the 3s start grace.
  await sleep(3_600);
  const midTurn = changes.at(-1);

  changes.length = 0;
  emit(endIdx, cap.chunks.length);
  await sleep(3_000);
  runner.dispose();
  return { queued, flushed, afterFlush, midTurn, end: changes.at(-1) };
}

function expectTurnReported(r: Awaited<ReturnType<typeof replayBootQueuedTurn>>) {
  // Positive controls: nothing reached the PTY while queued, and the flush wrote.
  expect.soft(r.queued).toBe(0);
  expect.soft(r.flushed).toBeGreaterThan(0);
  expect
    .soft([r.afterFlush?.status, r.afterFlush?.statusSource])
    .toEqual(["running", "user-input"]);
  expect.soft(r.midTurn?.status).toBe("running");
  expect.soft([r.end?.status, r.end?.statusSource]).toEqual(["waiting_input", "turn-signal"]);
}

describe("a prompt queued during boot runs as a turn", () => {
  it("Claude", async () => {
    const end = firstIdleTitleChunk(CLAUDE_TURN, CLAUDE_TITLE, (g) => g !== "✳");
    expect(end).toBeGreaterThan(0);
    const r = await replayBootQueuedTurn(
      (onStatusChange) => new PTYManager({ onStatusChange }),
      CLAUDE_TURN,
      end,
      2_000,
    );
    expectTurnReported(r);
  }, 20_000);

  it("Codex", async () => {
    const end = firstIdleTitleChunk(CODEX_TURN, CODEX_TITLE, (t) => CODEX_SPINNER.test(t));
    expect(end).toBeGreaterThan(0);
    const r = await replayBootQueuedTurn(
      (onStatusChange) => new CodexPtyRunner({ onStatusChange }),
      CODEX_TURN,
      end,
      // Replayed in one burst, boot settles on the 8s fallback (see
      // turn-signal-replay.test.ts).
      10_000,
    );
    expectTurnReported(r);
  }, 30_000);

  it("Cursor", async () => {
    const last = CURSOR_TURN.chunks.findLastIndex(([, d]) => d.includes(CURSOR_BUSY));
    expect(last).toBeGreaterThan(0);
    const r = await replayBootQueuedTurn(
      (onStatusChange) => new CursorPtyRunner({ onStatusChange }),
      CURSOR_TURN,
      last + 1,
      3_000,
    );
    expectTurnReported(r);
  }, 20_000);
});
