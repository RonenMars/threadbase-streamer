// A key sent through sendKeys to a `waiting_input` Claude session flips it to
// `running` (#1040). It has to open a turn the way a submit does:
//  - a key that starts nothing (an arrow, Esc) may produce no chunk at all, and
//    with the quiet check already spent only the start grace brings it back;
//  - a key that does start a turn (Enter) whose busy title is late gets settled
//    on the `❯` box, and only a recorded submit lets the late title reopen it.
//
// Replays the same raw capture of one real turn as turn-signal-replay.test.ts.
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
const TITLE = /\x1b\]0;([◐◓◑◒✳])/g;
const SUBMIT_IDX = CAP.chunks.findIndex(([ms]) => ms >= CAP.submitAt);
// First chunk after the submit whose title is the idle glyph: the turn's end.
const END_IDX = CAP.chunks.findIndex(
  ([, d], i) => i >= SUBMIT_IDX && [...d.matchAll(TITLE)].some((m) => m[1] === "✳"),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Claude session booted from the capture and settled at its first prompt. */
async function bootWaiting() {
  const changes: ManagedSession[] = [];
  const mgr = new PTYManager({ onStatusChange: (s) => changes.push({ ...s }) });
  const session = await mgr.startFresh({ projectPath: "/tmp", projectName: "proj" });
  const proc = (mgr as any).sessions.get(session.id).process;
  const emit = (from: number, to: number) => {
    for (const [, d] of CAP.chunks.slice(from, to)) proc._emit("data", d);
  };
  emit(0, SUBMIT_IDX);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), { timeout: 2_000 });
  changes.length = 0;
  return { mgr, id: session.id, changes, emit };
}

describe("Claude sendKeys on a waiting_input session", () => {
  it("a key that starts no turn returns to waiting_input without a signalled end", async () => {
    const { mgr, id, changes } = await bootWaiting();
    // Past QUIET_DETECT_MS: the screen has been still, as it is when a user
    // presses a key at an idle prompt, so no quiet check is left pending.
    await sleep(700);
    expect(changes).toEqual([]);

    // An arrow key is not a submit: no busy title, and here no chunk at all.
    mgr.sendKeys(id, "\x1b[A");
    expect(changes.map((c) => c.status)).toEqual(["running"]);
    // Past TURN_START_GRACE_MS.
    await sleep(3_600);
    expect(changes.map((c) => [c.status, c.statusSource])).toEqual([
      ["running", "user-input"],
      // Not "turn-signal": WaitingInputNotifier sends no "finished" for it.
      ["waiting_input", "screen-marker"],
    ]);
    mgr.dispose();
  }, 15_000);

  it("a key that starts a turn stays running and ends on the turn signal", async () => {
    const { mgr, id, changes, emit } = await bootWaiting();

    mgr.sendKeys(id, "\r");
    await sleep(50);
    emit(SUBMIT_IDX, END_IDX);
    await sleep(2_600);
    expect(changes.map((c) => c.status)).toEqual(["running"]);

    emit(END_IDX, CAP.chunks.length);
    await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
      timeout: 3_000,
    });
    expect(changes.at(-1)?.statusSource).toBe("turn-signal");
    mgr.dispose();
  }, 15_000);

  it("a key-started turn whose busy title is late is reopened and still ends on the signal", async () => {
    const { mgr, id, changes, emit } = await bootWaiting();

    mgr.sendKeys(id, "\r");
    // The busy title held back past the quiet check and the start grace.
    await sleep(3_600);
    expect(changes.map((c) => c.status)).toEqual(["running", "waiting_input"]);
    expect(changes.at(-1)?.statusSource).not.toBe("turn-signal");

    emit(SUBMIT_IDX, END_IDX);
    await sleep(600);
    expect(changes.at(-1)?.status).toBe("running");

    emit(END_IDX, CAP.chunks.length);
    await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
      timeout: 3_000,
    });
    expect(changes.at(-1)?.statusSource).toBe("turn-signal");
    mgr.dispose();
  }, 15_000);
});
