import { basename } from "path";
import {
  type AppServerTransport,
  JsonRpcClient,
  spawnAppServerTransport,
} from "./codex-app-server-client";
import { getLogger, type Logger } from "./logger";
import { resolveCodexExe } from "./platform";
import { CODEX_CLI_PROVIDER } from "./providers";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionEvent,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "./types";

// A Codex runner driven by `codex app-server` (JSON-RPC over stdio) instead of a
// PTY. Status comes only from events the server emits: no screen, no timers.
// Protocol verified against codex-cli 0.166.0 (see __tests__/fixtures/codex-app-server).
// First slice: see docs/architecture/2026-08-12-structured-session-events.md for what is left.

const INPUT_HISTORY_MAX = 200;

export interface CodexAppServerRunnerOptions extends PTYManagerOptions {
  /** Test seam: replaces spawning the real `codex app-server`. */
  spawnTransport?: (cwd: string) => AppServerTransport;
}

interface Live extends ManagedSession {
  client: JsonRpcClient;
  transport: AppServerTransport;
  threadId: string;
  turnId: string | null;
  inputHistory: UserMessage[];
}

type Notification = { method: string; params: any };

export class CodexAppServerRunner implements SessionRunner {
  private sessions = new Map<string, Live>();
  private log: Logger;

  constructor(private readonly options: CodexAppServerRunnerOptions = {}) {
    this.log = options.logger ?? getLogger("codex-app-server");
  }

