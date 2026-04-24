import { randomBytes } from "crypto";
import { basename } from "path";
import type {
  ManagedSession,
  PTYManagerOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
} from "./types";

const OUTPUT_BUFFER_MAX = 65536;

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

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
  }

  async start(options: StartSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const sessionId = `ses_${randomBytes(8).toString("hex")}`;
    const projectName = options.projectName ?? basename(options.projectPath);

    const proc = nodePty.spawn("claude", ["--resume", options.conversationId], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.projectPath,
      env: process.env as Record<string, string>,
    });

    const session: InternalSession = {
      id: sessionId,
      conversationId: options.conversationId,
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

    return toPublicSession(session);
  }

  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const sessionId = `ses_${randomBytes(8).toString("hex")}`;
    const projectName = options.projectName ?? basename(options.projectPath);

    const args: string[] = [];
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    const proc = nodePty.spawn("claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.projectPath,
      env: process.env as Record<string, string>,
    });

    const session: InternalSession = {
      id: sessionId,
      conversationId: "",
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

    proc.onData((data: string) => {
      this.handleOutput(sessionId, data);
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.handleExit(sessionId, exitCode);
    });

    return toPublicSession(session);
  }

  sendInput(sessionId: string, input: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "completed" || session.status === "failed") {
      throw new Error(`Session already ${session.status}: ${sessionId}`);
    }
    session.process.write(`${input}\r`);
    session.promptCount++;
    return session.promptCount;
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.kill();
  }

  getOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.outputBuffer.toString("utf-8");
  }

  getSession(sessionId: string): ManagedSession | null {
    const session = this.sessions.get(sessionId);
    return session ? toPublicSession(session) : null;
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

    // Ring buffer pruning
    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.subarray(
        session.outputBuffer.length - OUTPUT_BUFFER_MAX,
      );
    }

    session.lastOutput = stripAnsi(data);
    this.onOutput?.(sessionId, data);
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.completedAt = new Date();
    session.status = exitCode === 0 ? "completed" : "failed";
    this.onStatusChange?.(toPublicSession(session));
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    conversationId: s.conversationId,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    promptCount: s.promptCount,
    lastOutput: s.lastOutput,
  };
}

// Strip ANSI escape sequences for clean text preview
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
