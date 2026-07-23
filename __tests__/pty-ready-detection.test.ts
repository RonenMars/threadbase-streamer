import { EventEmitter } from "events";
import { spawn as mockSpawn } from "node-pty";
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
      _emit: ee.emit.bind(ee),
    };
  }
  return { spawn: vi.fn(() => makeMockProcess()) };
});

// Real-world boot chunk from the connector/MCP-status splash variant — does
// NOT contain ╭ anywhere. Captured from a stuck session in production logs.
const MCP_SPLASH_BOOT =
  "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h" +
  "\x1b]0;✳ Claude Code\x07\x1b[38;5;174m ▐\x1b[48;5;16m▛███▜\x1b[49m▌" +
  "\x1b[3C\x1b[39m\x1b[1mClaude\x1b[1CCode\x1b[1C\x1b[22m\x1b[38;5;246mv2.1.138\x1b[39m\r\r\n" +
  '❯\xa0Try "how does docusaurus.config.ts work?"\r\n';

// Real-world boot chunk from the Tips banner variant — contains ╭.
const TIPS_BANNER_BOOT =
  "\x1b[38;5;174m╭───\x1b[1CClaude Code v2.1.138" + "─────────────────────────────────────╮\r\r\n";

async function spawnFresh(mgr: PTYManager, projectPath = "/tmp/test") {
  const session = await mgr.startFresh({
    projectPath,
    projectName: "test",
  });
  // The mock spawn function is shared; grab the most recent process via the
  // private map. We expose it via the session's internal process by reaching
  // through the public API: drive the mock by emitting data and check status.
  return session;
}

async function spawnResume(mgr: PTYManager, sessionId = "uuid-resume") {
  return mgr.start(sessionId, {
    projectPath: "/tmp/test",
    projectName: "test",
    branch: "main",
  });
}

function getMockProc(mgr: PTYManager, sessionId: string): any {
  return (mgr as any).sessions.get(sessionId).process;
}

