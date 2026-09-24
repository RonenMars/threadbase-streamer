// Each provider's turn end, replayed from a raw PTY capture of one real turn
// (#962). Before this, all three settled `waiting_input` within ~2s of the
// submit — the `❯` box (Claude) or submit-stale (Codex, Cursor) — and the
// "finished" push fired as the agent started. The turn must now stay `running`
// until the provider itself signals the end, and that end must carry
// `statusSource: "turn-signal"`, the only source WaitingInputNotifier pushes on.
//
// Fixtures are the capture files verbatim: `{ submitAt, chunks: [[ms, data]] }`,
// ms since spawn, recorded under a launchd-like env (no TERM_PROGRAM) at the
// runners' 120x40. The "pins" block asserts the property each runner relies on,
// so a recapture that loses it fails there rather than as an inert test.
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
const CLAUDE_GATE = load("claude-2.1.280-gate.json");
const CODEX_TURN = load("codex-0.156.1-turn.json");
const CURSOR_TURN = load("cursor-2026.09.23-turn.json");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
const CLAUDE_TITLE = /\x1b\]0;([◐◓◑◒✳])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal OSC escapes
const CODEX_TITLE = /\x1b\]0;([^\x07]*)\x07/g;
const CODEX_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const CURSOR_BUSY = "ctrl+c to stop";

/** Index of the first chunk at or after `from` whose title state is `busy`. */
function firstTitleChunk(cap: Capture, re: RegExp, isBusy: (t: string) => boolean, busy: boolean) {
  const from = cap.chunks.findIndex(([ms]) => ms >= cap.submitAt);
  return cap.chunks.findIndex(
    ([, d], i) => i >= from && [...d.matchAll(re)].some((m) => isBusy(m[1]) === busy),
  );
}

const claudeBusy = (g: string) => g !== "✳";
const codexBusy = (t: string) => CODEX_SPINNER.test(t);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("turn-signal fixtures (pins)", () => {
  it("Claude 2.1.280 paints the title spinner for the turn and never emits OSC 9;4", () => {
    for (const cap of [CLAUDE_TURN, CLAUDE_GATE]) {
      const all = cap.chunks.map(([, d]) => d).join("");
      expect(all).not.toContain("\x1b]9;4;");
      const start = firstTitleChunk(cap, CLAUDE_TITLE, claudeBusy, true);
      const end = firstTitleChunk(cap, CLAUDE_TITLE, claudeBusy, false);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // The ❯ box is on screen through the whole turn — what used to settle it.
      expect(cap.chunks.slice(start, end).some(([, d]) => d.includes("❯"))).toBe(true);
    }
    // The gate capture's idle title is the gate, not the end of the turn.
    const gateEnd = firstTitleChunk(CLAUDE_GATE, CLAUDE_TITLE, claudeBusy, false);
    const after = CLAUDE_GATE.chunks
      .slice(gateEnd)
      .map(([, d]) => d)
      .join("");
    // Painted word by word with cursor moves, so match single words.
    expect(after).toContain("proceed?");
    expect(after).toContain("Esc to cancel");
  });

  it("Codex 0.156.1 spins its title for the turn and has no Working/Ready status bar", () => {
    const start = firstTitleChunk(CODEX_TURN, CODEX_TITLE, codexBusy, true);
    const end = firstTitleChunk(CODEX_TURN, CODEX_TITLE, codexBusy, false);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // No idle title between the turn's first spinner and its end.
    const mid = CODEX_TURN.chunks
      .slice(start, end)
      .flatMap(([, d]) => [...d.matchAll(CODEX_TITLE)]);
    expect(mid.every((m) => codexBusy(m[1]))).toBe(true);
    expect(CODEX_TURN.chunks[end][0] - CODEX_TURN.submitAt).toBeGreaterThan(2_000);
  });

  it("Cursor 2026.09.23 shows its busy hint for the turn and drops it at the end", () => {
    const idx = CURSOR_TURN.chunks
      .map(([ms, d], i) => [ms, d, i] as const)
      .filter(([ms, d]) => ms >= CURSOR_TURN.submitAt && d.includes(CURSOR_BUSY));
    expect(idx.length).toBeGreaterThan(10);
    const last = idx.at(-1)?.[2] ?? -1;
    expect(CURSOR_TURN.chunks[last][0] - CURSOR_TURN.submitAt).toBeGreaterThan(2_000);
    expect(CURSOR_TURN.chunks.slice(last + 1).some(([, d]) => d.includes(CURSOR_BUSY))).toBe(false);
  });
});

type Runner = {
  startFresh(o: { projectPath: string; projectName: string }): Promise<ManagedSession>;
  sendInput(id: string, input: string): number;
  dispose(): void;
};

async function replayTurn(
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

  emit(0, submitIdx);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
    timeout: bootSettleMs,
  });
  changes.length = 0;

  runner.sendInput(session.id, "prompt");
  await sleep(50);
  emit(submitIdx, endIdx);
  // Past every early settle the runners used to take: the ❯ marker, the 500ms
  // quiet check and the 2s submit-stale.
  await sleep(2_600);
  const midTurn = changes.map((c) => c.status);

  emit(endIdx, cap.chunks.length);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
    timeout: 3_000,
  });
  runner.dispose();
  return { midTurn, end: changes.at(-1) };
}

