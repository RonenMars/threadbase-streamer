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
}

export class PTYManager {
  private sessions = new Map<string, InternalSession>();
  private onOutput: PTYManagerOptions["onOutput"];
  private onStatusChange: PTYManagerOptions["onStatusChange"];
  private onReady: PTYManagerOptions["onReady"];
  // Tracks which sessions were started fresh (not resume) and haven't fired onReady yet
  private pendingReady = new Set<string>();
  // Inputs received via sendInput() while the session was still in pendingReady.
  // Flushed in arrival order once Claude reaches its first prompt. Without this,
  // input written into the raw PTY mid-boot is consumed by Claude's startup TUI
  // (welcome banner / first-run modals) and silently lost.
  private queuedInputs = new Map<string, string[]>();
  private log: Logger;
  // Timestamp of first PTY chunk per session; drives the prompt-marker fallback
  // when neither ╭ nor ❯ shows up within PROMPT_MARKER_FALLBACK_MS.
  private firstChunkAt = new Map<string, number>();

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
        env: process.env as Record<string, string>,
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
    };

    this.sessions.set(sessionId, session);

    proc.onData((data: string) => {
      this.handleOutput(sessionId, data);
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.handleExit(sessionId, exitCode);
    });

    this.onReady?.(toPublicSession(session));
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
      env: process.env as Record<string, string>,
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
    session.process.write(`${input}\r`);
    session.lastActivityAt = new Date();
    session.promptCount++;
    return session.promptCount;
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
    for (const input of queue) {
      session.process.write(`${input}\r`);
    }
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
    this.sessions.delete(sessionId);
    this.onStatusChange?.(toPublicSession(session));
  }

  getOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.outputBuffer.toString("utf-8");
  }

  getOutputLines(sessionId: string, maxLines: number): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const raw = session.outputBuffer.toString("utf-8");
    return raw.split("\n").slice(-maxLines);
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
    }
    this.sessions.clear();
    this.firstChunkAt.clear();
  }

  private handleOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const chunk = Buffer.from(data, "utf-8");
    const now = Date.now();
    if (!this.firstChunkAt.has(sessionId)) {
      this.firstChunkAt.set(sessionId, now);
    }

    session.outputBuffer = Buffer.concat([session.outputBuffer, chunk]);

    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.subarray(
        session.outputBuffer.length - OUTPUT_BUFFER_MAX,
      );
    }

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
