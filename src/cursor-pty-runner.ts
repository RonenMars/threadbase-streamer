import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { clearCursorExeCache, resolveCursorExe } from "./platform";
import { CURSOR_CLI_PROVIDER } from "./providers";
import {
  createScreen,
  type InternalSession,
  loadPty,
  PTY_COLS,
  PTY_ROWS,
  stripAnsi,
} from "./pty-shared";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  StatusSource,
  UserMessage,
} from "./types";
import { debounce } from "./utils/debounce";

const OUTPUT_BUFFER_MAX = 65536;
const INPUT_HISTORY_MAX = 50;
const QUIET_DETECT_MS = 500;
const CURSOR_READY_FALLBACK_MS = 8_000;
const SUBMIT_BYTES = "\r";
const CURSOR_SUBMIT_DELAY_MS = 16;
const CURSOR_SUBMIT_MAX_WAIT_MS = 500;
const CURSOR_SUBMIT_STALE_MS = 2_000;

/**
 * Cursor CLI (`agent`) PTY runner.
 *
 * Spawn/resume flags come from the published CLI: `--workspace`, `--trust`
 * (headless, skip the workspace-trust prompt), `--resume=<id>`, positional
 * opening prompt. TUI detection is deliberately generic: we have no verified
 * Ready/gate scrape, so boot settles on quiet or the 8s fallback, and a turn
 * returns to waiting_input after submit-stale silence.
 */
