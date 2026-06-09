import { Terminal } from "@xterm/headless";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { resolveClaudeExe } from "./platform";
import type {
  ManagedSession,
  PTYManagerOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
} from "./types";

const OUTPUT_BUFFER_MAX = 65536;

// PTY geometry. The headless render terminal (session.screen) MUST match these
// so Claude's absolute cursor moves (ESC[<row>;<col>H) resolve to the same
// screen coordinates the real TUI is painting against.
const PTY_COLS = 120;
const PTY_ROWS = 40;
// Scrollback depth for the render terminal. Replay reads up to maxLines (200)
// from the rendered buffer, so keep enough history above the viewport.
const SCREEN_SCROLLBACK = 1000;

// Markers that indicate Claude has reached an interactive prompt and is ready
// for user input. The TUI has at least two startup variants:
//   - "Tips" banner: renders a box with corner ╭ characters
//   - Connector/MCP-status splash: no box at all; shows ❯ as the prompt arrow
// We treat either marker in a chunk as "ready". False-positives are harmless —
// the worst case is flushing queued input slightly early, which Claude buffers.
const CLAUDE_PROMPT_MARKERS = ["╭", "❯"] as const;

// If a fresh session has produced any output but neither prompt marker has
// fired within this window, flush queued input anyway. Defense against future
// TUI changes that drop both markers from the boot screen.
const PROMPT_MARKER_FALLBACK_MS = 10_000;

// Build the two byte sequences for a paste-then-submit. We deliberately split
// the paste body and the trailing \r into two separate PTY writes (see
// writeSubmit() below) so Claude's TUI gets one event-loop tick to process the
// paste (clear input buffer, render `Pasting…`) before Enter arrives.
//
// Why bracketed paste at all: Claude's TUI enables bracketed paste mode
// (\x1b[?2004h) at startup. Content between \x1b[200~ and \x1b[201~ is
// committed as a single insertion without triggering autocomplete or key
// bindings. Without this wrap an input like "@<path>" opens the mention
// picker and the trailing \r gets consumed as "accept completion" rather
// than "submit" — see docs/postmortems/2026-05-20-pty-bracketed-paste-fix.md.
//
// Why split paste and \r: on 2026-05-27 a follow-up stuck session
// (39118d3e) showed the bracketed-paste wrap was being written but the
// trailing \r still didn't submit — Claude's TUI was mid-render of a
// startup status banner ("Update available", "192 skill descriptions
// dropped", etc.) when the bytes arrived, and the whole chunk landed in
// the wrong handler context. Splitting the write lets the TUI ingest the
// paste in one tick (the data event runs after current render finishes)
// before the next tick delivers the Enter.
function buildPasteBytes(input: string): string {
  return `\x1b[200~${input}\x1b[201~`;
}

const SUBMIT_BYTES = "\r";

// Delay between the paste write and the submit \r. We need to yield the event
// loop at least once so Claude's TUI processes the paste before Enter lands;
// a small real-time delay is more robust against the TUI batching renders
// across multiple data events. Kept tiny so user-perceived latency is nil.
const SUBMIT_DELAY_MS = 16;

