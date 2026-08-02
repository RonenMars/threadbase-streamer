import type { ProviderName } from "../providers";
import type {
  ManagedSession,
  PTYManagerOptions,
  SessionRunner,
  StartFreshSessionOptions,
  StartSessionOptions,
  UserMessage,
} from "../types";
import {
  encodeMessage,
  type HostEvent,
  type HostMessage,
  type HostRequest,
  type HostRequestBody,
  type HostSession,
  type HostTransport,
  type InputHistoryResult,
  isHostEvent,
  LineDecoder,
  type ReplayResult,
  reviveSession,
  type StatusResult,
} from "./protocol";

/**
 * `SessionRunner` backed by an out-of-process pty-host (plan Phase 6a).
 *
 * `LiveSessionManager` selects this runner at boot when the `ptyHost` feature
 * flag is enabled; the default-off path keeps the in-process runners.
 *
 * **The mirror is the whole design problem.** `SessionRunner` is mostly
 * synchronous — `hasSession`, `getPid`, `listSessions`, `getOutput` and
 * `sendInput` all return values, not promises — and they are called from
 * request handlers that cannot await a socket round-trip. So the runner keeps a
 * local copy of session state, seeded by `status` on connect and kept current
 * by pushed events. Reads answer from the mirror; only mutations and the two
 * genuinely async methods cross the wire.
 *
 * The consequence worth stating: a mirror can be stale, and the honest failure
 * for a stale mirror is the same one an in-process runner gives for an unknown
 * session — throw. It must never invent a session, and it must never answer
 * "no such session" for one the host is holding, which is why `status` is
 * awaited before the runner is handed out (see `connect`).
 */
export class RemoteSessionRunner implements SessionRunner {
  private transport: HostTransport;
  private options: PTYManagerOptions;
  private decoder = new LineDecoder();
  private nextRequestId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  /** The mirror. Rebuilt wholesale by `status`, patched by events. */
  private sessions = new Map<string, ManagedSession>();
  /** Ring buffers, fed by `output` events so `getOutput` stays synchronous. */
  private output = new Map<string, string>();
  private inputHistory = new Map<string, UserMessage[]>();
  /** Fixed for a session's lifetime, so only spawn and status carry it. */
  private pids = new Map<string, number | null>();
  private closed = false;

  /**
   * The only supported way to build one: a runner whose mirror has not been
   * seeded yet would answer `hasSession` with a confident, wrong `false` for
   * every session the host is holding — which reads as "the agent is gone" and
   * routes the user to start a new one.
   */
  static async connect(
    transport: HostTransport,
    options: PTYManagerOptions = {},
  ): Promise<RemoteSessionRunner> {
    const runner = new RemoteSessionRunner(transport, options);
    await runner.request({ type: "subscribe" });
    await runner.refreshMirror();
    return runner;
  }

  private constructor(transport: HostTransport, options: PTYManagerOptions) {
    this.transport = transport;
    this.options = options;
    transport.onLine((line) => this.handleLine(line));
    transport.onClose(() => this.handleClose());
  }

  // ─── Transport plumbing ──────────────────────────────────────────

