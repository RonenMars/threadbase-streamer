import { EventEmitter } from "events";
import { PTYManager } from "../src/pty-manager";
import type { PermissionOption } from "../src/services/questions/detectPermissionGate";

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

type Gate = { prompt?: string; options: PermissionOption[]; cursor?: number } | null;

function getMockProc(
  mgr: PTYManager,
  sessionId: string,
): { _emit: (e: string, d: string) => void } {
  const m = mgr as any;
  return m.sessions.get(sessionId).process;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

// Full gate paint as one chunk — box, prompt, options, gate footer. This is
// the regression test for the whole feature: NO OSC anywhere in the stream.
const GATE_PAINT = [
  "╭────────────────────────────────────────────────────╮",
  "│ Bash command                                       │",
  "│   /opt/homebrew/bin/git reflog -8                  │",
  "│ This command requires approval                     │",
  "│                                                    │",
  "│ Do you want to proceed?                            │",
  "│ ❯ 1. Yes                                           │",
  "│   2. Yes, and don't ask again for: git reflog *    │",
  "│   3. No                                            │",
  "│                                                    │",
  "│ Esc to cancel · Tab to amend · ctrl+e to explain   │",
  "╰────────────────────────────────────────────────────╯",
].join("\r\n");

describe("PTYManager — paint-time gate detection (no OSC)", () => {
  it("broadcasts the gate from the paint alone", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", GATE_PAINT);
    await settle();

    const gate = gates.find((g) => g && g.options.length === 3);
    expect(gate).toBeTruthy();
    expect(gate?.options.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(gate?.cursor).toBe(1);
    expect(gate?.prompt).toBe("Do you want to proceed?");
    mgr.dispose();
  });

  it("still closes via the waiting-for-input OSC after a paint-time open", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", GATE_PAINT);
    await settle();
    expect(gates.some((g) => g && g.options.length === 3)).toBe(true);

    proc._emit(
      "data",
      "\x1b[2J\x1b[H\x1b]777;notify;Claude Code;Claude is waiting for your input\x07",
    );
    await settle();

    expect(gates[gates.length - 1]).toBeNull();
    mgr.dispose();
  });

  it("throttles unsolicited scrapes: a second trigger-less chunk inside the window scrapes nothing", async () => {
    const mgr = new PTYManager({ onPermissionChange: () => {} });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);
    // Detection passes call getOutputLines(sessionId, 60); the quiet checker's
    // ready recheck uses maxLines 40 — filter by the 60 to count passes only.
    const spy = vi.spyOn(mgr, "getOutputLines");
    const passes = () => spy.mock.calls.filter((c) => c[1] === 60).length;

    proc._emit("data", "plain output with no prompt\r\n");
    await settle();
    expect(passes()).toBe(1); // throttle was due (first pass) — chunk alone scraped

    proc._emit("data", "more plain output\r\n");
    await settle();
    expect(passes()).toBe(1); // inside the window, no trigger — early return

    await new Promise((r) => setTimeout(r, 310));
    proc._emit("data", "later plain output\r\n");
    await settle();
    expect(passes()).toBe(2); // window elapsed — chunk alone scrapes again
    mgr.dispose();
  });

  it("throttled trigger-less scrapes stay silent on numbered-list prose, but a real gate paint still broadcasts", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // Ordinary Claude prose ending near a numbered list, no OSC and no
    // gate/AskUserQuestion footer — detectShellPrompt's own guard requires a
    // numbered block to reach the true screen tail, and trailing prose here
    // defeats that on every pass. Two chunks >300ms apart so the throttle
    // window actually reopens and the fallback runs more than once.
    proc._emit(
      "data",
      [
        "The session lifecycle has three live statuses:",
        "",
        "1. running — actively producing output",
        "2. waiting_input — Claude printed a prompt marker",
        "3. idle — no live PTY",
        "",
        "Historical conversations come back as resumable stubs, and mobile treats idle and on_hold the same way.",
      ].join("\r\n"),
    );
    await settle();
    expect(gates).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 310));

    // Bland follow-up with none of the cheap trigger patterns — this pass
    // only runs because the throttle window elapsed (scrapeDue), which is
    // exactly the newly-widened path the finding is about.
    proc._emit("data", "Let me check whether the cache needs a migration before we continue.\r\n");
    await settle();
    expect(gates).toHaveLength(0);

    // Positive control — same manager/session — proves the harness CAN
    // broadcast: a real gate paint once the throttle window reopens again.
    await new Promise((r) => setTimeout(r, 310));
    proc._emit("data", GATE_PAINT);
    await settle();
    const gate = gates.find((g) => g && g.options.length === 3);
    expect(gate).toBeTruthy();
    mgr.dispose();
  });
});