function digestBytes(s: string): string {
  // Replace control chars with their hex form so logs are grep-able.
  // Building the regex via RegExp() sidesteps a Biome lint rule that flags
  // literal control characters in regex literals.
  const escaped = s
    .replace(new RegExp(String.fromCharCode(0x1b), "g"), "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  if (escaped.length <= 200) return escaped;
  return `${escaped.slice(0, 100)}…[${escaped.length - 200}B omitted]…${escaped.slice(-100)}`;
}

// node-pty is a native addon — import dynamically to allow graceful failure
let pty: typeof import("node-pty") | null = null;

async function loadPty(): Promise<typeof import("node-pty")> {
  if (pty) return pty;
  try {
    pty = await import("node-pty");
    return pty;
  } catch (err) {
    throw new Error(
      "node-pty is required for PTY management but failed to load. " +
        "Ensure it is installed: npm install node-pty\n" +
        `Original error: ${err}`,
    );
  }
}

interface InternalSession extends ManagedSession {
  process: any; // node-pty IPty
  outputBuffer: Buffer;
  // Headless terminal that renders the raw PTY stream into a real screen grid.
  // getOutputLines() reads its rendered buffer so replay reflects true screen
  // order rather than raw byte order (which Claude's absolute-cursor repaints
  // scramble — see getOutputLines for the desync this fixes).
  screen: Terminal;
}

function createScreen(): Terminal {
  return new Terminal({
    cols: PTY_COLS,
    rows: PTY_ROWS,
    scrollback: SCREEN_SCROLLBACK,
    allowProposedApi: true,
  });
}

// Build the environment for a spawned `claude` process. The Anthropic API key
// is injected only here — never exported into the streamer's global process
// env — so it does not leak into unrelated child processes. CLAUDE_API_KEY
// (the Fly secret) is mapped to ANTHROPIC_MODEL's sibling, ANTHROPIC_API_KEY,
// which the CLI reads. If CLAUDE_API_KEY is unset, nothing is added and the CLI
// falls back to its own auth (e.g. an interactive login).
function buildSpawnEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (env.CLAUDE_API_KEY) {
    env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
  }
  return env;
}