  private handleLine(line: string): void {
    for (const complete of this.decoder.push(line)) {
      let message: HostMessage;
      try {
        message = JSON.parse(complete) as HostMessage;
      } catch {
        // A malformed line is the host's bug, not a reason to tear down every
        // live session. Drop it and keep reading.
        this.options.logger?.warn("[pty-host] dropped unparseable message", {
          event: "pty_host.bad_message",
        });
        continue;
      }
      if (isHostEvent(message)) {
        this.handleEvent(message);
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error));
    }
  }

  /**
   * Fail every in-flight request when the socket drops.
   *
   * Without this each one stays pending forever and the caller — a session
   * start, an input write — hangs rather than erroring. PR 9 adds reconnection;
   * until then a dropped host is a hard failure that says so.
   */
  private handleClose(): void {
    this.closed = true;
    const err = new Error("pty-host connection closed");
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private request(body: HostRequestBody): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("pty-host connection closed"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(encodeMessage({ ...body, id } as HostRequest));
    });
  }

  /**
   * Fire-and-forget for the synchronous parts of `SessionRunner`.
   *
   * `sendKeys`, `cancel`, `killPid` and `putOnHold` all return void, so there is
   * no channel to report a failure through even if we waited for one. The
   * response is still consumed — an unhandled rejection would take the process
   * down over a keystroke that failed to land.
   */
  private fireAndForget(body: HostRequestBody): void {
    this.request(body).catch((err) => {
      this.options.logger?.warn("[pty-host] request failed", {
        event: "pty_host.request_failed",
        type: body.type,
        err,
      });
    });
  }

  private async refreshMirror(): Promise<void> {
    const status = (await this.request({ type: "status" })) as StatusResult;
    this.sessions = new Map();
    this.pids = new Map();
    for (const entry of status.sessions) {
      const session = reviveSession(entry.session);
      this.sessions.set(session.id, session);
      this.pids.set(session.id, entry.pid);
    }
  }

  // ─── Events ──────────────────────────────────────────────────────

  private handleEvent(event: HostEvent): void {
    switch (event.event) {
      case "output": {
        this.output.set(event.sessionId, (this.output.get(event.sessionId) ?? "") + event.data);
        this.options.onOutput?.(event.sessionId, event.data);
        break;
      }
      case "status-change": {
        const session = reviveSession(event.session);
        if (session.status === "idle" && session.completedAt != null) {
          this.sessions.delete(session.id);
          this.pids.delete(session.id);
          this.output.delete(session.id);
          this.inputHistory.delete(session.id);
        } else {
          this.sessions.set(session.id, session);
        }
        this.options.onStatusChange?.(session);
        break;
      }
      case "ready": {
        const session = reviveSession(event.session);
        this.sessions.set(session.id, session);
        this.options.onReady?.(session);
        break;
      }
      case "permission-change":
        this.options.onPermissionChange?.(event.sessionId, event.gate);
        break;
      case "live-question":
        this.options.onLiveQuestion?.(event.sessionId, event.questions);
        break;
      case "live-question-gone":
        this.options.onLiveQuestionGone?.(event.sessionId);
        break;
      case "user-message": {
        const history = this.inputHistory.get(event.sessionId) ?? [];
        history.push({ text: event.text, ts: event.ts });
        this.inputHistory.set(event.sessionId, history);
        this.options.onUserMessage?.(event.sessionId, event.text, event.ts);
        break;
      }
      case "exit": {
        // Drop it from the mirror, matching what the in-process runners do on
        // exit — `handleExit` deletes from their map, which is what makes a
        // held session read as absent rather than as `status: "idle"`.
        this.sessions.delete(event.sessionId);
        this.pids.delete(event.sessionId);
        this.output.delete(event.sessionId);
        this.inputHistory.delete(event.sessionId);
        break;
      }
    }
  }

  // ─── SessionRunner ───────────────────────────────────────────────

  async start(sessionId: string, options: StartSessionOptions): Promise<ManagedSession> {
    const provider = (options as { provider?: ProviderName }).provider ?? "claude-code";
    return this.adopt(await this.request({ type: "spawn", provider, sessionId, options }));
  }

  async startFresh(options: StartFreshSessionOptions): Promise<ManagedSession> {
    const provider = (options as { provider?: ProviderName }).provider ?? "claude-code";
    return this.adopt(await this.request({ type: "spawn", provider, sessionId: null, options }));
  }

  /**
   * Take a spawn answer into the mirror.
   *
   * The pid lands here and nowhere else in the live path: `recordSessionSpawn`
   * reads it immediately after start to write the durable registry row, and a
   * null there costs the next boot its ability to probe whether the agent
   * outlived us.
   */
  private adopt(raw: unknown): ManagedSession {
    const entry = raw as HostSession;
    const session = reviveSession(entry.session);
    this.sessions.set(session.id, session);
    this.pids.set(session.id, entry.pid);
    return session;
  }

  /**
   * Returns the mirror's promptCount, optimistically incremented.
   *
   * The interface is synchronous, so there is no way to return the host's
   * authoritative count. The increment matches what an in-process runner does
   * for the same call, and the next `status-change` event overwrites it — so a
   * mirror that guessed wrong is corrected within one round trip rather than
   * drifting.
   */
  sendInput(sessionId: string, input: string): number {
    const session = this.requireSession(sessionId);
    this.fireAndForget({ type: "write", sessionId, input });
    session.promptCount += 1;
    return session.promptCount;
  }

  sendKeys(sessionId: string, keys: string): void {
    this.requireSession(sessionId);
    this.fireAndForget({ type: "keys", sessionId, keys });
  }

  cancel(sessionId: string): void {
    this.fireAndForget({ type: "cancel", sessionId });
  }

  killPid(pid: number): void {
    this.fireAndForget({ type: "kill", pid });
  }

  putOnHold(sessionId: string): void {
    this.fireAndForget({ type: "kill", sessionId, hold: true });
    // Matches PTYManager.putOnHold, which deletes from its map — a held session
    // must read as absent from the runner, not as an idle one it still owns.
    this.sessions.delete(sessionId);
    this.pids.delete(sessionId);
  }

  getOutput(sessionId: string): string {
    this.requireSession(sessionId);
    return this.output.get(sessionId) ?? "";
  }

  async getOutputLines(sessionId: string, maxLines: number): Promise<string[]> {
    const result = (await this.request({ type: "replay", sessionId, maxLines })) as ReplayResult;
    // The host renders from the xterm screen it owns; seed the local ring buffer
    // from the same answer so a reconnecting streamer's getOutput is not empty.
    if (typeof result.output === "string") this.output.set(sessionId, result.output);
    return result.lines;
  }

  /**
   * Synchronous, so it answers from the mirror rather than the host.
   *
   * Seeded lazily: `user-message` events append as they arrive, and a session
   * this streamer did not start has none until `hydrateInputHistory` fetches
   * them. Empty is the same answer an in-process runner gives for an unknown
   * session, so a caller cannot tell "none yet" from "not fetched" — which is
   * why the fetch is explicit rather than hidden behind this getter.
   */
  getInputHistory(sessionId: string): UserMessage[] {
    return this.inputHistory.get(sessionId) ?? [];
  }

  /** Pull a session's recorded messages from the host into the mirror. */
  async hydrateInputHistory(sessionId: string): Promise<UserMessage[]> {
    const result = (await this.request({
      type: "input-history",
      sessionId,
    })) as InputHistoryResult;
    this.inputHistory.set(sessionId, result.history);
    return result.history;
  }

  getPid(sessionId: string): number | null {
    return this.pids.get(sessionId) ?? null;
  }

  getSession(sessionId: string): ManagedSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessions(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Drops this streamer's connection and nothing else.
   *
   * Emphatically NOT the in-process `dispose()`, which signals every child. The
   * entire point of the host is that its PTYs outlive the streamer, so tearing
   * them down here would spend the feature to implement a method name.
   */
  dispose(): void {
    this.closed = true;
    this.transport.close();
  }

  private requireSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}
