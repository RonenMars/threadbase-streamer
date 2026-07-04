import { Terminal } from "@xterm/headless";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { resolveCodexExe } from "./platform";
import { CODEX_CLI_PROVIDER } from "./providers";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
} from "./types";

const OUTPUT_BUFFER_MAX = 65536;

// PTY geometry — same as pty-manager.ts. The headless render terminal
// (session.screen) MUST match these so Codex's absolute cursor moves
// (ESC[<row>;<col>H) resolve to the same screen coordinates the real TUI is
// painting against.
const PTY_COLS = 120;
const PTY_ROWS = 40;
const SCREEN_SCROLLBACK = 1000;

// Phase 0 findings (live PTY probe, not spec): Codex's status bar renders
// "Ready" (case-sensitive) once the session is actually usable, e.g.
// "gpt-5.5 medium · /path · gpt-5.5 · medium · Ready · Wo…". Two other
// observed states — "Starting" (MCP servers loading; the compose box `›`
// prefix is ALREADY visible here, so `›` alone is not a valid readiness
// signal) and "Working" (mid-turn) — must NOT be treated as ready.
export const CODEX_PROMPT_READY_TEXT = "Ready";

// Phase 0: a brand-new `--cd <dir>` shows a blocking directory-trust gate on
// first-ever launch — a rendered screen containing this text, with options
// "1. Yes, continue" / "2. No, quit" and a "Press enter to continue" footer.
// Does not appear on `codex resume` or on later launches in an
// already-trusted directory (Codex persists trust in ~/.codex/config.toml).
export const CODEX_TRUST_GATE_REGEX = /trust the contents/i;

const SUBMIT_BYTES = "\r";

// Delay between the input write and the submit \r. Same value as Claude's
// SUBMIT_DELAY_MS (pty-manager.ts) — no bracketed-paste wrap needed for
// Codex (Phase 0: plain keystrokes are accepted directly into the compose
// box), but we still yield an event-loop tick before Enter for consistency
// with the observed-stable Claude pattern.
const CODEX_SUBMIT_DELAY_MS = 16;

