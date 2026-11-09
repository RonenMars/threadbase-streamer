import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import { PTYManager } from "../src/pty-manager";

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

const internal = (mgr: PTYManager, id: string) => (mgr as any).sessions.get(id);
const emit = (mgr: PTYManager, id: string, data: string) =>
  internal(mgr, id).process._emit("data", data);

// Past QUIET_DETECT_MS (500) so the quiet recheck has run against the screen.
const settleQuiet = () => new Promise((r) => setTimeout(r, 800));

// Raw chunks from Claude Code 2.1.280, as the PTY delivered them.
const FIXTURE: { chunks: [number, string][] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures/turn-signals/claude-2.1.280-turn.json"), "utf8"),
);
// The boot chunk that paints the composer: `❯` + U+00A0, then the placeholder.
const COMPOSER_CHUNK = FIXTURE.chunks.map(([, c]) => c).find((c) => c.includes("❯\u00a0")) ?? "";
// The past user prompt echoed in the transcript: `❯` + a plain space. Cut out
// of the raw post-submit chunk (which also repaints the composer) from its
// background-colour escape to the end of its row.
const ECHO_LINE = (() => {
  const chunk = FIXTURE.chunks.map(([, c]) => c).find((c) => c.includes("❯ ")) ?? "";
  const start = chunk.indexOf("\x1b[48;5;237m");
  return chunk.slice(start, chunk.indexOf("\r", start));
})();
// The ASCII rendering this fallback targets (#959): the same bytes with `>`
// in place of `❯`. Unverified against a live Claude run with ASCII chrome.
const toAscii = (s: string) => s.replaceAll("❯", ">");

// Claude Code's workspace-trust gate. A printed view, not raw bytes: no raw
// capture of this gate exists yet (same constant as startup-gate-idle-rescan).
const TRUST_GATE = [
  "────────────────────────────────────────────────────────",
  " Accessing workspace:",
  " /tmp/test",
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

async function boot() {
  const mgr = new PTYManager();
  const { id } = await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
  return { mgr, id };
}

describe("PTYManager — Claude readiness without the Unicode glyphs (#959)", () => {
  it("the fixture pieces have the shape the tests rely on", () => {
    expect(COMPOSER_CHUNK).toBeDefined();
    expect(COMPOSER_CHUNK).not.toContain("╭");
    expect(COMPOSER_CHUNK.split("❯").length - 1).toBe(1);
    expect(ECHO_LINE.startsWith("\x1b[48;5;237m")).toBe(true);
    expect(ECHO_LINE).toContain("❯ ");
    expect(ECHO_LINE).not.toContain("\u00a0");
  });

  it("settles the boot on the ASCII composer prompt `>` + NBSP", async () => {
    const { mgr, id } = await boot();
    emit(mgr, id, toAscii(COMPOSER_CHUNK));
    expect(internal(mgr, id).status).toBe("waiting_input");
    expect(internal(mgr, id).statusSource).toBe("prompt-marker");
    mgr.dispose();
  });

  it("does not settle on an echoed past prompt `>` + space (control)", async () => {
    const { mgr, id } = await boot();
    emit(mgr, id, toAscii(ECHO_LINE));
    expect(internal(mgr, id).status).toBe("running");
    await settleQuiet();
    expect(internal(mgr, id).status).toBe("running");
    mgr.dispose();
  });

  it("does not take the trust gate's cursor for a composer at boot", async () => {
    const { mgr, id } = await boot();
    mgr.sendInput(id, "hello");
    emit(mgr, id, TRUST_GATE);
    expect(internal(mgr, id).status).toBe("running");
    await settleQuiet();
    expect(internal(mgr, id).status).toBe("running");
    // The queued prompt was not flushed into the gate.
    expect((mgr as any).queuedInputs.get(id)).toEqual(["hello"]);

    // The backstop waits while the gate is up, and re-arms rather than lapsing.
    (mgr as any).fireReadyFallback(id);
    expect(internal(mgr, id).status).toBe("running");
    expect((mgr as any).queuedInputs.get(id)).toEqual(["hello"]);
    expect((mgr as any).readyFallbackTimers.has(id)).toBe(true);

    // Answered: the composer paints, the boot settles on the marker and the
    // queue flushes. The flushed prompt is a submit, so the session is `running`
    // again by the time this returns; the settle shows in pendingReady and the
    // flushed write, not in the status.
    emit(mgr, id, "\x1b[2J\x1b[H");
    emit(mgr, id, COMPOSER_CHUNK);
    expect((mgr as any).pendingReady.has(id)).toBe(false);
    expect((mgr as any).queuedInputs.has(id)).toBe(false);
    expect(internal(mgr, id).process.write).toHaveBeenCalledWith(expect.stringContaining("hello"));
    mgr.dispose();
  });

  it("still settles on the backstop when no gate is up (control)", async () => {
    const { mgr, id } = await boot();
    emit(mgr, id, "\r\n● agents-md: loaded\r\n");
    await settleQuiet();
    expect(internal(mgr, id).status).toBe("running");
    (mgr as any).fireReadyFallback(id);
    expect(internal(mgr, id).status).toBe("waiting_input");
    expect(internal(mgr, id).statusSource).toBe("timeout-fallback");
    mgr.dispose();
  });

  it("keeps the `❯` composer marker settling the boot (control)", async () => {
    const { mgr, id } = await boot();
    emit(mgr, id, COMPOSER_CHUNK);
    expect(internal(mgr, id).status).toBe("waiting_input");
    mgr.dispose();
  });
});