export class CursorPtyRunner implements SessionRunner {
  private sessions = new Map<string, InternalSession>();
  private onOutput: PTYManagerOptions["onOutput"];
  private onStatusChange: PTYManagerOptions["onStatusChange"];
  private onReady: PTYManagerOptions["onReady"];
  private onUserMessage: PTYManagerOptions["onUserMessage"];
  private log: Logger;
  private pendingReady = new Set<string>();
  private queuedInputs = new Map<string, string[]>();
  private quietCheckers = new Map<string, ReturnType<typeof debounce<[]>>>();
  private readyFallbackTimers = new Map<string, NodeJS.Timeout>();
  private submitWatchTimers = new Map<string, NodeJS.Timeout>();
  private lastChunkAt = new Map<string, number>();
  private startPromises = new Map<string, Promise<ManagedSession>>();

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
    this.onReady = options.onReady;
    this.onUserMessage = options.onUserMessage;
    this.log = options.logger ?? getLogger();
  }

  async start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return toPublicSession(existing);

    const inFlight = this.startPromises.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.doStart(sessionId, options).finally(() => {
      this.startPromises.delete(sessionId);
    });
    this.startPromises.set(sessionId, promise);
    return promise;
  }

  private async doStart(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    const resumeId = options.resumeId ?? sessionId;
    return this.launch(
      sessionId,
      this.baseArgs(options.projectPath, [`--resume=${resumeId}`]),
      options,
    );
  }

  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const sessionId = randomUUID();
    const args = this.baseArgs(options.projectPath);
    if (options.systemPrompt) args.push(options.systemPrompt);
    return this.launch(sessionId, args, options);
  }

  private baseArgs(projectPath: string, extra: string[] = []): string[] {
    // `--trust` is headless-only and skips the workspace prompt; it is not
    // permission-gate scraping. `--workspace` is the documented project root.
    return ["--workspace", projectPath, "--trust", ...extra];
  }

  private async launch(
    sessionId: string,
    args: string[],
    options: { projectPath: string; projectName?: string; branch?: string },
  ): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const projectName = options.projectName ?? basename(options.projectPath);

    let proc: ReturnType<typeof nodePty.spawn>;
    try {
      proc = nodePty.spawn(resolveCursorExe(), args, {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: options.projectPath,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      clearCursorExeCache();
      throw err;
    }

    const session: InternalSession = {
      id: sessionId,
      provider: CURSOR_CLI_PROVIDER,
      projectPath: options.projectPath,
      projectName,
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
    this.pendingReady.add(sessionId);
    this.armReadyFallback(sessionId);

    proc.onData((data: string) => {
      this.handleOutput(sessionId, data);
    });
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      this.pendingReady.delete(sessionId);
      this.handleExit(sessionId, exitCode);
    });

    return toPublicSession(session);
  }

  private armReadyFallback(sessionId: string): void {
    const timer = setTimeout(() => {
      this.readyFallbackTimers.delete(sessionId);
      this.tryReadyFallback(sessionId);
    }, CURSOR_READY_FALLBACK_MS);
    timer.unref?.();
    this.readyFallbackTimers.set(sessionId, timer);
  }

  private tryReadyFallback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.status !== "running" || !this.pendingReady.has(sessionId)) return;
    this.markReady(sessionId, session, "timeout-fallback", "fallback:timeout");
  }

  sendKeys(sessionId: string, keys: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    }
    if (session.status === "waiting_input") {
      session.status = "running";
      session.statusSource = "user-input";
      session.statusUpdatedAt = new Date();
      this.onStatusChange?.(toPublicSession(session));
    }
    session.process.write(keys);
    session.lastActivityAt = new Date();
  }

  sendRawKeys(sessionId: string, keys: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    session.process.write(keys);
    session.lastActivityAt = new Date();
  }

  sendInput(sessionId: string, input: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    }
    if (this.pendingReady.has(sessionId)) {
      const queue = this.queuedInputs.get(sessionId) ?? [];
      queue.push(input);
      this.queuedInputs.set(sessionId, queue);
      session.lastActivityAt = new Date();
      session.promptCount++;
      return session.promptCount;
    }
    if (session.status === "waiting_input") {
      session.status = "running";
      session.statusSource = "user-input";
      session.statusUpdatedAt = new Date();
      this.onStatusChange?.(toPublicSession(session));
    }
    this.writeSubmit(sessionId, session, input);
    session.lastActivityAt = new Date();
    session.promptCount++;
    return session.promptCount;
  }

  private writeSubmit(sessionId: string, session: InternalSession, input: string): void {
    this.recordUserMessage(session, input);
    const writeAt = Date.now();
    session.process.write(input);

    const trySubmit = () => {
      const current = this.sessions.get(sessionId);
      if (!current || current !== session) return;
      const now = Date.now();
      const lastChunk = this.lastChunkAt.get(sessionId) ?? writeAt;
      const quiet = now - lastChunk >= CURSOR_SUBMIT_DELAY_MS;
      const timedOut = now - writeAt >= CURSOR_SUBMIT_MAX_WAIT_MS;
      if (!quiet && !timedOut) {
        setTimeout(trySubmit, CURSOR_SUBMIT_DELAY_MS);
        return;
      }
      current.process.write(SUBMIT_BYTES);
      this.armSubmitWatch(sessionId);
    };
    setTimeout(trySubmit, CURSOR_SUBMIT_DELAY_MS);
  }

  private armSubmitWatch(sessionId: string): void {
    const prev = this.submitWatchTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.submitWatchTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session?.status !== "running") return;
      if (session.statusSource !== "user-input") return;
      this.markReady(sessionId, session, "quiet-fallback", "submit-stale");
    }, CURSOR_SUBMIT_STALE_MS);
    timer.unref?.();
    this.submitWatchTimers.set(sessionId, timer);
  }

  private flushQueuedInputs(sessionId: string): void {
    if (this.pendingReady.has(sessionId)) return;
    const queue = this.queuedInputs.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.queuedInputs.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    queue.forEach((input, i) => {
      const writeAt = i * CURSOR_SUBMIT_DELAY_MS * 2;
      const fire = () => {
        const current = this.sessions.get(sessionId);
        if (!current || current !== session) return;
        this.writeSubmit(sessionId, session, input);
      };
      if (writeAt === 0) fire();
      else setTimeout(fire, writeAt);
    });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session?.process) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    try {
      session.process.resize(cols, rows);
      session.screen.resize(cols, rows);
    } catch (err) {
      this.log.debug(`[pty.resize.failed] ${sessionId.slice(0, 8)}`, {
        event: "pty.resize_failed",
        sessionId,
        err,
      });
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

  putOnHold(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pendingReady.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.clearSessionDetectors(sessionId);
    try {
      session.process.kill("SIGINT");
    } catch {
      // already dead
    }
    session.status = "idle";
    session.statusSource = "shutdown";
    session.statusUpdatedAt = new Date();
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

  async getOutputLines(sessionId: string, maxLines: number): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await new Promise<void>((resolve) => session.screen.write("", () => resolve()));

    const buf = session.screen.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.slice(-maxLines);
  }

  getInputHistory(sessionId: string): UserMessage[] {
    return this.sessions.get(sessionId)?.inputHistory ?? [];
  }

  getPid(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.process?.pid ?? null;
  }

  private recordUserMessage(session: InternalSession, text: string): void {
    const ts = Date.now();
    session.inputHistory.push({ text, ts });
    if (session.inputHistory.length > INPUT_HISTORY_MAX) {
      session.inputHistory.shift();
    }
    this.onUserMessage?.(session.id, text, ts);
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
    for (const sessionId of Array.from(this.quietCheckers.keys())) {
      this.clearSessionDetectors(sessionId);
    }
    for (const timer of this.readyFallbackTimers.values()) clearTimeout(timer);
    for (const timer of this.submitWatchTimers.values()) clearTimeout(timer);
    this.sessions.clear();
    this.pendingReady.clear();
    this.queuedInputs.clear();
    this.quietCheckers.clear();
    this.readyFallbackTimers.clear();
    this.submitWatchTimers.clear();
    this.lastChunkAt.clear();
  }

  private handleOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.lastChunkAt.set(sessionId, Date.now());

    const chunk = Buffer.from(data, "utf-8");
    session.outputBuffer = Buffer.concat([session.outputBuffer, chunk]);
    if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      session.outputBuffer = session.outputBuffer.subarray(
        session.outputBuffer.length - OUTPUT_BUFFER_MAX,
      );
    }

    session.screen.write(data);
    session.lastOutput = stripAnsi(data);
    this.onOutput?.(sessionId, data);

    let quiet = this.quietCheckers.get(sessionId);
    if (!quiet) {
      quiet = debounce(() => {
        this.detectQuiet(sessionId);
      }, QUIET_DETECT_MS);
      this.quietCheckers.set(sessionId, quiet);
    }
    quiet();
  }

  private detectQuiet(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "idle") return;
    if (this.pendingReady.has(sessionId)) {
      this.markReady(sessionId, session, "quiet-fallback", "quiet:boot");
    }
  }

  private markReady(
    sessionId: string,
    session: InternalSession,
    source: StatusSource,
    reason: string,
  ): void {
    session.lastActivityAt = new Date();
    session.status = "waiting_input";
    session.statusSource = source;
    session.statusUpdatedAt = new Date();
    this.log.info(`[cursor.ready] ${sessionId.slice(0, 8)} ${reason}`, {
      event: "cursor.ready",
      sessionId,
      reason,
    });
    this.onStatusChange?.(toPublicSession(session));
    const wasPending = this.pendingReady.delete(sessionId);
    const submitWatch = this.submitWatchTimers.get(sessionId);
    if (submitWatch) clearTimeout(submitWatch);
    this.submitWatchTimers.delete(sessionId);
    if (wasPending) {
      const timer = this.readyFallbackTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.readyFallbackTimers.delete(sessionId);
      this.flushQueuedInputs(sessionId);
      this.onReady?.(toPublicSession(session));
    }
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.completedAt = new Date();
    session.status = "idle";
    session.statusSource = "process-exit";
    session.statusUpdatedAt = new Date();

    const elapsedMs = session.completedAt.getTime() - session.startedAt.getTime();
    if (exitCode !== 0 && elapsedMs < 2000 && session.lastOutput === "") {
      if (!existsSync(session.projectPath)) {
        session.failureReason = `Project directory not found: ${session.projectPath}`;
      } else {
        session.failureReason = `Cursor agent process exited immediately (code ${exitCode}).`;
      }
    }

    this.onStatusChange?.(toPublicSession(session));
    session.screen.dispose();
    this.sessions.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.clearSessionDetectors(sessionId);
  }

  private clearSessionDetectors(sessionId: string): void {
    this.quietCheckers.get(sessionId)?.cancel();
    this.quietCheckers.delete(sessionId);
    const ready = this.readyFallbackTimers.get(sessionId);
    if (ready) clearTimeout(ready);
    this.readyFallbackTimers.delete(sessionId);
    const watch = this.submitWatchTimers.get(sessionId);
    if (watch) clearTimeout(watch);
    this.submitWatchTimers.delete(sessionId);
    this.lastChunkAt.delete(sessionId);
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    provider: s.provider ?? CURSOR_CLI_PROVIDER,
    projectPath: s.projectPath,
    projectName: s.projectName,
    branch: s.branch,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    promptCount: s.promptCount,
    lastOutput: s.lastOutput,
    ...(s.failureReason != null && { failureReason: s.failureReason }),
    ...(s.failureCode != null && { failureCode: s.failureCode }),
    ...(s.lastActivityAt != null && { lastActivityAt: s.lastActivityAt }),
    ...(s.statusSource != null && { statusSource: s.statusSource }),
    ...(s.statusUpdatedAt != null && { statusUpdatedAt: s.statusUpdatedAt }),
    ...(s.filePath != null && { filePath: s.filePath }),
    subStatus: s.subStatus ?? null,
  };
}