function digestBytes(s: string): string {
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
  // Headless terminal rendering the raw PTY stream into a real screen grid —
  // same rationale as pty-manager.ts: Codex's absolute-cursor repaints
  // scramble raw byte order, so readiness/trust-gate detection reads the
  // rendered screen, not the raw chunk.
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

export class CodexPtyRunner implements SessionRunner {
  private sessions = new Map<string, InternalSession>();
  private onOutput: PTYManagerOptions["onOutput"];
  private onStatusChange: PTYManagerOptions["onStatusChange"];
  private onReady: PTYManagerOptions["onReady"];
  // Accepted for shape-compatibility with PTYManagerOptions; Codex has no
  // detected equivalent yet (Phase 0) — never invoked.
  private onPermissionChange: PTYManagerOptions["onPermissionChange"];
  private onLiveQuestion: PTYManagerOptions["onLiveQuestion"];
  private onLiveQuestionGone: PTYManagerOptions["onLiveQuestionGone"];
  private log: Logger;
  // Tracks sessions whose PTY has spawned but Codex hasn't yet reached its
  // "Ready" status bar — i.e. onReady hasn't fired.
  private pendingReady = new Set<string>();
  // Inputs received via sendInput() while the session was still pendingReady.
  // Flushed in arrival order once Codex reaches Ready.
  private queuedInputs = new Map<string, string[]>();
  // Per-session debounce so the directory-trust gate's \r is only written once.
  private trustGateAnswered = new Set<string>();
  // In-flight start()/startFresh() calls keyed by sessionId. A second
  // concurrent resume for the same session (double-tap, client retry) awaits
  // the first call's promise instead of spawning a duplicate PTY (CRITICAL #3).
  private startPromises = new Map<string, Promise<ManagedSession>>();

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
    this.onReady = options.onReady;
    this.onPermissionChange = options.onPermissionChange;
    this.onLiveQuestion = options.onLiveQuestion;
    this.onLiveQuestionGone = options.onLiveQuestionGone;
    this.log = options.logger ?? getLogger("codex-pty");
  }

  // Resume an existing Codex session. sessionId is the Codex-persisted
  // session_meta.payload.id (Phase 0, Section 8) — Codex has no fresh-session
  // equivalent of --session-id, so start() always means "resume".
  async start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    // Guard the check-then-spawn: a second concurrent resume for the same
    // sessionId must not race past both checks and spawn a second PTY. See
    // PTYManager.start() for the identical pattern (CRITICAL #3).
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
    const nodePty = await loadPty();
    const projectName = options.projectName ?? basename(options.projectPath);

    const proc = nodePty.spawn(
      resolveCodexExe(),
      ["resume", sessionId, "--cd", options.projectPath, "--no-alt-screen"],
      {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: options.projectPath,
        env: process.env as Record<string, string>,
      },
    );

    const session: InternalSession = {
      id: sessionId,
      provider: CODEX_CLI_PROVIDER,
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

  // Start a brand-new Codex session. Codex has no --session-id equivalent for
  // a fresh launch — it assigns its own id, discovered later (Task 3's
  // binding logic). This runner generates a local placeholder id for the
  // ManagedSession handle only.
  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const sessionId = randomUUID();
    const projectName = options.projectName ?? basename(options.projectPath);

    // Codex CLI has no `--system-prompt` flag (unlike Claude). Its only
    // launch-time injection point is the positional `[PROMPT]` argument, which
    // Codex processes as the opening turn. Pass the server-built prompt
    // (default + browse-root boundary + client prompt) there so the safety
    // boundary and client instructions aren't silently dropped for Codex
    // sessions. Positional arg goes last, after all `[OPTIONS]`.
    const args = ["--cd", options.projectPath, "--no-alt-screen"];
    if (options.systemPrompt) {
      args.push(options.systemPrompt);
    }

    const proc = nodePty.spawn(resolveCodexExe(), args, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: options.projectPath,
      env: process.env as Record<string, string>,
    });

    const session: InternalSession = {
      id: sessionId,
      provider: CODEX_CLI_PROVIDER,
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

  // Write raw key bytes directly to the PTY, same as PTYManager.sendKeys.
  sendKeys(sessionId: string, keys: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    }
    if (session.status === "waiting_input") {
      session.status = "running";
      this.onStatusChange?.(toPublicSession(session));
    }
    this.log.info(
      `[codex.keys.write] ${sessionId.slice(0, 8)} bytes=${keys.length} digest=${digestBytes(keys)}`,
      { event: "codex.keys_write", sessionId, byteLen: keys.length },
    );
    session.process.write(keys);
    session.lastActivityAt = new Date();
  }

  sendInput(sessionId: string, input: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "idle") {
      throw new Error(`Session is idle (no active PTY): ${sessionId}`);
    }
    // Codex hasn't reached Ready yet — queue and flush once it does. Same
    // rationale as PTYManager: writing into the raw PTY mid-boot risks the
    // startup/trust-gate UI swallowing the keystrokes.
    if (this.pendingReady.has(sessionId)) {
      const queue = this.queuedInputs.get(sessionId) ?? [];
      queue.push(input);
      this.queuedInputs.set(sessionId, queue);
      session.lastActivityAt = new Date();
      session.promptCount++;
      this.log.warn(
        `[codex.input.queued] ${sessionId.slice(0, 8)} promptCount=${session.promptCount} queueLen=${queue.length}`,
        {
          event: "codex.input_queued",
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

  // Write the input as plain bytes (no bracketed-paste wrap — Phase 0
  // confirmed Codex accepts plain keystrokes), then submit \r after a short
  // delay so Codex's TUI gets an event-loop tick to process the input first.
  private writeSubmit(
    sessionId: string,
    session: InternalSession,
    input: string,
    path: "direct" | "flush",
    promptCount: number,
  ): void {
    this.log.info(
      `[codex.input.write] ${sessionId.slice(0, 8)} promptCount=${promptCount} bytes=${input.length} digest=${digestBytes(input)}`,
      {
        event: "codex.input_write",
        sessionId,
        promptCount,
        byteLen: input.length,
        digest: digestBytes(input),
        path,
        phase: "input",
      },
    );
    session.process.write(input);
    setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current || current !== session) return;
      this.log.info(
        `[codex.input.submit] ${sessionId.slice(0, 8)} promptCount=${promptCount} digest=\\r`,
        {
          event: "codex.input_write",
          sessionId,
          promptCount,
          byteLen: SUBMIT_BYTES.length,
          digest: "\\r",
          path,
          phase: "submit",
        },
      );
      current.process.write(SUBMIT_BYTES);
    }, CODEX_SUBMIT_DELAY_MS);
  }

  // Drain any inputs sent while the session was still pendingReady, writing
  // them in arrival order now that Codex is Ready.
  private flushQueuedInputs(sessionId: string): void {
    const queue = this.queuedInputs.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.queuedInputs.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.log.info(
      `[codex.flush] ${sessionId.slice(0, 8)} flushing ${queue.length} queued input(s)`,
      {
        event: "codex.flush_queued",
        sessionId,
        queueLen: queue.length,
      },
    );
    queue.forEach((input, i) => {
      const writeAt = i * CODEX_SUBMIT_DELAY_MS * 2;
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

  // SIGINT produces a clean exitCode=0 exit (Phase 0 — confirmed).
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

  // Kill the PTY and mark the session idle. Mirrors PTYManager.putOnHold.
  putOnHold(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pendingReady.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.trustGateAnswered.delete(sessionId);
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
  // order — same flush-then-read technique as PTYManager.getOutputLines.
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
    this.pendingReady.clear();
    this.queuedInputs.clear();
    this.trustGateAnswered.clear();
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

    // Render into the headless screen so detectReady()/getOutputLines() read
    // true on-screen order — Codex paints via absolute cursor-position
    // escapes that split words across non-contiguous PTY writes (Phase 0),
    // so raw substring matching on `data` would miss things.
    session.screen.write(data);
    session.lastOutput = stripAnsi(data);

    this.onOutput?.(sessionId, data);

    this.detectReady(sessionId, session).catch((err) => {
      this.log.warn("[codex.ready_detect] failed", {
        event: "codex.ready_detect_failed",
        sessionId,
        err,
      });
    });
  }

  // Renders the session's headless screen and checks for the directory-trust
  // gate (answered once, debounced) and the "Ready" status-bar text. Only
  // transitions to waiting_input / fires onReady when the rendered status
  // line literally contains "Ready" — `›` alone (visible during "Starting")
  // is NOT a valid readiness signal (Phase 0).
  private async detectReady(sessionId: string, session: InternalSession): Promise<void> {
    if (session.status !== "running" || !this.pendingReady.has(sessionId)) return;

    const lines = await this.getOutputLines(sessionId, PTY_ROWS);
    const screenText = lines.join("\n");

    if (CODEX_TRUST_GATE_REGEX.test(screenText)) {
      if (!this.trustGateAnswered.has(sessionId)) {
        this.trustGateAnswered.add(sessionId);
        this.log.info(`[codex.trust_gate] ${sessionId.slice(0, 8)} auto-answering`, {
          event: "codex.trust_gate",
          sessionId,
        });
        session.process.write("\r");
      }
      return;
    }

    const lastNonBlank = [...lines].reverse().find((l) => l.trim() !== "") ?? "";
    if (!lastNonBlank.includes(CODEX_PROMPT_READY_TEXT)) return;

    this.markReady(sessionId, session);
  }

  private markReady(sessionId: string, session: InternalSession): void {
    session.lastActivityAt = new Date();
    session.status = "waiting_input";
    this.log.info(`[codex.ready] ${sessionId.slice(0, 8)}`, {
      event: "codex.ready",
      sessionId,
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
        session.failureReason = `Codex process exited immediately (code ${exitCode}).`;
      }
    }

    this.onStatusChange?.(toPublicSession(session));
    session.screen.dispose();
    this.sessions.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.trustGateAnswered.delete(sessionId);
  }
}

function toPublicSession(s: InternalSession): ManagedSession {
  return {
    id: s.id,
    provider: s.provider ?? CODEX_CLI_PROVIDER,
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

// Strip ANSI escape sequences for clean text preview — identical to
// pty-manager.ts's stripAnsi.
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
