import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename } from "path";
import { getLogger, type Logger } from "./logger";
import { clearCodexExeCache, resolveCodexExe } from "./platform";
import { CODEX_CLI_PROVIDER } from "./providers";
import {
  createScreen,
  digestBytes,
  type InternalSession,
  loadPty,
  PTY_COLS,
  PTY_ROWS,
  stripAnsi,
} from "./pty-shared";
import {
  type CodexGateType,
  rememberedGateDigit,
  saveGateAnswer,
} from "./services/questions/codexGateAnswers";
import {
  CODEX_ACTIVE_WRITER_CODE,
  CODEX_ACTIVE_WRITER_RE,
  CODEX_HOOKS_GATE_REGEX,
  CODEX_PROMPT_READY_TEXT,
  CODEX_TRUST_GATE_REGEX,
  type CodexBlockingPrompt,
  codexScreenBlocksComposer,
  codexScreenLooksIdle,
  codexScreenShowsReady,
  codexStatusBarLine,
  detectCodexBlockingPrompt,
  detectCodexCommandApproval,
  gateCard,
} from "./services/questions/codexScreen";
import { parseAgentPhase } from "./services/questions/parseAgentPhase";
import type {
  AgentPhase,
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartForkSessionOptions,
  StartFreshSessionOptions,
  StartSessionOptions,
  StatusSource,
  UserMessage,
} from "./types";
import { debounce } from "./utils/debounce";

const OUTPUT_BUFFER_MAX = 65536;

// Cap on recorded user messages per session (drop oldest); mirrors
// pty-manager.ts INPUT_HISTORY_MAX.
const INPUT_HISTORY_MAX = 50;

// PTY geometry, the render terminal, node-pty loading, the session shape and
// ANSI stripping are shared with pty-manager.ts — see pty-shared.ts.

// Re-run screen detection this long after the PTY goes quiet — a session
// blocked on a gate (or a status bar whose "Ready" got truncated) may never
// produce another chunk to trigger detection. Same value/rationale as
// pty-manager.ts QUIET_DETECT_MS. Quiet alone does NOT mark boot ready
// (mirrors PTYManager.handleQuiet): silence during MCP Starting used to
// disarm the input queue and let \r land as a compose newline.
const QUIET_DETECT_MS = 500;

// Flat backstop from spawn: "Ready" lives at the END of a single status line
// whose prefix (dir · repo · branch · diffstats) can exceed PTY_COLS, in which
// case the marker is truncated off-screen and can NEVER match (live-probe
// verified). Must stay below server.ts START_READY_TIMEOUT_MS (10s) so the
// start request resolves 200-with-session rather than 202-pending — but only
// when the screen is not still Starting/Working/MCP-booting; otherwise we
// re-arm so a slow MCP boot cannot be mistaken for Ready.
const CODEX_READY_FALLBACK_MS = 8_000;

const SUBMIT_BYTES = "\r";

// Delay between the input write and the submit \r. Same value as Claude's
// SUBMIT_DELAY_MS (pty-manager.ts) — no bracketed-paste wrap needed for
// Codex (Phase 0: plain keystrokes are accepted directly into the compose
// box), but we still wait for PTY quiescence before Enter (see writeSubmit).
const CODEX_SUBMIT_DELAY_MS = 16;

// Cap on how long writeSubmit will wait for the PTY to go quiet before
// forcing \r — mirrors pty-manager.ts SUBMIT_MAX_WAIT_MS.
const CODEX_SUBMIT_MAX_WAIT_MS = 500;

// After sendInput flips waiting_input → running, if Working never appears
// within this window the turn never started (\r absorbed as a compose
// newline, truncated Ready boot, etc.). Recover so grace/hold and mobile
// are not stuck on `running`. Same 2s used by the Ready-stale path.
const CODEX_SUBMIT_STALE_MS = 2_000;