  start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return Promise.resolve(this.pub(existing));
    return this.launch(options, { resumeId: options.resumeId ?? sessionId });
  }

  startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    return this.launch(options, {});
  }

  private async launch(
    options: StartSessionOptions | StartFreshSessionOptions,
    { resumeId }: { resumeId?: string },
  ): Promise<ManagedSession> {
    if (options.additionalPaths?.length) {
      throw new Error("Codex app-server sessions do not support additional directories yet");
    }
    const spawn =
      this.options.spawnTransport ?? ((cwd) => spawnAppServerTransport(resolveCodexExe(), cwd));
    const transport = spawn(options.projectPath);
    const holder: { live?: Live } = {};
    const client = new JsonRpcClient(transport, {
      onNotification: (method, params) =>
        holder.live && this.onNotification(holder.live, { method, params }),
      onClose: (code) => holder.live && this.onExit(holder.live, code),
    });
    try {
      await client.request("initialize", {
        clientInfo: { name: "threadbase-streamer", title: null, version: "0.0.0" },
        capabilities: { experimentalApi: false },
      });
      client.notify("initialized");
      const res = resumeId
        ? await client.request("thread/resume", { threadId: resumeId, cwd: options.projectPath })
        : await client.request("thread/start", { cwd: options.projectPath });
      const threadId: string = res.thread.id;
      const live: Live = {
        id: threadId,
        provider: CODEX_CLI_PROVIDER,
        projectPath: options.projectPath,
        projectName: options.projectName ?? basename(options.projectPath),
        branch: options.branch ?? "",
        status: "waiting_input",
        statusSource: "thread-ready",
        statusUpdatedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        promptCount: 0,
        lastOutput: "",
        subStatus: null,
        client,
        transport,
        threadId,
        turnId: null,
        inputHistory: [],
      };
      holder.live = live;
      this.sessions.set(threadId, live);
      this.options.onStatusChange?.(this.pub(live));
      this.options.onReady?.(this.pub(live));
      return this.pub(live);
    } catch (err) {
      transport.kill();
      throw err;
    }
  }

  sendInput(sessionId: string, input: string): number {
    const s = this.get(sessionId);
    s.promptCount++;
    s.lastActivityAt = new Date();
    const ts = Date.now();
    s.inputHistory.push({ text: input, ts });
    if (s.inputHistory.length > INPUT_HISTORY_MAX) s.inputHistory.shift();
    this.options.onUserMessage?.(s.id, input, ts);
    // Sending is not an observation: running is entered on the turn/started notification.
    s.client
      .request("turn/start", { threadId: s.threadId, input: [{ type: "text", text: input }] })
      .catch((err) => this.log.warn(`turn/start failed: ${err.message}`, { sessionId }));
    return s.promptCount;
  }

  cancel(sessionId: string): void {
    const s = this.get(sessionId);
    if (!s.turnId) return;
    s.client
      .request("turn/interrupt", { threadId: s.threadId, turnId: s.turnId })
      .catch((err) => this.log.warn(`turn/interrupt failed: ${err.message}`, { sessionId }));
  }

  private onNotification(s: Live, { method, params }: Notification): void {
    const emit = (e: SessionEvent) => this.options.onSessionEvent?.(s.id, e);
    switch (method) {
      case "turn/started":
        s.turnId = params.turn.id;
        this.setStatus(s, "running");
        emit({ type: "turn_started", turnId: params.turn.id });
        break;
      case "turn/completed": {
        const status = params.turn.status;
        if (status === "inProgress") break;
        s.turnId = null;
        this.setStatus(s, "waiting_input");
        emit({
          type: "turn_completed",
          turnId: params.turn.id,
          status,
          ...(params.turn.error?.message && { error: params.turn.error.message }),
        });
        break;
      }
      case "item/agentMessage/delta":
        emit({ type: "agent_message_delta", itemId: params.itemId, delta: params.delta });
        break;
      case "item/completed":
        if (params.item.type === "agentMessage") {
          s.lastOutput = params.item.text;
          emit({ type: "agent_message", itemId: params.item.id, text: params.item.text });
        }
        break;
      case "error":
        // Status is never taken from an error: a retrying error is noise, and a final one
        // is followed by turn/completed(failed), which is the signal.
        emit({ type: "error", message: params.error.message, willRetry: params.willRetry });
        break;
    }
  }

  private setStatus(s: Live, status: "running" | "waiting_input"): void {
    if (s.status === status) return;
    s.status = status;
    s.statusSource = "turn-signal";
    s.statusUpdatedAt = new Date();
    this.options.onStatusChange?.(this.pub(s));
  }

  private onExit(s: Live, _code: number | null): void {
    if (this.sessions.get(s.id) !== s) return;
    this.end(s, "process-exit");
  }

  private end(s: Live, source: "process-exit" | "shutdown"): void {
    s.status = "idle";
    s.statusSource = source;
    s.statusUpdatedAt = new Date();
    s.completedAt = new Date();
    this.sessions.delete(s.id);
    this.options.onStatusChange?.(this.pub(s));
  }

  putOnHold(sessionId: string, signal: NodeJS.Signals = "SIGINT"): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId); // so the exit callback does not report process-exit
    s.transport.kill(signal);
    this.end(s, "shutdown");
  }

  killPid(pid: number): void {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.transport.kill();
    this.sessions.clear();
  }

  // No terminal: these have nothing to act on.
  sendKeys(): void {}
  sendRawKeys(): void {}
  resize(): void {}
  getOutput(): string {
    return "";
  }
  async getOutputLines(): Promise<string[]> {
    return [];
  }

  getInputHistory(sessionId: string): UserMessage[] {
    return this.sessions.get(sessionId)?.inputHistory ?? [];
  }
  getPid(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.transport.pid ?? null;
  }
  getSession(sessionId: string): ManagedSession | null {
    const s = this.sessions.get(sessionId);
    return s ? this.pub(s) : null;
  }
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  listSessions(): ManagedSession[] {
    return Array.from(this.sessions.values(), (s) => this.pub(s));
  }

  private get(sessionId: string): Live {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    return s;
  }

  private pub(s: Live): ManagedSession {
    const {
      client: _c,
      transport: _t,
      threadId: _th,
      turnId: _tu,
      inputHistory: _i,
      ...session
    } = s;
    return session;
  }
}
