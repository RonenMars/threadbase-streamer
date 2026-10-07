import { randomUUID } from "crypto";
import { basename } from "path";
import { clearCopilotExeCache, resolveCopilotExe } from "./platform";
import { COPILOT_PROVIDER } from "./providers";
import {
  createScreen,
  type InternalSession,
  loadPty,
  PTY_COLS,
  PTY_ROWS,
  type ReplayLines,
  readReplayLines,
  refuseIfDisposed,
  stripAnsi,
} from "./pty-shared";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "./types";

const OUTPUT_BUFFER_MAX = 65536;
const INPUT_HISTORY_MAX = 50;

/**
 * Copilot's live-v1 adapter: native explicit IDs/resume, raw terminal I/O.
 * No trust bypass, Claude flags, TUI scraping, or borrowed transcript watcher.
 * Without a captured readiness/turn signal we retain `running` until exit or
 * hold. The start route returns the attachable session without waiting for a
 * semantic readiness event; users handle trust/auth prompts in the terminal.
 */
export class CopilotPtyRunner implements SessionRunner {
  private sessions = new Map<string, InternalSession>();
  private startPromises = new Map<string, Promise<ManagedSession>>();
  private disposed = false;

  constructor(private options: PTYManagerOptions = {}) {}

  async start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    refuseIfDisposed(this.disposed);
    const existing = this.sessions.get(sessionId);
    if (existing) return toPublicSession(existing);
    const inFlight = this.startPromises.get(sessionId);
    if (inFlight) return inFlight;
    const promise = this.launch(
      sessionId,
      [`--resume=${options.resumeId ?? sessionId}`],
      options,
    ).finally(() => this.startPromises.delete(sessionId));
    this.startPromises.set(sessionId, promise);
    return promise;
  }

  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    refuseIfDisposed(this.disposed);
    const id = randomUUID();
    return this.launch(id, [`--session-id=${id}`], options);
  }

  private async launch(
    sessionId: string,
    sessionArgs: string[],
    options: StartSessionOptions,
  ): Promise<ManagedSession> {
    const nodePty = await loadPty();
    refuseIfDisposed(this.disposed);
    const args = ["-C", options.projectPath, ...sessionArgs];
    if (options.model) args.push("--model", options.model);
    let proc: ReturnType<typeof nodePty.spawn>;
    try {
      proc = nodePty.spawn(resolveCopilotExe(), args, {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: options.projectPath,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      clearCopilotExeCache();
      throw err;
    }
    const session: InternalSession = {
      id: sessionId,
      provider: COPILOT_PROVIDER,
      projectPath: options.projectPath,
      projectName: options.projectName ?? basename(options.projectPath),
      branch: options.branch ?? "",
      status: "running",
      statusSource: "spawn",
      statusUpdatedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
      promptCount: 0,
      lastOutput: "",
      process: proc,
      outputBuffer: Buffer.alloc(0),
      screen: createScreen(),
      inputHistory: [],
    };
    this.sessions.set(sessionId, session);
    proc.onData((data: string) => {
      if (this.sessions.get(sessionId) !== session) return;
      session.outputBuffer = Buffer.concat([session.outputBuffer, Buffer.from(data)]);
      if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
        session.outputBuffer = session.outputBuffer.subarray(-OUTPUT_BUFFER_MAX);
      }
      session.screen.write(data);
      session.lastOutput = stripAnsi(data);
      session.lastActivityAt = new Date();
      this.options.onOutput?.(sessionId, data);
    });
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      if (this.sessions.get(sessionId) !== session) return;
      if (exitCode !== 0 && Date.now() - session.startedAt.getTime() < 2000) {
        session.failureCode = "instant_exit";
        session.failureReason = `Copilot process exited immediately (code ${exitCode}).`;
      }
      this.finish(session, "process-exit");
    });
    return toPublicSession(session);
  }

  private requireSession(id: string): InternalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  sendInput(id: string, input: string): number {
    const session = this.requireSession(id);
    session.process.write(`${input}\r`);
    const ts = Date.now();
    session.inputHistory.push({ text: input, ts });
    if (session.inputHistory.length > INPUT_HISTORY_MAX) session.inputHistory.shift();
    session.lastActivityAt = new Date(ts);
    session.promptCount++;
    this.options.onUserMessage?.(id, input, ts);
    return session.promptCount;
  }

  sendKeys(id: string, keys: string): void {
    this.sendRawKeys(id, keys);
  }

  sendRawKeys(id: string, keys: string): void {
    const session = this.requireSession(id);
    session.process.write(keys);
    session.lastActivityAt = new Date();
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
      return;
    try {
      session.process.resize(cols, rows);
      session.screen.resize(cols, rows);
    } catch {
      /* An exit can race the resize. */
    }
  }

  cancel(id: string): void {
    this.requireSession(id).process.kill("SIGINT");
  }
  killPid(pid: number): void {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already gone. */
    }
  }

  putOnHold(id: string, signal: NodeJS.Signals = "SIGINT"): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Remove before kill so a synchronous/late exit cannot finalize it twice.
    this.finish(session, "shutdown");
    try {
      session.process.kill(signal);
    } catch {
      /* Already gone. */
    }
  }

  private finish(session: InternalSession, source: "shutdown" | "process-exit"): void {
    this.sessions.delete(session.id);
    session.status = "idle";
    session.statusSource = source;
    session.statusUpdatedAt = new Date();
    session.completedAt = new Date();
    session.screen.dispose();
    this.options.onStatusChange?.(toPublicSession(session));
  }

  getOutput(id: string): string {
    return this.requireSession(id).outputBuffer.toString("utf-8");
  }
  async getOutputLines(id: string, maxLines: number): Promise<string[]> {
    const session = this.requireSession(id);
    await new Promise<void>((resolve) => session.screen.write("", resolve));
    const buffer = session.screen.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++)
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    while (lines.at(-1) === "") lines.pop();
    return lines.slice(-maxLines);
  }
  async getReplayLines(id: string, maxLines: number): Promise<ReplayLines> {
    return readReplayLines(this.requireSession(id).screen, maxLines);
  }
  getInputHistory(id: string): UserMessage[] {
    return this.sessions.get(id)?.inputHistory ?? [];
  }
  getPid(id: string): number | null {
    return this.sessions.get(id)?.process.pid ?? null;
  }
  getSession(id: string): ManagedSession | null {
    const session = this.sessions.get(id);
    return session ? toPublicSession(session) : null;
  }
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }
  listSessions(): ManagedSession[] {
    return [...this.sessions.values()].map(toPublicSession);
  }
  dispose(): void {
    this.disposed = true;
    for (const session of [...this.sessions.values()]) this.putOnHold(session.id, "SIGTERM");
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    provider: COPILOT_PROVIDER,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    promptCount: s.promptCount,
    lastOutput: s.lastOutput,
    statusSource: s.statusSource,
    statusUpdatedAt: s.statusUpdatedAt,
    lastActivityAt: s.lastActivityAt,
    ...(s.failureCode != null && { failureCode: s.failureCode }),
    ...(s.failureReason != null && { failureReason: s.failureReason }),
    subStatus: null,
  };
}