export class CodexPtyRunner implements SessionRunner {
  private sessions = new Map<string, InternalSession>();
  private onOutput: PTYManagerOptions["onOutput"];
  private onStatusChange: PTYManagerOptions["onStatusChange"];
  private onPhaseChange: PTYManagerOptions["onPhaseChange"];
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
  // After a user submit: if Working never appears, recover from stuck `running`.
  private submitWatchTimers = new Map<string, NodeJS.Timeout>();
  // Wall-clock of the last PTY chunk per session — writeSubmit waits until
  // this hasn't advanced for CODEX_SUBMIT_DELAY_MS before writing \r.
  private lastChunkAt = new Map<string, number>();
  // Sessions that have shown a Working status bar since the last user submit.
  // Mid-session Ready→waiting_input only fires after this, so a still-painted
  // Ready bar immediately after sendInput cannot flip status back before the
  // turn starts (which would let grace/hold kill a live turn).
  private turnBusy = new Set<string>();
  // Usage-limit / rate-limit menus — content key for deduped permission cards.
  private openBlockingPrompt = new Map<string, string>();
  // Command-approval cards are independent of quota cards: both use the
  // permission transport, but a repaint/removal of one must not suppress the
  // other detector's state.
  private openCommandApproval = new Map<string, string>();
  // Last codex.screen fingerprint per session — only emit when it changes so
  // MCP boot redraw storms don't flood the log.
  private lastScreenLog = new Map<string, string>();
  // In-flight start()/startFresh() calls keyed by sessionId. A second
  // concurrent resume for the same session (double-tap, client retry) awaits
  // the first call's promise instead of spawning a duplicate PTY (CRITICAL #3).
  private startPromises = new Map<string, Promise<ManagedSession>>();

  constructor(options: PTYManagerOptions = {}) {
    this.onOutput = options.onOutput;
    this.onStatusChange = options.onStatusChange;
    this.onPhaseChange = options.onPhaseChange;
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
    // `sessionId` stays the runner's map key — only argv carries the
    // provider-side id, so a resumed Codex session keeps the placeholder id
    // its client already navigated to.
    return this.launch(
      sessionId,
      ["resume", options.resumeId ?? sessionId, "--cd", options.projectPath, "--no-alt-screen"],
      options,
    );
  }

