import { Terminal } from "@xterm/headless";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { resolveCodexExe } from "./platform";
import { CODEX_CLI_PROVIDER } from "./providers";
import {
  type CodexGateType,
  rememberedGateDigit,
  saveGateAnswer,
} from "./services/questions/codexGateAnswers";
import type {
  ManagedSession,
  PermissionOption,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "./types";
import { debounce } from "./utils/debounce";

const OUTPUT_BUFFER_MAX = 65536;

// Cap on recorded user messages per session (drop oldest); mirrors
// pty-manager.ts INPUT_HISTORY_MAX.
const INPUT_HISTORY_MAX = 50;

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

// Codex's hooks-review gate: shown pre-boot (fresh start AND resume) whenever
// a configured hook is new/changed vs the trusted hashes in
// ~/.codex/config.toml [hooks.state]. Options "1. Review hooks" (highlighted
// default) / "2. Trust all and continue" / "3. Continue without trusting",
// with a "Press enter to confirm or esc to go back" footer. Live-probe
// verified: a digit keypress selects AND confirms instantly (no Enter).
export const CODEX_HOOKS_GATE_REGEX = /hooks need review/i;

// Re-run screen detection this long after the PTY goes quiet — a session
// blocked on a gate (or a status bar whose "Ready" got truncated) may never
// produce another chunk to trigger detection. Same value/rationale as
// pty-manager.ts QUIET_DETECT_MS. On quiet with pendingReady still set we mark
// ready anyway: the mobile client is better off inside the session watching
// live boot output than stuck on a spinner.
const QUIET_DETECT_MS = 500;

// Flat backstop from spawn: "Ready" lives at the END of a single status line
// whose prefix (dir · repo · branch · diffstats) can exceed PTY_COLS, in which
// case the marker is truncated off-screen and can NEVER match (live-probe
// verified). Must stay below server.ts START_READY_TIMEOUT_MS (10s) so the
// start request resolves 200-with-session rather than 202-pending.
const CODEX_READY_FALLBACK_MS = 8_000;

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

// Build the question card for a gate, broadcast over the existing `permission`
// WS transport (mobile already renders these as tappable cards). Real options
// keep their literal on-screen digits; the synthetic "remember" variants
// continue the numbering and are intercepted in sendKeys() — they never reach
// the PTY as-is. answerKeys mirrors `${index}\r` so old clients (index
// fallback) and new clients (answerKeys) send identical bytes.
// "1. Review hooks" is deliberately omitted: a per-hook review screen is a
// desktop affordance with no workable mobile rendering.
function gateCard(
  gate: CodexGateType,
  lines: string[],
): { prompt: string; options: PermissionOption[] } {
  if (gate === "hooks") {
    const countLine = lines.find((l) => /new or changed/i.test(l))?.trim();
    return {
      prompt: [
        "Hooks need review",
        countLine,
        "Hooks can run outside the sandbox after you trust them.",
      ]
        .filter(Boolean)
        .join(" — "),
      options: [
        { index: 2, label: "Trust all and continue", answerKeys: "2\r" },
        { index: 3, label: "Continue without trusting (hooks won't run)", answerKeys: "3\r" },
        {
          index: 4,
          label: "Trust all and continue (remember for all projects)",
          answerKeys: "4\r",
        },
        {
          index: 5,
          label: "Continue without trusting (remember for all projects)",
          answerKeys: "5\r",
        },
      ],
    };
  }
  return {
    prompt:
      lines.find((l) => CODEX_TRUST_GATE_REGEX.test(l))?.trim() ??
      "Do you trust the contents of this directory?",
    options: [
      { index: 1, label: "Yes, continue", answerKeys: "1\r" },
      { index: 2, label: "No, quit", answerKeys: "2\r" },
      { index: 3, label: "Yes, continue (remember for all projects)", answerKeys: "3\r" },
    ],
  };
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
  // Ground-truth user messages submitted to this PTY, oldest-first, capped at
  // INPUT_HISTORY_MAX. Recorded in writeSubmit(); replayed via getInputHistory().
  inputHistory: UserMessage[];
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
  // Broadcasts Codex's blocking startup gates (directory trust, hooks review)
  // as question cards; null dismisses the card once the gate leaves the screen.
  private onPermissionChange: PTYManagerOptions["onPermissionChange"];
  private onLiveQuestion: PTYManagerOptions["onLiveQuestion"];
  private onLiveQuestionGone: PTYManagerOptions["onLiveQuestionGone"];
  private onUserMessage: PTYManagerOptions["onUserMessage"];
  private log: Logger;
  // Tracks sessions whose PTY has spawned but Codex hasn't yet reached its
  // "Ready" status bar — i.e. onReady hasn't fired.
  private pendingReady = new Set<string>();
  // Inputs received via sendInput() while the session was still pendingReady.
  // Flushed in arrival order once Codex reaches Ready.
  private queuedInputs = new Map<string, string[]>();
  // Gate currently on a session's screen (card broadcast, unanswered). While
  // set, queued-input flushes are held — a flushed digit would CONFIRM a
  // dialog option — and sendKeys() intercepts remember-variant digits.
  private openGate = new Map<string, CodexGateType>();
  // `${sessionId}:${gate}` once a gate has been actioned (auto-answered or
  // card broadcast) — dedupes repaints of the same dialog.
  private gateActioned = new Set<string>();
  // Per-session trailing debounce re-armed on every chunk; on quiet, re-runs
  // screen detection so a blocked/truncated boot still reaches ready.
  private quietCheckers = new Map<string, ReturnType<typeof debounce<[]>>>();
  // Per-session flat backstop from spawn (CODEX_READY_FALLBACK_MS).
  private readyFallbackTimers = new Map<string, NodeJS.Timeout>();
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
    this.onUserMessage = options.onUserMessage;
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

  // Flat backstop: if neither the "Ready" marker nor the quiet-checker settled
  // the session within CODEX_READY_FALLBACK_MS of spawn, mark it ready anyway
  // so start requests resolve and mobile can watch the boot live. unref() so a
  // pending timer never holds the process open.
  private armReadyFallback(sessionId: string): void {
    const timer = setTimeout(() => {
      this.readyFallbackTimers.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session?.status === "running" && this.pendingReady.has(sessionId)) {
        this.markReady(sessionId, session, "fallback:timeout");
      }
    }, CODEX_READY_FALLBACK_MS);
    timer.unref?.();
    this.readyFallbackTimers.set(sessionId, timer);
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
    const gate = this.openGate.get(sessionId);
    const digit = gate ? /^([0-9])\r?$/.exec(keys)?.[1] : undefined;
    const out = gate && digit ? this.resolveGateAnswer(sessionId, gate, digit) : keys;
    this.log.info(
      `[codex.keys.write] ${sessionId.slice(0, 8)} bytes=${out.length} digest=${digestBytes(out)}`,
      { event: "codex.keys_write", sessionId, byteLen: out.length },
    );
    session.process.write(out);
    session.lastActivityAt = new Date();
  }

  // Map a gate-card digit to the PTY bytes that answer the real dialog,
  // persisting the choice when the digit was a synthetic "remember for all
  // projects" option (those numbers don't exist on the actual dialog and must
  // never reach codex). The trailing \r mobile sends is dropped: a digit alone
  // selects AND confirms (live-probe verified), and a stray Enter would land
  // on whatever screen follows.
  private resolveGateAnswer(sessionId: string, gate: CodexGateType, digit: string): string {
    let real = digit;
    let remembered = false;
    if (gate === "hooks" && digit === "4") {
      saveGateAnswer("codexHooksGate", "trust_all");
      real = "2";
      remembered = true;
    } else if (gate === "hooks" && digit === "5") {
      saveGateAnswer("codexHooksGate", "continue_untrusted");
      real = "3";
      remembered = true;
    } else if (gate === "trust" && digit === "3") {
      saveGateAnswer("codexTrustGate", "yes");
      real = "1";
      remembered = true;
    }
    this.log.info(`[codex.gate_answer] ${sessionId.slice(0, 8)} ${gate} digit=${real}`, {
      event: "codex.gate_answer",
      sessionId,
      gate,
      digit: real,
      remembered,
    });
    return real;
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
    this.recordUserMessage(session, input);
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
  // them in arrival order now that Codex is Ready. No-op while a gate dialog
  // is open (a flushed digit would confirm a dialog option) or while still
  // pendingReady (markReady drains it) — the gate-close path re-drives it for
  // the ready-with-gate-open case.
  private flushQueuedInputs(sessionId: string): void {
    if (this.openGate.has(sessionId) || this.pendingReady.has(sessionId)) return;
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
    this.clearSessionDetectors(sessionId);
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

  // Drop a session's detection state: quiet-checker, ready-fallback timer,
  // gate bookkeeping — and dismiss a still-open gate card so mobile doesn't
  // keep rendering a question for a dead PTY.
  private clearSessionDetectors(sessionId: string): void {
    this.quietCheckers.get(sessionId)?.cancel();
    this.quietCheckers.delete(sessionId);
    const timer = this.readyFallbackTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.readyFallbackTimers.delete(sessionId);
    if (this.openGate.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
    }
    this.gateActioned.delete(`${sessionId}:hooks`);
    this.gateActioned.delete(`${sessionId}:trust`);
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

  getInputHistory(sessionId: string): UserMessage[] {
    return this.sessions.get(sessionId)?.inputHistory ?? [];
  }

  // Record a submitted user message as ground truth and fire onUserMessage.
  // Called from writeSubmit (direct and flush paths) — never from sendKeys.
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
    for (const timer of this.readyFallbackTimers.values()) {
      clearTimeout(timer);
    }
    this.sessions.clear();
    this.pendingReady.clear();
    this.queuedInputs.clear();
    this.openGate.clear();
    this.gateActioned.clear();
    this.quietCheckers.clear();
    this.readyFallbackTimers.clear();
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

    this.detectScreenState(sessionId, "chunk").catch((err) => {
      this.log.warn("[codex.ready_detect] failed", {
        event: "codex.ready_detect_failed",
        sessionId,
        err,
      });
    });

    // Re-arm the quiet-checker on every chunk. A session blocked on a gate
    // dialog (or whose status-bar "Ready" is truncated off-screen) may never
    // produce the chunk that would trigger detection — re-run after
    // QUIET_DETECT_MS of silence instead.
    let quiet = this.quietCheckers.get(sessionId);
    if (!quiet) {
      quiet = debounce(() => {
        this.detectScreenState(sessionId, "quiet").catch((err) => {
          this.log.warn("[codex.ready_detect] failed", {
            event: "codex.ready_detect_failed",
            sessionId,
            err,
          });
        });
      }, QUIET_DETECT_MS);
      this.quietCheckers.set(sessionId, quiet);
    }
    quiet();
  }

  // Renders the session's headless screen and drives both detections:
  //   - Gates (directory trust, hooks review) — checked on EVERY pass,
  //     independent of pendingReady, so a gate appearing after ready is still
  //     surfaced and a gate leaving the screen closes its card.
  //   - Readiness — the "Ready" status-bar marker while pendingReady, plus the
  //     quiet path: after QUIET_DETECT_MS of PTY silence a still-pending
  //     session is marked ready anyway (`›` alone is NOT a marker — Phase 0 —
  //     but a quiet boot screen is more useful to the user live than a
  //     spinner, and "Ready" may be truncated off the 120-col status bar).
  private async detectScreenState(sessionId: string, trigger: "chunk" | "quiet"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "idle") return;

    const lines = await this.getOutputLines(sessionId, PTY_ROWS);
    const screenText = lines.join("\n");

    // ── Gates ──────────────────────────────────────────────────────
    const gate: CodexGateType | null = CODEX_HOOKS_GATE_REGEX.test(screenText)
      ? "hooks"
      : CODEX_TRUST_GATE_REGEX.test(screenText)
        ? "trust"
        : null;

    if (gate) {
      this.handleGate(sessionId, session, gate, lines);
    } else if (this.openGate.delete(sessionId)) {
      // The dialog left the screen (answered via card, keys, or desktop) —
      // dismiss the card and release inputs held while it was open.
      this.onPermissionChange?.(sessionId, null);
      this.flushQueuedInputs(sessionId);
    }

    // ── Readiness ──────────────────────────────────────────────────
    if (session.status !== "running" || !this.pendingReady.has(sessionId)) return;
    const lastNonBlank = [...lines].reverse().find((l) => l.trim() !== "") ?? "";
    if (lastNonBlank.includes(CODEX_PROMPT_READY_TEXT)) {
      this.markReady(sessionId, session, `marker:${CODEX_PROMPT_READY_TEXT}`);
    } else if (trigger === "quiet") {
      this.markReady(sessionId, session, "quiet:timeout");
    }
  }

  // Answer a gate from the persisted remember-store, or surface it as a
  // question card over the permission transport. Actioned once per session and
  // gate type — repaints of the same dialog neither re-write nor re-broadcast.
  private handleGate(
    sessionId: string,
    session: InternalSession,
    gate: CodexGateType,
    lines: string[],
  ): void {
    const key = `${sessionId}:${gate}`;
    if (this.gateActioned.has(key)) return;
    this.gateActioned.add(key);

    const remembered = rememberedGateDigit(gate);
    if (remembered) {
      this.log.info(`[codex.gate_auto_answer] ${sessionId.slice(0, 8)} ${gate} → ${remembered}`, {
        event: "codex.gate_auto_answer",
        sessionId,
        gate,
        digit: remembered,
      });
      session.process.write(remembered);
      return;
    }

    this.openGate.set(sessionId, gate);
    const card = gateCard(gate, lines);
    this.log.info(`[codex.gate_prompt] ${sessionId.slice(0, 8)} ${gate}`, {
      event: "codex.gate_prompt",
      sessionId,
      gate,
      prompt: card.prompt,
    });
    this.onPermissionChange?.(sessionId, card);
  }

  private markReady(sessionId: string, session: InternalSession, reason: string): void {
    session.lastActivityAt = new Date();
    session.status = "waiting_input";
    // `reason=quiet:timeout`/`fallback:timeout` in volume would mean the
    // status-bar marker regressed (e.g. a Codex TUI redesign) — keep logged.
    this.log.info(`[codex.ready] ${sessionId.slice(0, 8)} ${reason}`, {
      event: "codex.ready",
      sessionId,
      reason,
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
    this.clearSessionDetectors(sessionId);
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
