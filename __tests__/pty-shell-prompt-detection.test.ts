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

async function spawnFresh(mgr: PTYManager) {
  return mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
}

// detectLivePrompts runs async (awaits getOutputLines). Give the microtask +
// xterm write-callback a tick to settle after emitting a chunk.
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("PTYManager — unstructured shell prompt → permission event", () => {
  it("broadcasts a y/N prompt as a permission gate with literal answer keys", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", "Running script...\r\nContinue? [y/N] ");
    await settle();

    const gate = gates.find((g) => g && g.options.length === 2);
    expect(gate).toBeTruthy();
    expect(gate?.prompt).toBe("Continue? [y/N]");
    expect(gate?.options).toEqual([
      { index: 1, label: "Yes", answerKeys: "y\r" },
      { index: 2, label: "No", answerKeys: "n\r" },
    ]);
    mgr.dispose();
  });

  it("does not re-broadcast the same prompt on a repaint (de-dupe by content)", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    // A real TUI repaint clears + redraws the same screen position, so the
    // rendered tail is identical across both chunks → de-duped to one broadcast.
    proc._emit("data", "\x1b[2J\x1b[HContinue? [y/N] ");
    await settle();
    proc._emit("data", "\x1b[2J\x1b[HContinue? [y/N] ");
    await settle();

    expect(gates.filter((g) => g && g.options.length === 2)).toHaveLength(1);
    mgr.dispose();
  });

  it("clears the card (permission null) once Claude's prompt marker returns", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", "Continue? [y/N] ");
    await settle();
    expect(gates.some((g) => g && g.options.length === 2)).toBe(true);

    // Bash command finished, the shell scrolled, Claude repainted its ❯ prompt.
    proc._emit("data", "\x1b[2J\x1b[H❯ ");
    await settle();

    expect(gates[gates.length - 1]).toBeNull();
    mgr.dispose();
  });

  it("ignores a real permission gate here (OSC-777 path owns it)", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    // OSC 777 fires → permission branch handles it; the shell-prompt branch is
    // skipped (oscPermission true). The resulting gate has no answerKeys.
    proc._emit(
      "data",
      "\x1b]777;notify;Claude Code;Claude needs your permission\x07\r\n❯ 2. Yes\r\n  3. No\r\n",
    );
    await settle();

    const gate = gates.find((g) => g && g.options.length > 0);
    expect(gate?.options.every((o) => o.answerKeys === undefined)).toBe(true);
    mgr.dispose();
  });
});