  // Spawn a Codex PTY under `sessionId` and wire up the shared boot machinery
  // (screen, ready fallback, output/exit handlers). The only difference between
  // resume, fresh and fork is argv.
  private async launch(
    sessionId: string,
    args: string[],
    options: { projectPath: string; projectName?: string; branch?: string },
  ): Promise<ManagedSession> {
    const nodePty = await loadPty();
    const projectName = options.projectName ?? basename(options.projectPath);

    let proc: ReturnType<typeof nodePty.spawn>;
    try {
      proc = nodePty.spawn(resolveCodexExe(), args, {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: options.projectPath,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      // See resolveClaudeExe's clearClaudeExeCache() in platform.ts — same
      // memoize-then-invalidate-on-spawn-failure rationale for Codex.
      clearCodexExeCache();
      throw err;
    }

    const session: InternalSession = {
      id: sessionId,
      provider: CODEX_CLI_PROVIDER,
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

  // Start a brand-new Codex session. Codex has no --session-id equivalent for
  // a fresh launch — it assigns its own id, discovered later (Task 3's
  // binding logic). This runner generates a local placeholder id for the
  // ManagedSession handle only.
  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const sessionId = randomUUID();

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

    return this.launch(sessionId, args, options);
  }

  /**
   * Fork an existing Codex conversation into a new, independently-owned one
   * (`codex fork <session-id>`).
   *
   * This is the recovery path for a rollout Codex will not let us resume: fork
   * starts a *new* rollout seeded from the source's history and never touches
   * the source's writer, so the terminal / VS Code / desktop client that owns
   * it keeps running untouched. Like a fresh start, Codex assigns the new
   * rollout id itself — the returned session is keyed by a local placeholder
   * until watchForCodexRollout binds the real id.
   */
  async startFork(options: StartForkSessionOptions): Promise<ManagedSession> {
    const sessionId = randomUUID();
    return this.launch(
      sessionId,
      ["fork", options.forkFromId, "--cd", options.projectPath, "--no-alt-screen"],
      options,
    );
  }

  // Flat backstop: if the "Ready" marker never appears within
  // CODEX_READY_FALLBACK_MS of spawn (truncated status bar), mark ready once
  // the screen is no longer Starting/Working/MCP-booting. Re-arms while the
  // boot is still busy so a slow MCP load cannot be mistaken for Ready.
  // unref() so a pending timer never holds the process open.
  private armReadyFallback(sessionId: string): void {
    const timer = setTimeout(() => {
      this.readyFallbackTimers.delete(sessionId);
      void this.tryReadyFallback(sessionId);
    }, CODEX_READY_FALLBACK_MS);
    timer.unref?.();
    this.readyFallbackTimers.set(sessionId, timer);
  }

  private async tryReadyFallback(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.status !== "running" || !this.pendingReady.has(sessionId)) return;

    // No PTY output at all — nothing busy to inspect; settle so start() can
    // resolve and queued input is not held forever (same role as Claude's
    // flat fallback on a silent boot).
    if (session.outputBuffer.length === 0) {
      this.markReady(sessionId, session, "timeout-fallback", "fallback:timeout");
      return;
    }

    try {
      const lines = await this.getOutputLines(sessionId, PTY_ROWS);
      if (!this.pendingReady.has(sessionId)) return;
      const busy = codexScreenBlocksComposer(lines);
      const bar = codexStatusBarLine(lines);
      this.log.info(
        `[codex.ready_fallback] ${sessionId.slice(0, 8)} busy=${busy} bar=${JSON.stringify(bar.slice(0, 120))}`,
        {
          event: "codex.ready_fallback",
          sessionId,
          busy,
          hasReady: codexScreenShowsReady(lines),
          statusBar: bar.slice(0, 160),
        },
      );
      if (busy) {
        this.armReadyFallback(sessionId);
        return;
      }
      // Truncated Ready bar still needs a compose prompt (or Ready itself) —
      // a model-only status line mid-paint must not disarm the input queue.
      if (!codexScreenShowsReady(lines) && !codexScreenLooksIdle(lines)) {
        this.armReadyFallback(sessionId);
        return;
      }
      this.markReady(sessionId, session, "timeout-fallback", "fallback:timeout");
    } catch (err) {
      this.log.warn("[codex.ready_fallback] failed", {
        event: "codex.ready_fallback_failed",
        sessionId,
        err,
      });
      // Keep trying — a transient screen-read failure must not strand boot.
      if (this.pendingReady.has(sessionId)) this.armReadyFallback(sessionId);
    }
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
      session.statusSource = "user-input";
      session.statusUpdatedAt = new Date();
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
    // Hold input while booting OR while a dialog owns the screen — a digit
    // flushed into a Codex approval card would confirm an option; plain text
    // mid-boot lands as compose newlines once \r is treated as Enter.
    if (
      this.pendingReady.has(sessionId) ||
      this.openGate.has(sessionId) ||
      this.openCommandApproval.has(sessionId)
    ) {
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
      session.statusSource = "user-input";
      session.statusUpdatedAt = new Date();
      this.onStatusChange?.(toPublicSession(session));
    }
    this.turnBusy.delete(sessionId);
    this.writeSubmit(sessionId, session, input, "direct", session.promptCount + 1);
    session.lastActivityAt = new Date();
    session.promptCount++;
    return session.promptCount;
  }

  // Write the input as plain bytes (no bracketed-paste wrap — Phase 0
  // confirmed Codex accepts plain keystrokes), then submit \r once the PTY
  // has been quiet for CODEX_SUBMIT_DELAY_MS. A flat delay fired \r into a
  // still-repainting TUI and the Enter became a compose newline instead of a
  // turn submit (same pathology Claude's quiescence wait fixed).
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
    const writeAt = Date.now();
    session.process.write(input);

    const trySubmit = () => {
      const current = this.sessions.get(sessionId);
      if (!current || current !== session) return;
      const now = Date.now();
      const lastChunk = this.lastChunkAt.get(sessionId) ?? writeAt;
      const quiet = now - lastChunk >= CODEX_SUBMIT_DELAY_MS;
      const timedOut = now - writeAt >= CODEX_SUBMIT_MAX_WAIT_MS;
      if (!quiet && !timedOut) {
        setTimeout(trySubmit, CODEX_SUBMIT_DELAY_MS);
        return;
      }
      this.log.info(
        `[codex.input.submit] ${sessionId.slice(0, 8)} promptCount=${promptCount} digest=\\r waitedMs=${now - writeAt} timedOut=${timedOut}`,
        {
          event: "codex.input_write",
          sessionId,
          promptCount,
          byteLen: SUBMIT_BYTES.length,
          digest: "\\r",
          path,
          phase: "submit",
          waitedMs: now - writeAt,
          timedOut,
        },
      );
      current.process.write(SUBMIT_BYTES);
      this.armSubmitWatch(sessionId);
    };
    setTimeout(trySubmit, CODEX_SUBMIT_DELAY_MS);
  }

  // If Working never appears after \r, the turn did not start — recover from
  // stuck `running` even when no further PTY chunks re-arm the quiet checker
  // (session ddc67b57: one post-submit chunk, then silence forever).
  private armSubmitWatch(sessionId: string): void {
    const prev = this.submitWatchTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.submitWatchTimers.delete(sessionId);
      void this.trySubmitStaleRecovery(sessionId);
    }, CODEX_SUBMIT_STALE_MS);
    timer.unref?.();
    this.submitWatchTimers.set(sessionId, timer);
  }

  private async trySubmitStaleRecovery(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.status !== "running") return;
    if (this.turnBusy.has(sessionId)) return;
    if (session.statusSource !== "user-input") return;

    try {
      const lines = await this.getOutputLines(sessionId, PTY_ROWS);
      if (session.status !== "running" || this.turnBusy.has(sessionId)) return;
      if (codexScreenBlocksComposer(lines)) {
        // Still Starting/MCP — give the turn more time.
        this.armSubmitWatch(sessionId);
        return;
      }
      this.log.info(`[codex.submit_stale] ${sessionId.slice(0, 8)} recovering`, {
        event: "codex.submit_stale",
        sessionId,
        statusBar: codexStatusBarLine(lines).slice(0, 160),
      });
      this.markReady(sessionId, session, "quiet-fallback", "submit-stale");
    } catch (err) {
      this.log.warn("[codex.submit_stale] failed", {
        event: "codex.submit_stale_failed",
        sessionId,
        err,
      });
      this.armSubmitWatch(sessionId);
    }
  }

  // Drain any inputs sent while the session was still pendingReady, writing
  // them in arrival order now that Codex is Ready. No-op while a gate dialog
  // is open (a flushed digit would confirm a dialog option) or while still
  // pendingReady (markReady drains it) — the gate-close path re-drives it for
  // the ready-with-gate-open case.
  private flushQueuedInputs(sessionId: string): void {
    if (
      this.openGate.has(sessionId) ||
      this.openCommandApproval.has(sessionId) ||
      this.pendingReady.has(sessionId)
    ) {
      return;
    }
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
    session.statusSource = "shutdown";
    session.statusUpdatedAt = new Date();
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
    const submitWatch = this.submitWatchTimers.get(sessionId);
    if (submitWatch) clearTimeout(submitWatch);
    this.submitWatchTimers.delete(sessionId);
    this.lastChunkAt.delete(sessionId);
    if (this.openGate.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
    }
    this.gateActioned.delete(`${sessionId}:hooks`);
    this.gateActioned.delete(`${sessionId}:trust`);
    this.turnBusy.delete(sessionId);
    if (this.openBlockingPrompt.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
    }
    if (this.openCommandApproval.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
    }
    this.lastScreenLog.delete(sessionId);
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

  // OS pid of the spawned agent, or null if the session isn't live here.
  // Mirrors PTYManager.getPid — see there for why the registry records it.
  getPid(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.process?.pid ?? null;
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
    for (const timer of this.submitWatchTimers.values()) {
      clearTimeout(timer);
    }
    this.submitWatchTimers.clear();
    this.lastChunkAt.clear();
    this.turnBusy.clear();
    this.openBlockingPrompt.clear();
    this.openCommandApproval.clear();
    this.lastScreenLog.clear();
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
  //   - Readiness — boot (pendingReady) requires the "Ready" status-bar marker
  //     (quiet alone never settles boot — Starting shows `›` already). Mid-
  //     session, running → waiting_input after Working then Ready (or a stale
  //     Ready recovery if the turn never started).
  private async detectScreenState(sessionId: string, _trigger: "chunk" | "quiet"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "idle") return;

    const lines = await this.getOutputLines(sessionId, PTY_ROWS);
    const screenText = lines.join("\n");

    // ── Writer lock ────────────────────────────────────────────────
    // Codex refused to attach: another client owns this rollout. Only during
    // boot — the message can only be produced before the session is usable,
    // and treating a later appearance (a user pasting the error text, say) as
    // fatal would kill a live session.
    if (this.pendingReady.has(sessionId) && CODEX_ACTIVE_WRITER_RE.test(screenText)) {
      this.failStartup(
        sessionId,
        session,
        CODEX_ACTIVE_WRITER_CODE,
        "This Codex session is already open in another client",
      );
      return;
    }

    // Phase refinement, off the screen read the detectors below already share.
    // Only while running: markReady clears the phase at turn end, and reading
    // it in any other state would let a stale screen re-assert one after that
    // clear. Placed after the writer-lock return so a refused startup, which
    // never reaches waiting_input, cannot leave a phase behind.
    if (session.status === "running") {
      this.setPhase(sessionId, session, parseAgentPhase(lines, CODEX_CLI_PROVIDER));
    }

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

    // ── Command approval ──────────────────────────────────────────
    // Trust/hooks dialogs own the screen before this one can appear. Do not
    // inspect their rendered content as an approval card, even if an old
    // command-approval repaint remains in the scrollback buffer.
    const commandApproval = gate ? null : detectCodexCommandApproval(lines);
    if (commandApproval) {
      this.handleCommandApproval(sessionId, commandApproval);
    } else if (this.openCommandApproval.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
      this.flushQueuedInputs(sessionId);
    }

    // ── Usage / rate limits ────────────────────────────────────────
    const blocking = detectCodexBlockingPrompt(lines);
    if (blocking) {
      // Soft tip alone is informational during boot / healthy idle — only
      // elevate it when a user submit is stuck in `running` without Working
      // (hard-limit text never appears; tip is the only quota signal).
      const elevateSoft =
        !blocking.soft ||
        (session.status === "running" &&
          session.statusSource === "user-input" &&
          !this.turnBusy.has(sessionId) &&
          !this.pendingReady.has(sessionId));
      if (elevateSoft) {
        this.handleBlockingPrompt(sessionId, session, blocking);
      }
    } else if (this.openBlockingPrompt.delete(sessionId)) {
      this.onPermissionChange?.(sessionId, null);
    }

    // ── Readiness ──────────────────────────────────────────────────
    const hasReady = codexScreenShowsReady(lines);
    const busy = codexScreenBlocksComposer(lines);
    const bar = codexStatusBarLine(lines);

    // State-change trail for Starting/Ready/usage investigations. Info (not
    // debug) so a default LOG_LEVEL=info prod log captures it; fingerprint
    // dedupe keeps MCP redraw storms from flooding the file.
    const screenFp = [
      this.pendingReady.has(sessionId) ? "1" : "0",
      session.status,
      hasReady ? "1" : "0",
      busy ? "1" : "0",
      blocking ? (blocking.soft ? "soft" : "1") : "0",
      bar.slice(0, 80),
    ].join("|");
    if (this.lastScreenLog.get(sessionId) !== screenFp) {
      this.lastScreenLog.set(sessionId, screenFp);
      this.log.info(
        `[codex.screen] ${sessionId.slice(0, 8)} pending=${this.pendingReady.has(sessionId)} ` +
          `status=${session.status} ready=${hasReady} busy=${busy} usage=${Boolean(blocking)} ` +
          `bar=${JSON.stringify(bar.slice(0, 100))}`,
        {
          event: "codex.screen",
          sessionId,
          trigger: _trigger,
          pendingReady: this.pendingReady.has(sessionId),
          status: session.status,
          hasReady,
          busy,
          usageHit: Boolean(blocking),
          usageSoft: Boolean(blocking?.soft),
          statusBar: bar.slice(0, 160),
        },
      );
    }

    if (this.pendingReady.has(sessionId)) {
      // Boot: only the Ready marker settles pendingReady on a chunk/quiet
      // pass. The flat fallback covers a truncated status bar once MCP boot
      // lines are gone — quiet-during-Starting must never disarm the queue.
      if (hasReady) {
        this.markReady(sessionId, session, "prompt-marker", `marker:${CODEX_PROMPT_READY_TEXT}`);
      }
      return;
    }

    // Mid-session: after sendInput flipped waiting_input → running, flip back
    // only once we've observed Working (turn actually started) and Ready has
    // returned. A stale Ready still on screen right after submit must not
    // undo the running status — grace/hold would then kill a live turn.
    if (session.status === "running") {
      if (/\bWorking\b/.test(bar)) {
        this.turnBusy.add(sessionId);
        const watch = this.submitWatchTimers.get(sessionId);
        if (watch) clearTimeout(watch);
        this.submitWatchTimers.delete(sessionId);
      }

      if (hasReady && this.turnBusy.has(sessionId)) {
        this.turnBusy.delete(sessionId);
        this.markReady(sessionId, session, "prompt-marker", `marker:${CODEX_PROMPT_READY_TEXT}`);
      } else if (
        !this.turnBusy.has(sessionId) &&
        !busy &&
        session.statusSource === "user-input" &&
        session.statusUpdatedAt != null &&
        Date.now() - session.statusUpdatedAt.getTime() >= CODEX_SUBMIT_STALE_MS
      ) {
        // Submit never started a turn (Enter absorbed, no Ready on screen,
        // etc.) — recover so the session is not stuck "running" forever.
        // Does not require Ready: fallback boots often never paint it.
        this.markReady(sessionId, session, "quiet-fallback", "submit-stale");
      }
    }
  }

  // Surface quota / rate-limit screens as permission cards and stop leaving
  // the session stuck in `running` while Codex waits for a menu pick.
  private handleBlockingPrompt(
    sessionId: string,
    session: InternalSession,
    blocking: CodexBlockingPrompt,
  ): void {
    const key = `${blocking.prompt}\0${blocking.detail ?? ""}\0${blocking.options.map((o) => o.index).join(",")}`;
    const prev = this.openBlockingPrompt.get(sessionId);
    if (prev !== key) {
      this.openBlockingPrompt.set(sessionId, key);
      session.failureReason = blocking.detail
        ? `${blocking.prompt} ${blocking.detail}`
        : blocking.prompt;
      this.log.info(`[codex.usage_limit] ${sessionId.slice(0, 8)}`, {
        event: "codex.usage_limit",
        sessionId,
        prompt: blocking.prompt,
      });
      this.onPermissionChange?.(sessionId, blocking);
    }
    if (session.status === "running") {
      this.turnBusy.delete(sessionId);
      this.markReady(sessionId, session, "quiet-fallback", "usage-limit");
    }
  }

  // Surface Codex's EXEC card through the existing permission event. The
  // rendered screen is authoritative: keying it by content suppresses TUI
  // repaint repeats and the absence path above clears it only after the card
  // has left the screen.
  private handleCommandApproval(sessionId: string, approval: CodexBlockingPrompt): void {
    const key = `${approval.detail ?? ""}\0${approval.options.map((o) => o.answerKeys).join(",")}`;
    if (this.openCommandApproval.get(sessionId) === key) return;
    this.openCommandApproval.set(sessionId, key);
    this.log.info(`[codex.command_approval] ${sessionId.slice(0, 8)}`, {
      event: "codex.command_approval",
      sessionId,
    });
    this.onPermissionChange?.(sessionId, approval);
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

  /**
   * Record the agent's phase and notify only on a real change. The guard is
   * load-bearing, not an optimisation: detectScreenState runs on every chunk,
   * so an unguarded setter would fire the WS frame behind this several times a
   * second for a whole turn while reporting the same value. Same contract as
   * PTYManager.setPhase — the two runners deliberately stay separate classes.
   */
  private setPhase(sessionId: string, session: InternalSession, phase: AgentPhase | null): void {
    const next = phase ?? null;
    if ((session.subStatus ?? null) === next) return;
    session.subStatus = next;
    this.onPhaseChange?.(sessionId, next);
  }

  private markReady(
    sessionId: string,
    session: InternalSession,
    source: StatusSource,
    reason: string,
  ): void {
    session.lastActivityAt = new Date();
    session.status = "waiting_input";
    // C3: same vocabulary as the Claude runner — a status reached by a timer
    // must be distinguishable from one reached by observing a marker.
    session.statusSource = source;
    session.statusUpdatedAt = new Date();
    // Turn end clears the phase. The exit edge is not an output event, so it
    // cannot be read off the screen — without this the phase latches on any
    // session that stops emitting, the bug tb-mobile PR #647 shipped. Below the
    // source assignment for the same reason as PTYManager.markReady.
    this.setPhase(sessionId, session, null);
    // `reason=fallback:timeout`/`quiet:soft-idle` in volume would mean the
    // status-bar Ready marker regressed (e.g. a Codex TUI redesign) — keep logged.
    this.log.info(`[codex.ready] ${sessionId.slice(0, 8)} ${reason}`, {
      event: "codex.ready",
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

  /**
   * Tear down a session that failed before it ever became usable, and report
   * the reason in machine-readable form.
   *
   * Deliberately NOT markReady + exit: the caller must be able to tell a
   * never-started session from a live one, `onReady` must not fire (no
   * `session_ready` for a failed start), and every piece of per-session state —
   * queue, timers, quiet-checker, gate cards, screen — has to go, since the
   * session is removed from the map and nothing will collect it later.
   */
  private failStartup(
    sessionId: string,
    session: InternalSession,
    code: string,
    message: string,
  ): void {
    this.log.warn(`[codex.start_failed] ${sessionId.slice(0, 8)} ${code}`, {
      event: "codex.start_failed",
      sessionId,
      code,
      message,
    });
    session.failureCode = code;
    session.failureReason = message;
    session.status = "idle";
    session.statusSource = "process-exit";
    session.statusUpdatedAt = new Date();
    session.completedAt = new Date();

    this.pendingReady.delete(sessionId);
    this.queuedInputs.delete(sessionId);
    this.clearSessionDetectors(sessionId);
    // Removed before the callback: the server reacts by reading the runner,
    // and must not see a session that is already dead.
    this.sessions.delete(sessionId);
    try {
      // Codex normally exits on its own here; SIGINT covers the case where it
      // sits on the error screen instead. handleExit no-ops — session is gone.
      session.process.kill("SIGINT");
    } catch {
      // Already dead.
    }
    session.screen.dispose();
    this.onStatusChange?.(toPublicSession(session));
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.completedAt = new Date();
    session.status = "idle";
    session.statusSource = "process-exit";
    session.statusUpdatedAt = new Date();

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
    ...(s.failureCode != null && { failureCode: s.failureCode }),
    ...(s.lastActivityAt != null && { lastActivityAt: s.lastActivityAt }),
    ...(s.statusSource != null && { statusSource: s.statusSource }),
    ...(s.statusUpdatedAt != null && { statusUpdatedAt: s.statusUpdatedAt }),
    ...(s.filePath != null && { filePath: s.filePath }),
    // Unconditional — see PTYManager's toPublicSession: a streamer re-adopting
    // a surviving pty-host's sessions mid-turn has no other source for the
    // phase, and the host's change guard will not re-emit it.
    subStatus: s.subStatus ?? null,
  };
}
