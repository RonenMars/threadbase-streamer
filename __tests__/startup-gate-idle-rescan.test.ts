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
  return (mgr as any).sessions.get(sessionId).process;
}
const statusOf = (mgr: PTYManager, id: string) => (mgr as any).sessions.get(id).status;

// Claude Code's workspace-trust gate, captured verbatim. The `❯` on the
// selected option is the trap: readiness cannot tell it from a composer prompt.
const TRUST_GATE = [
  "────────────────────────────────────────────────────────",
  " Accessing workspace:",
  " C:\\Users\\PC\\Desktop\\dev\\autokitteh",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  " Claude Code'll be able to read, edit, and execute files here.",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\r\n");

// Past QUIET_DETECT_MS (500) so the quiet debounce has fired.
const settleQuiet = () => new Promise((r) => setTimeout(r, 800));

describe("PTYManager — blocking startup gate on an idle session", () => {
  it("broadcasts the trust gate even after its own ❯ settled the session", async () => {
    const gates: Gate[] = [];
    const mgr = new PTYManager({ onPermissionChange: (_id, gate) => gates.push(gate) });
    const session = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const proc = getMockProc(mgr, session.id);

    // Reproduce the real timing, which is the whole point. A first chunk stamps
    // lastDetectAt; the gate then paints INSIDE the SCRAPE_THROTTLE_MS window,
    // so the per-chunk claim early-returns without ever scraping it. In
    // production that is the boot burst, and no further chunk ever arrives —
    // the screen is static from then on, so the quiet rescan is the only thing
    // left that can see the gate.
    // Reproduce the real timing, which is the whole point. A first chunk stamps
    // lastDetectAt; the gate then paints INSIDE the SCRAPE_THROTTLE_MS window,
    // so the per-chunk claim early-returns without ever scraping it.
    proc._emit("data", "\r\n● agents-md: loaded\r\n");
    // Let that pass finish against a gate-free screen, so its async read cannot
    // pick the gate up for us. lastDetectAt is now stamped.
    await new Promise((r) => setTimeout(r, 60));
    proc._emit("data", TRUST_GATE);

    // And settle the session the way the gate's own `❯` does in production,
    // before the quiet tick runs. This is the state the rescan exists for: the
    // screen is static, the per-chunk claim has been throttled away, and the
    // `running`-only quiet path would return without ever looking.
    (mgr as any).sessions.get(session.id).status = "waiting_input";

    await settleQuiet();

    // The precondition this test exists for: the gate's own cursor glyph is a
    // CLAUDE_PROMPT_MARKER, so the session settles to waiting_input with the
    // gate still painted. Without the idle rescan the screen then goes static
    // and nothing ever claims it — the gate reaches the client as raw text.
    expect(statusOf(mgr, session.id)).toBe("waiting_input");

    const gate = gates.at(-1);
    expect(gate).not.toBeNull();
    expect(gate?.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    // A digit answers nothing here; the bytes have to move the cursor.
    expect(gate?.options[1].answerKeys).toBe("\x1b[B\r");
  });
});