describe("turn end follows the provider's own signal", () => {
  it("Claude: stays running through the turn, settles on the idle title", async () => {
    const end = firstTitleChunk(CLAUDE_TURN, CLAUDE_TITLE, claudeBusy, false);
    const r = await replayTurn(
      (onStatusChange) => new PTYManager({ onStatusChange }),
      CLAUDE_TURN,
      end,
      2_000,
    );
    expect(r.midTurn).toEqual(["running"]);
    expect(r.end?.statusSource).toBe("turn-signal");
  }, 15_000);

  it("Claude: a permission gate keeps the turn open", async () => {
    const changes: ManagedSession[] = [];
    const mgr = new PTYManager({ onStatusChange: (s) => changes.push({ ...s }) });
    const session = await mgr.startFresh({ projectPath: "/tmp", projectName: "proj" });
    const proc = (mgr as any).sessions.get(session.id).process;
    const submitIdx = CLAUDE_GATE.chunks.findIndex(([ms]) => ms >= CLAUDE_GATE.submitAt);
    for (const [, d] of CLAUDE_GATE.chunks.slice(0, submitIdx)) proc._emit("data", d);
    await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"));
    changes.length = 0;

    mgr.sendInput(session.id, "prompt");
    await sleep(50);
    for (const [, d] of CLAUDE_GATE.chunks.slice(submitIdx)) proc._emit("data", d);
    await sleep(3_600);
    expect(changes.map((c) => c.status)).toEqual(["running"]);
    mgr.dispose();
  }, 15_000);

  it("Codex: stays running through the turn, settles when the title spinner stops", async () => {
    const end = firstTitleChunk(CODEX_TURN, CODEX_TITLE, codexBusy, false);
    const r = await replayTurn(
      (onStatusChange) => new CodexPtyRunner({ onStatusChange }),
      CODEX_TURN,
      end,
      // Replayed in one burst, every screen read sees the final boot screen,
      // whose status bar has truncated Ready away — so boot settles on the 8s
      // fallback rather than the marker.
      10_000,
    );
    expect(r.midTurn).toEqual(["running"]);
    expect(r.end?.statusSource).toBe("turn-signal");
  }, 20_000);

  it("Cursor: stays running through the turn, settles when the busy hint leaves", async () => {
    const last = CURSOR_TURN.chunks.findLastIndex(([, d]) => d.includes(CURSOR_BUSY));
    const r = await replayTurn(
      (onStatusChange) => new CursorPtyRunner({ onStatusChange }),
      CURSOR_TURN,
      last + 1,
      3_000,
    );
    expect(r.midTurn).toEqual(["running"]);
    expect(r.end?.statusSource).toBe("turn-signal");
  }, 15_000);
});

// Under load the busy signal can arrive after the runner has already settled
// the turn on a guess — Claude's start grace lapsing onto the `❯` marker,
// Codex's submit-stale. Replay the same turn with its busy signal held back past
// that point: the session must go back to `running` and still end on the
// provider's own signal, or the turn is never reported finished.
async function replayLateTurn(
  make: (onStatusChange: (s: ManagedSession) => void) => Runner,
  cap: Capture,
  startIdx: number,
  endIdx: number,
  bootSettleMs: number,
  holdMs: number,
) {
  const changes: ManagedSession[] = [];
  const runner = make((s) => changes.push({ ...s }));
  const session = await runner.startFresh({ projectPath: "/tmp", projectName: "proj" });
  const proc = (runner as any).sessions.get(session.id).process;
  const emit = (from: number, to: number) => {
    for (const [, d] of cap.chunks.slice(from, to)) proc._emit("data", d);
  };
  const submitIdx = cap.chunks.findIndex(([ms]) => ms >= cap.submitAt);

  emit(0, submitIdx);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
    timeout: bootSettleMs,
  });
  changes.length = 0;

  runner.sendInput(session.id, "prompt");
  await sleep(50);
  emit(submitIdx, startIdx);
  await sleep(holdMs);
  const guessed = changes.map((c) => [c.status, c.statusSource]);

  emit(startIdx, endIdx);
  await sleep(600);
  const resumed = changes.at(-1)?.status;

  emit(endIdx, cap.chunks.length);
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("waiting_input"), {
    timeout: 3_000,
  });
  runner.dispose();
  return { guessed, resumed, end: changes.at(-1) };
}

describe("a turn that starts after it was settled on a guess", () => {
  it("Claude: a busy title after the start grace lapsed reopens the turn", async () => {
    const start = firstTitleChunk(CLAUDE_TURN, CLAUDE_TITLE, claudeBusy, true);
    const end = firstTitleChunk(CLAUDE_TURN, CLAUDE_TITLE, claudeBusy, false);
    const r = await replayLateTurn(
      (onStatusChange) => new PTYManager({ onStatusChange }),
      CLAUDE_TURN,
      start,
      end,
      2_000,
      3_600,
    );
    expect(r.guessed).toEqual([
      ["running", "user-input"],
      ["waiting_input", "screen-marker"],
    ]);
    expect(r.resumed).toBe("running");
    expect(r.end?.statusSource).toBe("turn-signal");
  }, 20_000);

  it("Codex: a title spinner after submit-stale reopens the turn", async () => {
    const start = firstTitleChunk(CODEX_TURN, CODEX_TITLE, codexBusy, true);
    const end = firstTitleChunk(CODEX_TURN, CODEX_TITLE, codexBusy, false);
    const r = await replayLateTurn(
      (onStatusChange) => new CodexPtyRunner({ onStatusChange }),
      CODEX_TURN,
      start,
      end,
      10_000,
      2_600,
    );
    expect(r.guessed).toEqual([
      ["running", "user-input"],
      ["waiting_input", "quiet-fallback"],
    ]);
    expect(r.resumed).toBe("running");
    expect(r.end?.statusSource).toBe("turn-signal");
  }, 25_000);
});