describe("PTYManager — ready detection", () => {
  it("detects ╭ marker (Tips banner variant)", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    expect(session.provider).toBe("claude-code");
    proc._emit("data", TIPS_BANNER_BOOT);

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
    mgr.dispose();
  });

  it("detects ❯ marker when ╭ is absent (MCP splash variant)", async () => {
    const statusChanges: ManagedSession[] = [];
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({
      onStatusChange: (s) => statusChanges.push(s),
      onReady: (s) => ready.push(s),
    });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", MCP_SPLASH_BOOT);

    expect(MCP_SPLASH_BOOT.includes("╭")).toBe(false);
    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    expect(ready).toHaveLength(1);
    mgr.dispose();
  });

  it("flushes queued input once ❯ marker fires", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      // User types before Claude is ready — input gets queued.
      const promptCount = mgr.sendInput(session.id, "hi");
      expect(promptCount).toBe(1);
      expect(proc.write).not.toHaveBeenCalled();

      // Claude's TUI shows the MCP splash with ❯ — should flush "hi" now.
      proc._emit("data", MCP_SPLASH_BOOT);

      // Paste body lands first. The trailing \r is deferred via setTimeout so
      // Claude's TUI gets a tick to process the paste before Enter arrives —
      // see buildPasteBytes() comment for the 2026-05-27 stuck-session
      // regression that motivated the split.
      expect(proc.write).toHaveBeenCalledWith("\x1b[200~hi\x1b[201~");
      expect(proc.write).not.toHaveBeenCalledWith("\r");

      vi.advanceTimersByTime(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes queued input via time-fallback when no marker ever fires", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      mgr.sendInput(session.id, "hello");
      expect(proc.write).not.toHaveBeenCalled();

      // Tick #1: small chunk, no marker, well under the 10s window.
      proc._emit("data", "\x1b[?2004h booting...");
      expect(proc.write).not.toHaveBeenCalled();

      // Advance past the 10s fallback window.
      vi.advanceTimersByTime(10_500);

      // Tick #2: another chunk with no marker — but now elapsed > 10s, so the
      // fallback should fire and flush the queued input.
      proc._emit("data", "still booting...");

      // Paste body first, then \r after the submit delay.
      expect(proc.write).toHaveBeenCalledWith("\x1b[200~hello\x1b[201~");
      vi.advanceTimersByTime(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps @<path> input in bracketed-paste markers and submits via deferred \\r", async () => {
    // Regression — two-part:
    // 1. (2026-05-20) Input like "@/Users/foo/img.heic describe this" opens
    //    Claude's @-mention picker. A plain \r is captured as "accept
    //    completion" rather than "submit". Bracketed paste bypasses the
    //    picker — see docs/postmortems/2026-05-20-pty-bracketed-paste-fix.md.
    // 2. (2026-05-27, session 39118d3e) The bracketed wrap landed but the
    //    TUI was mid-render of a startup status banner when the bytes
    //    arrived, so the inline \r still didn't submit. We now split the
    //    paste body and the trailing \r across two PTY writes with a tiny
    //    delay, giving the TUI a tick to process the paste before Enter.
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      // Get the session past pendingReady so direct write (not queue) runs.
      proc._emit("data", MCP_SPLASH_BOOT);
      proc.write.mockClear();

      mgr.sendInput(session.id, "@/Users/foo/img.heic describe this");

      // Immediately after sendInput(), only the paste body has been written.
      // The trailing \r must NOT have landed yet — that's the whole point of
      // the split: Claude's TUI needs an event-loop tick first.
      expect(proc.write).toHaveBeenCalledTimes(1);
      expect(proc.write).toHaveBeenCalledWith(
        "\x1b[200~@/Users/foo/img.heic describe this\x1b[201~",
      );

      // Advance past the submit delay; now \r is written.
      vi.advanceTimersByTime(20);
      expect(proc.write).toHaveBeenCalledTimes(2);
      expect(proc.write).toHaveBeenLastCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers \\r submit while the TUI keeps repainting (redraw race)", async () => {
    // Regression for 2026-07 session 14dda340: a "Yes" reply landed while
    // Claude's TUI was still mid-redraw right after posting its question. The
    // old fixed SUBMIT_DELAY_MS timer fired \r regardless of TUI activity, so
    // the redraw could absorb the Enter and the reply never became a
    // submitted JSONL turn even though the session kept running. writeSubmit
    // now polls until the PTY has been quiet for a full SUBMIT_DELAY_MS
    // before writing \r.
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      proc._emit("data", MCP_SPLASH_BOOT);
      proc.write.mockClear();

      mgr.sendInput(session.id, "Yes");
      expect(proc.write).toHaveBeenCalledTimes(1);

      // TUI is still repainting: a chunk lands just before the first poll.
      vi.advanceTimersByTime(10);
      proc._emit("data", "\x1b[2K\x1b[1Grepainting...");

      // The original poll tick (16ms) fires now, but the PTY went quiet only
      // 6ms ago — not yet quiet for SUBMIT_DELAY_MS, so \r must NOT submit.
      vi.advanceTimersByTime(6);
      expect(proc.write).toHaveBeenCalledTimes(1);

      // Once the PTY has been quiet for a full SUBMIT_DELAY_MS, \r submits.
      vi.advanceTimersByTime(16);
      expect(proc.write).toHaveBeenCalledTimes(2);
      expect(proc.write).toHaveBeenLastCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits \\r after SUBMIT_MAX_WAIT_MS even if the PTY never goes quiet", async () => {
    // Bound on the quiescence wait: a pathologically chatty or wedged PTY
    // must not hold a queued reply forever.
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      proc._emit("data", MCP_SPLASH_BOOT);
      proc.write.mockClear();

      mgr.sendInput(session.id, "Yes");
      expect(proc.write).toHaveBeenCalledTimes(1);

      // Keep the PTY "busy" with a chunk on every poll tick, well past the
      // SUBMIT_MAX_WAIT_MS cap — \r must still submit rather than wait forever.
      for (let elapsed = 0; elapsed < 600; elapsed += 16) {
        vi.advanceTimersByTime(16);
        proc._emit("data", "still repainting...");
      }
      expect(proc.write).toHaveBeenCalledTimes(2);
      expect(proc.write).toHaveBeenLastCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-fire markReady on subsequent matching chunks", async () => {
    const ready: ManagedSession[] = [];
    const mgr = new PTYManager({ onReady: (s) => ready.push(s) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", TIPS_BANNER_BOOT);
    proc._emit("data", TIPS_BANNER_BOOT);
    proc._emit("data", "❯ another prompt arrow somewhere");

    // onReady should only have fired once — pendingReady was cleared after
    // the first match.
    expect(ready).toHaveLength(1);
    mgr.dispose();
  });

  it("flushes queued input via quiet-timeout when the PTY goes silent (no marker, no further chunk)", async () => {
    vi.useFakeTimers();
    try {
      const statusChanges: ManagedSession[] = [];
      const ready: ManagedSession[] = [];
      const mgr = new PTYManager({
        onStatusChange: (s) => statusChanges.push(s),
        onReady: (s) => ready.push(s),
      });
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      mgr.sendInput(session.id, "hello");

      // Chunk with no marker, well under both the quiet-detect window and the
      // 10s fallback. Nothing should fire yet.
      proc._emit("data", "\x1b[?2004h booting...");
      expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(false);

      // No further chunk ever arrives (Claude is blocked on a prompt with no
      // marker in the boot screen). Advancing past the 500ms quiet window
      // should flip the session to waiting_input on its own.
      vi.advanceTimersByTime(500);

      expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
      expect(ready).toHaveLength(1);

      expect(proc.write).toHaveBeenCalledWith("\x1b[200~hello\x1b[201~");
      vi.advanceTimersByTime(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // These two tests deliberately do NOT use fake timers: the new code path
  // (recheckReadyFromScreen) awaits getOutputLines(), whose xterm-headless
  // write callback needs a genuine event-loop tick to settle — the same
  // reason __tests__/pty-shell-prompt-detection.test.ts uses a real `settle`
  // delay instead of vi.useFakeTimers() for screen-read-dependent assertions.

  it("re-derives waiting_input from the rendered screen when a later chunk doesn't carry the marker", async () => {
    // Regression: mid-conversation, Claude's TUI can return to an idle prompt
    // without retransmitting ╭/❯ in the specific chunk that finishes the
    // reply (differential repaint — the box was already drawn earlier and
    // doesn't get redrawn just to update a status line). Before this fix,
    // the quiet-timeout fallback only fired for the FIRST prompt after
    // spawn/resume (gated on pendingReady), so this case went undetected
    // forever — status stayed "running" even though Claude was done and
    // idling for input.
    const statusChanges: ManagedSession[] = [];
    const mgr = new PTYManager({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    // First prompt: boot marker fires, pendingReady clears.
    proc._emit("data", TIPS_BANNER_BOOT);
    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    statusChanges.length = 0;

    // User sends a second message — status flips back to "running".
    // pendingReady is NOT re-armed for this turn (only spawn/resume does).
    mgr.sendInput(session.id, "what's next?");

    // Claude replies and finishes, but the final chunk only updates a
    // status line — no ╭ or ❯ in this chunk's raw text. The box from the
    // original TIPS_BANNER_BOOT render is still on screen, just not
    // retransmitted.
    proc._emit("data", "Sautéed for 3s\r\n────────────\r\n> \r\n");
    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(false);

    // No further chunk ever arrives. Waiting past the quiet-detect window
    // (500ms) plus settle time should re-check the rendered screen (which
    // still contains the original ╭ box) and flip back to waiting_input.
    await new Promise((r) => setTimeout(r, 700));

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
    mgr.dispose();
  });

  it("stays running via the screen recheck when no marker is anywhere on screen", async () => {
    // Sanity check for the same code path: if the marker genuinely isn't on
    // screen (Claude is still actually working), the recheck must not
    // false-positive into waiting_input.
    const statusChanges: ManagedSession[] = [];
    const mgr = new PTYManager({ onStatusChange: (s) => statusChanges.push(s) });
    const session = await spawnFresh(mgr);
    const proc = getMockProc(mgr, session.id);

    proc._emit("data", MCP_SPLASH_BOOT);
    statusChanges.length = 0;
    mgr.sendInput(session.id, "keep going");

    // Scroll the boot ❯ marker off the viewport (PTY_ROWS=40) with filler
    // output before the no-marker "still working" chunk, so the recheck
    // window (last 40 rendered lines) genuinely contains no marker.
    proc._emit("data", Array(45).fill("filler line\r\n").join(""));
    proc._emit("data", "still working on it, no prompt markers here...");
    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(false);

    await new Promise((r) => setTimeout(r, 700));

    expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(false);
    mgr.dispose();
  });

  it("does not fire the quiet-timeout while chunks keep arriving within the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const statusChanges: ManagedSession[] = [];
      const mgr = new PTYManager({ onStatusChange: (s) => statusChanges.push(s) });
      const session = await spawnFresh(mgr);
      const proc = getMockProc(mgr, session.id);

      // Simulate a steady stream of small chunks (no marker), each arriving
      // well inside the 500ms debounce window — mimics Claude mid-response.
      for (let i = 0; i < 5; i++) {
        proc._emit("data", `chunk ${i}...`);
        vi.advanceTimersByTime(200);
      }

      // The debounce should have been re-armed on every chunk, so the quiet
      // handler never got 500ms of uninterrupted silence to fire in.
      expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(false);

      // Now let it actually go quiet — the debounce should fire from here.
      vi.advanceTimersByTime(500);
      expect(statusChanges.some((s) => s.status === "waiting_input")).toBe(true);
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression for the resume side of the "dot bug": before the fix, start()
// (resume path) did NOT add the session to pendingReady and fired onReady
// synchronously at spawn time. Input written during the JSONL restore window
// would be swallowed by Claude's boot UI — the first user message vanished and
// a second message (often just ".") appeared to trigger both. The contract is
// now symmetric: start() and startFresh() both queue input until the prompt
// marker arrives, then flush.
describe("PTYManager — resume input queueing", () => {
  it("queues input sent during resume boot and flushes at first prompt", async () => {
    vi.useFakeTimers();
    try {
      const ready: ManagedSession[] = [];
      const mgr = new PTYManager({ onReady: (s) => ready.push(s) });
      const session = await spawnResume(mgr);
      const proc = getMockProc(mgr, session.id);

      // onReady must NOT have fired synchronously at spawn — the old behavior
      // broadcast session_ready before Claude was actually ready.
      expect(ready).toHaveLength(0);

      // User taps Send while Claude is still restoring the JSONL.
      const promptCount = mgr.sendInput(session.id, "what's the plan?");
      expect(promptCount).toBe(1);
      expect(proc.write).not.toHaveBeenCalled();

      // Claude finishes booting and renders the prompt.
      proc._emit("data", MCP_SPLASH_BOOT);

      // Queued input flushes via the same split-write contract: paste body
      // first, then \r after the submit delay.
      expect(proc.write).toHaveBeenCalledWith("\x1b[200~what's the plan?\x1b[201~");
      vi.advanceTimersByTime(20);
      expect(proc.write).toHaveBeenCalledWith("\r");
      // onReady fires exactly once, after the marker — not at spawn.
      expect(ready).toHaveLength(1);
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes multiple queued resume inputs in arrival order", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new PTYManager();
      const session = await spawnResume(mgr, "uuid-resume-multi");
      const proc = getMockProc(mgr, session.id);

      mgr.sendInput(session.id, "first");
      mgr.sendInput(session.id, "second");
      expect(proc.write).not.toHaveBeenCalled();

      proc._emit("data", TIPS_BANNER_BOOT);

      // First paste lands immediately, its \r is deferred. Second paste is
      // staggered so it lands *after* the first \r — preventing interleaved
      // paste/submit pairs that Claude's TUI would treat ambiguously.
      expect(proc.write).toHaveBeenCalledTimes(1);
      expect(proc.write.mock.calls[0][0]).toBe("\x1b[200~first\x1b[201~");

      // Timeline: 0=paste1, 16ms=\r1, 32ms=paste2, 48ms=\r2.
      vi.advanceTimersByTime(60);

      expect(proc.write).toHaveBeenCalledTimes(4);
      expect(proc.write.mock.calls[0][0]).toBe("\x1b[200~first\x1b[201~");
      expect(proc.write.mock.calls[1][0]).toBe("\r");
      expect(proc.write.mock.calls[2][0]).toBe("\x1b[200~second\x1b[201~");
      expect(proc.write.mock.calls[3][0]).toBe("\r");
      mgr.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PTYManager — spawn permission flags", () => {
  // Regression guard for the prod "Start Session Here" fix: launching with
  // --dangerously-skip-permissions renders a blocking "Bypass Permissions mode"
  // warning in the interactive TUI that no config flag suppresses, so the
  // session never reaches a usable prompt. --permission-mode acceptEdits auto-
  // approves file edits without that warning gate. See src/pty-manager.ts.
  function spawnArgs(): string[] {
    const calls = (mockSpawn as any).mock.calls;
    return calls[calls.length - 1][1] as string[];
  }

  beforeEach(() => {
    (mockSpawn as any).mockClear();
  });

  it("startFresh spawns with --permission-mode acceptEdits, not --dangerously-skip-permissions", async () => {
    const mgr = new PTYManager();
    await mgr.startFresh({ projectPath: "/tmp/test", projectName: "test" });
    const args = spawnArgs();

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--dangerously-skip-permissions");
    mgr.dispose();
  });

  it("resume (start) spawns with --permission-mode acceptEdits, not --dangerously-skip-permissions", async () => {
    const mgr = new PTYManager();
    await mgr.start("uuid-resume", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
    });
    const args = spawnArgs();

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).not.toContain("--dangerously-skip-permissions");
    mgr.dispose();
  });

  it("startFresh honors an explicit permissionMode override", async () => {
    const mgr = new PTYManager();
    await mgr.startFresh({
      projectPath: "/tmp/test",
      projectName: "test",
      permissionMode: "manual",
    });
    const args = spawnArgs();

    expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual");
    mgr.dispose();
  });

  it("resume (start) honors an explicit permissionMode override", async () => {
    const mgr = new PTYManager();
    await mgr.start("uuid-resume", {
      projectPath: "/tmp/test",
      projectName: "test",
      branch: "main",
      permissionMode: "manual",
    });
    const args = spawnArgs();

    expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual");
    mgr.dispose();
  });
});
