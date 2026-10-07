import { randomUUID } from "crypto";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
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
  StatusSource,
  UserMessage,
} from "./types";
import { debounce } from "./utils/debounce";

const OUTPUT_BUFFER_MAX = 65536;
const INPUT_HISTORY_MAX = 50;
const QUIET_DETECT_MS = 500;
const COPILOT_SUBMIT_STALE_MS = 2_000;
// Copilot's turn signal (verified on Copilot CLI 1.0.92): while a turn runs the
// bottom row reads `<spinner> Working ...`, repainted about every 90ms. The
// terminal title only names the session. The row is painted with cursor moves,
// so the word never arrives whole in a chunk and is read off the rendered
// screen; and only off that row, because a reply can say "Working" too.
const COPILOT_BUSY_ROW = /^\s*\S\s+Working\b/;
// The bottom row while idle with an empty compose box. Typing swaps it for
// compose hints, so it marks the end of boot and nothing else: mid-session,
// idle is the busy row being absent.
const COPILOT_IDLE_FOOTER = "open sidebar";
// A permission card or an ask_user form replaces the status row, so the busy
// row is gone while Copilot waits on the user. Their footers sit just above the
// bottom border, and the turn stays open while either shows.
const COPILOT_CARD_FOOTERS = [/enter to select\b.*\besc to cancel/, /enter accept\b.*\besc cancel/];
const COPILOT_FOOTER_ROWS = 3;

/** The last rows Copilot painted, bottom row first. */
function bottomRows(session: InternalSession): string[] {
  const buf = session.screen.buffer.active;
  const rows: string[] = [];
  for (let y = session.screen.rows - 1; y >= 0 && rows.length < COPILOT_FOOTER_ROWS; y--) {
    const row = buf.getLine(buf.baseY + y)?.translateToString(true) ?? "";
    if (rows.length > 0 || row.trim() !== "") rows.push(row);
  }
  return rows;
}

/**
 * Copilot's live-v1 adapter: native explicit IDs/resume, raw terminal I/O.
 * No trust bypass, Claude flags, or borrowed transcript watcher. The start
 * route returns the attachable session without waiting for readiness; users
 * handle trust/auth prompts and permission cards in the terminal.
 *
 * Status is read off the rendered screen: boot settles on the first idle
 * footer, a turn is `running` while the status row shows `Working`, and it ends
 * once the output is quiet with neither that row nor a card footer on screen.
 */
export class CopilotPtyRunner implements SessionRunner {
  private sessions = new Map<string, InternalSession>();
  private startPromises = new Map<string, Promise<ManagedSession>>();
  private disposed = false;
  private log: Logger;
  // Sessions that have not settled once yet.
  private booting = new Set<string>();
  // Sessions whose current turn has shown the busy row.
  private turnBusy = new Set<string>();
  // When the last prompt was written, until that turn settles.
  private submittedAt = new Map<string, number>();
  private quietCheckers = new Map<string, ReturnType<typeof debounce<[]>>>();
  private submitWatchTimers = new Map<string, NodeJS.Timeout>();

  constructor(private options: PTYManagerOptions = {}) {
    this.log = options.logger ?? getLogger();
  }

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
    this.booting.add(sessionId);
    const quiet = debounce(() => this.detectQuiet(session), QUIET_DETECT_MS);
    this.quietCheckers.set(sessionId, quiet);
    proc.onData((data: string) => {
      if (this.sessions.get(sessionId) !== session) return;
      session.outputBuffer = Buffer.concat([session.outputBuffer, Buffer.from(data)]);
      if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
        session.outputBuffer = session.outputBuffer.subarray(-OUTPUT_BUFFER_MAX);
      }
      // The spinner repaints faster than the quiet check, so the busy row is
      // only ever seen by looking as each chunk lands.
      session.screen.write(data, () => this.detectBusy(session));
      session.lastOutput = stripAnsi(data);
      session.lastActivityAt = new Date();
      this.options.onOutput?.(sessionId, data);
      quiet();
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

  private detectBusy(session: InternalSession): void {
    if (this.sessions.get(session.id) !== session) return;
    if (!COPILOT_BUSY_ROW.test(bottomRows(session)[0] ?? "")) return;
    this.turnBusy.add(session.id);
    // A turn nobody announced: started from the terminal, or one whose busy row
    // landed after submit-stale had already settled it on a guess.
    if (session.status === "waiting_input") this.setRunning(session, "turn-signal");
  }

  private detectQuiet(session: InternalSession): void {
    if (this.sessions.get(session.id) !== session) return;
    // Flush pending writes first: xterm parses on a later tick.
    session.screen.write("", () => this.settleIfIdle(session));
  }

  private settleIfIdle(session: InternalSession): void {
    const id = session.id;
    if (this.sessions.get(id) !== session || session.status !== "running") return;
    const rows = bottomRows(session);
    if (COPILOT_BUSY_ROW.test(rows[0] ?? "")) return;
    // Copilot is waiting on the user, not finished.
    if (rows.some((row) => COPILOT_CARD_FOOTERS.some((footer) => footer.test(row)))) return;
    if (this.turnBusy.has(id)) {
      this.markReady(session, "turn-signal", "turn-signal:busy-row-cleared");
    } else if (this.booting.has(id) && rows[0]?.includes(COPILOT_IDLE_FOOTER)) {
      this.markReady(session, "prompt-marker", "boot:idle-footer");
    } else if (Date.now() - (this.submittedAt.get(id) ?? Infinity) >= COPILOT_SUBMIT_STALE_MS) {
      // A submit that started no turn (a slash command, an empty line).
      this.markReady(session, "quiet-fallback", "submit-stale");
    }
  }

  private setRunning(session: InternalSession, source: StatusSource): void {
    session.status = "running";
    session.statusSource = source;
    session.statusUpdatedAt = new Date();
    this.options.onStatusChange?.(toPublicSession(session));
  }

  private markReady(session: InternalSession, source: StatusSource, reason: string): void {
    const id = session.id;
    this.turnBusy.delete(id);
    this.submittedAt.delete(id);
    this.clearSubmitWatch(id);
    session.status = "waiting_input";
    session.statusSource = source;
    session.statusUpdatedAt = new Date();
    this.log.info(`[copilot.ready] ${id.slice(0, 8)} ${reason}`, {
      event: "copilot.ready",
      sessionId: id,
      reason,
    });
    this.options.onStatusChange?.(toPublicSession(session));
    if (this.booting.delete(id)) this.options.onReady?.(toPublicSession(session));
  }

  private clearSubmitWatch(id: string): void {
    const timer = this.submitWatchTimers.get(id);
    if (timer) clearTimeout(timer);
    this.submitWatchTimers.delete(id);
  }

  sendInput(id: string, input: string): number {
    const session = this.requireSession(id);
    session.process.write(`${input}\r`);
    if (session.status === "waiting_input") this.setRunning(session, "user-input");
    this.submittedAt.set(id, Date.now());
    this.clearSubmitWatch(id);
    const watch = setTimeout(() => {
      this.submitWatchTimers.delete(id);
      // The turn started; its end is read off the screen once it goes quiet.
      if (!this.turnBusy.has(id)) this.settleIfIdle(session);
    }, COPILOT_SUBMIT_STALE_MS);
    watch.unref?.();
    this.submitWatchTimers.set(id, watch);
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
    this.quietCheckers.get(session.id)?.cancel();
    this.quietCheckers.delete(session.id);
    this.clearSubmitWatch(session.id);
    this.booting.delete(session.id);
    this.turnBusy.delete(session.id);
    this.submittedAt.delete(session.id);
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
