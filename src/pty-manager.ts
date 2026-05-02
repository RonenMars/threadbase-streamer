import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { resolveClaudeExe } from "./platform";
import type {
  ManagedSession,
  PTYManagerOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
} from "./types";

const OUTPUT_BUFFER_MAX = 65536;

// Claude's interactive prompt starts with this box-drawing character when it is
// waiting for user input (the top-left corner of its input box UI).
const CLAUDE_PROMPT_MARKER = "╭";

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

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
    this.onReady = options.onReady;
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

  // Start a brand-new Claude session with no existing conversationId.
  // Returns a session with a temporary pending_* id. The server watches the
  // project directory for the JSONL file Claude creates and re-keys the entry.
  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const pendingId = options.pendingId ?? `pending_${randomBytes(8).toString("hex")}`;
    const projectName = options.projectName ?? basename(options.projectPath);

    const args: string[] = ["--dangerously-skip-permissions"];
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
      id: pendingId,
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

    this.sessions.set(pendingId, session);

    proc.onData((data: string) => {
      this.handleOutput(pendingId, data);
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.handleExit(pendingId, exitCode);
    });

    this.onReady?.(toPublicSession(session));
    return toPublicSession(session);
  }

  // Re-key a pending_ session to its real JSONL UUID once Claude creates the file.
  rekeySession(pendingId: string, realId: string): boolean {
    const session = this.sessions.get(pendingId);
    if (!session) return false;
    session.id = realId;
    this.sessions.delete(pendingId);
    this.sessions.set(realId, session);
    return true;
  }

  sendInput(sessionId: string, input: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
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
  }

  private handleOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const chunk = Buffer.from(data, "utf-8");
    session.outputBuffer = Buffer.concat([session.outputBuffer, chunk]);

    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.subarray(
        session.outputBuffer.length - OUTPUT_BUFFER_MAX,
      );
    }

    const stripped = stripAnsi(data);
    session.lastOutput = stripped;

    if (session.status === "running" && stripped.includes(CLAUDE_PROMPT_MARKER)) {
      session.lastActivityAt = new Date();
      session.status = "waiting_input";
      this.onStatusChange?.(toPublicSession(session));
    }

    this.onOutput?.(sessionId, data);
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
