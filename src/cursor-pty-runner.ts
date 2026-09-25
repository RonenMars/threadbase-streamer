import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { clearCursorExeCache, resolveCursorExe } from "./platform";
import { CURSOR_PROVIDER } from "./providers";
import {
  createScreen,
  type InternalSession,
  loadPty,
  PTY_COLS,
  PTY_ROWS,
  refuseIfDisposed,
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
// Cursor paints nothing for ~8-11s after spawn, then enables bracketed paste
// as the compose box comes up (Cursor Agent 2026.09.23, fresh and --resume).
// Until then the PTY is still in cooked mode: input is echoed by the tty and
// the \r is eaten as a line ending, so the text lands in the compose box and is
// never submitted. Boot settles only once this has been painted.
const CURSOR_BOOT_MARKER = "\x1b[?2004h";
// Backstop for a Cursor that stops emitting the marker: settle anyway.
const CURSOR_READY_MAX_WAIT_MS = 60_000;
const SUBMIT_BYTES = "\r";
/** Ctrl+U — kill the compose line before pasting the next turn. */
const CLEAR_COMPOSE_BYTES = "\x15";
const CURSOR_SUBMIT_DELAY_MS = 16;
const CURSOR_SUBMIT_MAX_WAIT_MS = 500;
const CURSOR_SUBMIT_STALE_MS = 2_000;
// Cursor's turn signal (verified on Cursor Agent 2026.09.23): while a turn runs
// the compose box carries this hint beside a repainting `Working` spinner, and
// it is gone the moment the turn ends. Without it every turn settled through
// submit-stale 2s after the submit, as Cursor started (#962).
const CURSOR_TURN_BUSY_TEXT = "ctrl+c to stop";

/**
 * Cursor CLI (`agent`) PTY runner.
 *
 * Spawn/resume flags come from the published CLI: `--workspace`, `--trust`
 * (headless, skip the workspace-trust prompt), `--resume=<id>`, positional
 * opening prompt. Boot settles on quiet or the 8s fallback, but only after the
 * compose box has painted (CURSOR_BOOT_MARKER). A turn returns to waiting_input
 * once its busy hint (CURSOR_TURN_BUSY_TEXT) has come and gone; submit-stale
 * recovers only a submit that never showed it.
 *
 * Input clears the compose line (`Ctrl+U`) before writing text — Cursor leaves
 * the previous prompt editable, and a bare write would concatenate turns.
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
  // Sessions whose current turn has shown CURSOR_TURN_BUSY_TEXT.
  private turnBusy = new Set<string>();
  private lastChunkAt = new Map<string, number>();
  private startPromises = new Map<string, Promise<ManagedSession>>();
  private disposed = false;

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
    refuseIfDisposed(this.disposed);
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
      provider: CURSOR_PROVIDER,
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
    if (
      !session.outputBuffer.includes(CURSOR_BOOT_MARKER) &&
      Date.now() - session.startedAt.getTime() < CURSOR_READY_MAX_WAIT_MS
    ) {
      this.armReadyFallback(sessionId);
      return;
    }
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
    this.turnBusy.delete(sessionId);
    this.writeSubmit(sessionId, session, input);
    session.lastActivityAt = new Date();
    session.promptCount++;
    return session.promptCount;
  }

  private writeSubmit(
    sessionId: string,
    session: InternalSession,
    input: string,
    onSubmitted?: () => void,
  ): void {
    this.recordUserMessage(session, input);
    let writeAt = Date.now();
    // Cursor's TUI leaves the previous prompt in the compose box after a turn
    // whose \r beat the echo (see trySubmit). Writing the next input on top
    // concatenates ("Commit it" + "Yes, commit it" → "Commit itYes, commit it")
    // and that smashed string is what lands in agent-transcripts. Clear the line
    // first (same kill-line byte readline uses), then write the new text, then
    // \r once Cursor has echoed it and gone quiet.
    // Ctrl+U needs a read of its own: Cursor discards a whole read that starts
    // with it, so "\x15" + text in one write never reached the compose box and
    // every prompt was silently dropped.
    session.process.write(CLEAR_COMPOSE_BYTES);

    const writeText = () => {
      if (this.sessions.get(sessionId) !== session) return;
      session.process.write(input);
      writeAt = Date.now();
      setTimeout(trySubmit, CURSOR_SUBMIT_DELAY_MS);
    };
    const trySubmit = () => {
      const current = this.sessions.get(sessionId);
      if (!current || current !== session) return;
      const now = Date.now();
      const lastChunk = this.lastChunkAt.get(sessionId) ?? 0;
      // Quiet only counts once Cursor has repainted the text (~90ms). A \r that
      // beats the echo still runs the turn but leaves the prompt in the compose
      // box, which hides CURSOR_TURN_BUSY_TEXT and prefixes the next turn.
      const quiet = lastChunk > writeAt && now - lastChunk >= CURSOR_SUBMIT_DELAY_MS;
      const timedOut = now - writeAt >= CURSOR_SUBMIT_MAX_WAIT_MS;
      if (!quiet && !timedOut) {
        setTimeout(trySubmit, CURSOR_SUBMIT_DELAY_MS);
        return;
      }
      current.process.write(SUBMIT_BYTES);
      this.armSubmitWatch(sessionId);
      onSubmitted?.();
    };
    setTimeout(writeText, CURSOR_SUBMIT_DELAY_MS);
  }

  private armSubmitWatch(sessionId: string): void {
    const prev = this.submitWatchTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.submitWatchTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session?.status !== "running") return;
      if (session.statusSource !== "user-input") return;
      // The turn started; its end is read off the screen in detectQuiet.
      if (this.turnBusy.has(sessionId)) return;
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
    // One at a time: a submit waits on Cursor's echo, so the next clear must
    // not start before the previous \r.
    const fire = () => {
      const input = queue.shift();
      if (input === undefined || this.sessions.get(sessionId) !== session) return;
      this.writeSubmit(sessionId, session, input, () => setTimeout(fire, CURSOR_SUBMIT_DELAY_MS));
    };
    fire();
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

  putOnHold(sessionId: string, signal: NodeJS.Signals = "SIGINT"): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pendingReady.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.clearSessionDetectors(sessionId);
    try {
      session.process.kill(signal);
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
    this.disposed = true;
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
    this.turnBusy.clear();
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
    if (session.status === "running" && session.lastOutput.includes(CURSOR_TURN_BUSY_TEXT)) {
      this.turnBusy.add(sessionId);
    }
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
      if (session.outputBuffer.includes(CURSOR_BOOT_MARKER)) {
        this.markReady(sessionId, session, "quiet-fallback", "quiet:boot");
      }
      return;
    }
    // The spinner repaints every ~250ms while a turn runs, so quiet usually
    // means it ended — but only the hint leaving the screen proves it.
    if (session.status !== "running" || !this.turnBusy.has(sessionId)) return;
    this.getOutputLines(sessionId, PTY_ROWS)
      .then((lines) => {
        if (session.status !== "running" || !this.turnBusy.has(sessionId)) return;
        if (lines.some((l) => l.includes(CURSOR_TURN_BUSY_TEXT))) return;
        this.turnBusy.delete(sessionId);
        this.markReady(sessionId, session, "turn-signal", "turn-signal:busy-hint-cleared");
      })
      .catch((err) => {
        this.log.warn("[cursor.turn_check] failed", {
          event: "cursor.turn_check_failed",
          sessionId,
          err,
        });
      });
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
    this.turnBusy.delete(sessionId);
    this.lastChunkAt.delete(sessionId);
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    provider: s.provider ?? CURSOR_PROVIDER,
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