export class PTYManager {
  private sessions = new Map<string, InternalSession>();
  private onOutput: PTYManagerOptions["onOutput"];
  private onStatusChange: PTYManagerOptions["onStatusChange"];
  private onReady: PTYManagerOptions["onReady"];
  // Tracks sessions (both fresh and resume) whose PTY has spawned but Claude
  // hasn't yet reached an interactive prompt — i.e. onReady hasn't fired.
  private pendingReady = new Set<string>();
  // Inputs received via sendInput() while the session was still in pendingReady.
  // Flushed in arrival order once Claude reaches its first prompt. Without this,
  // input written into the raw PTY mid-boot is consumed by Claude's startup TUI
  // (welcome banner / first-run modals on fresh, JSONL restore on resume) and
  // silently lost — the "dot bug".
  private queuedInputs = new Map<string, string[]>();
  private log: Logger;
  // Timestamp of first PTY chunk per session; drives the prompt-marker fallback
  // when neither ╭ nor ❯ shows up within PROMPT_MARKER_FALLBACK_MS.
  private firstChunkAt = new Map<string, number>();
  // Per-session chunk counter and last-chunk timestamp. Diagnostic-only,
  // feeds the [pty.chunk] log lines so we can trace whether Claude responded
  // to a given input or fell silent. Reset on dispose().
  private chunkIndex = new Map<string, number>();
  private lastChunkAt = new Map<string, number>();

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
    this.onReady = options.onReady;
    this.log = options.logger ?? getLogger("pty");
  }

  // Resume an existing Claude conversation. sessionId is the JSONL UUID.
  async start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const projectName = options.projectName ?? basename(options.projectPath);

    const proc = nodePty.spawn(
      resolveClaudeExe(),
      ["--dangerously-skip-permissions", "--resume", sessionId],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: options.projectPath,
        env: buildSpawnEnv(),
      },
    );

    const session: InternalSession = {
      id: sessionId,
      projectPath: options.projectPath,
      projectName,
      branch: options.branch ?? "",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      process: proc,
      outputBuffer: Buffer.alloc(0),
      screen: createScreen(),
    };

    this.sessions.set(sessionId, session);
    // Resume re-uses the same boot path as a fresh launch: --resume replays the
    // JSONL into Claude's TUI, which can take several seconds before the prompt
    // is reachable. Until then, raw pty.write() bytes land in the boot UI and
    // are swallowed (the "dot bug" — first message vanishes, second message
    // appears to trigger both). Same pendingReady + flush gating as startFresh.
    this.pendingReady.add(sessionId);

    proc.onData((data: string) => {
      this.handleOutput(sessionId, data);
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.pendingReady.delete(sessionId);
      this.handleExit(sessionId, exitCode);
    });

    return toPublicSession(session);
  }

  // Start a brand-new Claude session. A stable UUID is generated here and passed
  // to Claude via --session-id so the JSONL filename matches from the start.
  // onReady fires once Claude reaches its first prompt (waiting_input).
  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const sessionId = randomUUID();
    const projectName = options.projectName ?? basename(options.projectPath);

    const args = ["--dangerously-skip-permissions", "--session-id", sessionId];
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    const proc = nodePty.spawn(resolveClaudeExe(), args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.projectPath,
      env: buildSpawnEnv(),
    });

    const session: InternalSession = {
      id: sessionId,
      projectPath: options.projectPath,
      projectName,
      branch: "",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      process: proc,
      outputBuffer: Buffer.alloc(0),
      screen: createScreen(),
    };

    this.sessions.set(sessionId, session);
    this.pendingReady.add(sessionId);

    proc.onData((data: string) => {
      this.handleOutput(sessionId, data);
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.pendingReady.delete(sessionId);
      this.handleExit(sessionId, exitCode);
    });

    return toPublicSession(session);
  }

  sendInput(sessionId: string, input: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    }
    // Claude is still booting (TUI not yet at first prompt). Writing into the
    // raw PTY now would let the startup UI swallow the keystrokes. Queue and
    // flush in flushQueuedInputs() once the prompt marker fires.
    if (this.pendingReady.has(sessionId)) {
      const queue = this.queuedInputs.get(sessionId) ?? [];
      queue.push(input);
      this.queuedInputs.set(sessionId, queue);
      session.lastActivityAt = new Date();
      session.promptCount++;
      // Surface that input is being held because Claude hasn't yet emitted a
      // prompt marker. If you see this without a corresponding pty.ready
      // follow-up, the marker detection has regressed.
      this.log.warn(
        `[pty.input.queued] ${sessionId.slice(0, 8)} promptCount=${session.promptCount} queueLen=${queue.length}`,
        {
          event: "pty.input_queued",
          sessionId,
          promptCount: session.promptCount,
          queueLen: queue.length,
          inputLen: input.length,
        },
      );
      return session.promptCount;
    }
    if (session.status === "waiting_input") {
      session.status = "running";
      this.onStatusChange?.(toPublicSession(session));
    }
    this.writeSubmit(sessionId, session, input, "direct", session.promptCount + 1);
    session.lastActivityAt = new Date();
    session.promptCount++;
    return session.promptCount;
  }

  // Two-step paste-then-submit. Writes the bracketed-paste body, yields the
  // event loop for SUBMIT_DELAY_MS, then writes \r. See buildPasteBytes() for
  // why the split matters.
  private writeSubmit(
    sessionId: string,
    session: InternalSession,
    input: string,
    path: "direct" | "flush",
    promptCount: number,
  ): void {
    const pasteBytes = buildPasteBytes(input);
    this.log.info(
      `[pty.input.write] ${sessionId.slice(0, 8)} promptCount=${promptCount} bytes=${pasteBytes.length} digest=${digestBytes(pasteBytes)}`,
      {
        event: "pty.input_write",
        sessionId,
        promptCount,
        byteLen: pasteBytes.length,
        digest: digestBytes(pasteBytes),
        path,
        phase: "paste",
      },
    );
    session.process.write(pasteBytes);
    setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current || current !== session) return;
      this.log.info(
        `[pty.input.submit] ${sessionId.slice(0, 8)} promptCount=${promptCount} digest=\\r`,
        {
          event: "pty.input_write",
          sessionId,
          promptCount,
          byteLen: SUBMIT_BYTES.length,
          digest: "\\r",
          path,
          phase: "submit",
        },
      );
      current.process.write(SUBMIT_BYTES);
    }, SUBMIT_DELAY_MS);
  }

  // Drain any inputs that were sent while the session was still pendingReady,
  // writing them in arrival order now that Claude is at its prompt.
  private flushQueuedInputs(sessionId: string): void {
    const queue = this.queuedInputs.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.queuedInputs.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.log.info(`[pty.flush] ${sessionId.slice(0, 8)} flushing ${queue.length} queued input(s)`, {
      event: "pty.flush_queued",
      sessionId,
      queueLen: queue.length,
    });
    // Chain queued inputs serially: each writeSubmit() defers its \r by
    // SUBMIT_DELAY_MS, and we further stagger subsequent inputs by 2x the
    // delay so paste/submit pairs don't interleave on the wire. Two queued
    // inputs is rare in practice (user tapped Send twice during the brief
    // boot window), but ordering must still produce two distinct submits.
    queue.forEach((input, i) => {
      const writeAt = i * SUBMIT_DELAY_MS * 2;
      if (writeAt === 0) {
        this.writeSubmit(sessionId, session, input, "flush", session.promptCount);
      } else {
        setTimeout(() => {
          const current = this.sessions.get(sessionId);
          if (!current || current !== session) return;
          this.writeSubmit(sessionId, session, input, "flush", session.promptCount);
        }, writeAt);
      }
    });
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.kill("SIGINT");
  }

  killPid(pid: number): void {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  // Kill the PTY and mark the session idle. Called by the WS grace timer.
  putOnHold(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pendingReady.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.firstChunkAt.delete(sessionId);
    try {
      session.process.kill("SIGINT");
    } catch {
      // already dead
    }
    session.status = "idle";
    session.completedAt = new Date();
    session.screen.dispose();
    this.sessions.delete(sessionId);
    this.onStatusChange?.(toPublicSession(session));
  }

  getOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.outputBuffer.toString("utf-8");
  }

  // Render the last `maxLines` rows of the session's screen in true on-screen
  // order. Reads the headless terminal (fed raw PTY bytes in handleOutput) so
  // Claude's absolute-cursor repaints resolve to where they actually paint —
  // unlike the old raw-byte slice, which scrambled order after a TUI repaint
  // and made replayed conversations appear out of order on resume.
  //
  // Async because xterm parses writes on a deferred tick; we flush pending
  // writes (empty write + callback) before reading so the buffer is current.
  async getOutputLines(sessionId: string, maxLines: number): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await new Promise<void>((resolve) => session.screen.write("", () => resolve()));

    const buf = session.screen.buffer.active;
    const lines: string[] = [];
    // buf.length spans scrollback + viewport; iterate the whole thing top-down
    // so the rendered output preserves screen order, then keep the last N.
    for (let y = 0; y < buf.length; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    // Drop trailing blank rows (the unused bottom of the viewport) before
    // trimming to maxLines, so replay isn't padded with empty lines.
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.slice(-maxLines);
  }

  getSession(sessionId: string): ManagedSession | null {
    const session = this.sessions.get(sessionId);
    return session ? toPublicSession(session) : null;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessions(): ManagedSession[] {
    return Array.from(this.sessions.values()).map(toPublicSession);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      try {
        session.process.kill();
      } catch {
        // Process may already be dead
      }
      session.screen.dispose();
    }
    this.sessions.clear();
    this.firstChunkAt.clear();
    this.chunkIndex.clear();
    this.lastChunkAt.clear();
  }

  private handleOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const chunk = Buffer.from(data, "utf-8");
    const now = Date.now();
    if (!this.firstChunkAt.has(sessionId)) {
      this.firstChunkAt.set(sessionId, now);
    }

    // Per-chunk diagnostic log. Keep until the @<path> submit bug is solved.
    const idx = (this.chunkIndex.get(sessionId) ?? 0) + 1;
    this.chunkIndex.set(sessionId, idx);
    const last = this.lastChunkAt.get(sessionId);
    this.lastChunkAt.set(sessionId, now);
    const gapMs = last == null ? 0 : now - last;
    this.log.info(
      `[pty.chunk] ${sessionId.slice(0, 8)} #${idx} +${chunk.length}B gap=${gapMs}ms status=${session.status} digest=${digestBytes(data)}`,
      {
        event: "pty.chunk",
        sessionId,
        chunkIndex: idx,
        chunkBytes: chunk.length,
        gapMs,
        status: session.status,
        pendingReady: this.pendingReady.has(sessionId),
        digest: digestBytes(data),
      },
    );

    session.outputBuffer = Buffer.concat([session.outputBuffer, chunk]);

    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.subarray(
        session.outputBuffer.length - OUTPUT_BUFFER_MAX,
      );
    }

    // Render into the headless screen so getOutputLines() can reproduce true
    // on-screen order. write() is async (parsed on a later tick) but we never
    // read the screen synchronously after a single chunk — replay only happens
    // on subscribe, long after these writes have drained.
    session.screen.write(data);

    const stripped = stripAnsi(data);
    session.lastOutput = stripped;
    const matchedMarker = CLAUDE_PROMPT_MARKERS.find((m) => stripped.includes(m));

    if (session.status === "running" && matchedMarker) {
      this.markReady(sessionId, session, `marker:${matchedMarker}`);
    } else if (
      session.status === "running" &&
      this.pendingReady.has(sessionId) &&
      now - (this.firstChunkAt.get(sessionId) ?? now) >= PROMPT_MARKER_FALLBACK_MS
    ) {
      // Fallback: PTY has produced output for >=10s but neither marker fired.
      // Treat the session as ready so queued input doesn't sit forever.
      this.markReady(sessionId, session, "fallback:timeout");
    }

    this.onOutput?.(sessionId, data);
  }

  // Transition a session from "running" to "waiting_input", clear pendingReady,
  // and flush any queued input. Idempotent: callers can invoke at any chunk.
  private markReady(sessionId: string, session: InternalSession, reason: string): void {
    session.lastActivityAt = new Date();
    session.status = "waiting_input";
    // Log retained on purpose: `reason=fallback:timeout` would be the only
    // signal that Claude's TUI introduced a new boot variant our markers miss.
    const elapsedMs = Date.now() - (this.firstChunkAt.get(sessionId) ?? Date.now());
    this.log.info(`[pty.ready] ${sessionId.slice(0, 8)} ${reason} (elapsed=${elapsedMs}ms)`, {
      event: "pty.ready",
      sessionId,
      reason,
      elapsedMs,
    });
    this.onStatusChange?.(toPublicSession(session));
    if (this.pendingReady.has(sessionId)) {
      this.pendingReady.delete(sessionId);
      this.flushQueuedInputs(sessionId);
      this.onReady?.(toPublicSession(session));
    }
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.completedAt = new Date();
    session.status = "idle";

    // Instant exit with no output — diagnose the most likely cause.
    const elapsedMs = session.completedAt.getTime() - session.startedAt.getTime();
    if (exitCode !== 0 && elapsedMs < 2000 && session.lastOutput === "") {
      if (!existsSync(session.projectPath)) {
        session.failureReason = `Project directory not found: ${session.projectPath}`;
      } else {
        session.failureReason =
          `Process exited immediately (code ${exitCode}). ` +
          `Check that the Claude binary is installed and accessible.`;
      }
    }

    this.onStatusChange?.(toPublicSession(session));
    session.screen.dispose();
    this.sessions.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.firstChunkAt.delete(sessionId);
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    promptCount: s.promptCount,
    lastOutput: s.lastOutput,
    ...(s.failureReason != null && { failureReason: s.failureReason }),
    ...(s.lastActivityAt != null && { lastActivityAt: s.lastActivityAt }),
    ...(s.filePath != null && { filePath: s.filePath }),
  };
}

// Strip ANSI escape sequences for clean text preview
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
