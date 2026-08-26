import { randomUUID } from "node:crypto";
import { LiveSessionManager } from "../live-session-manager";
import type { Logger } from "../logger";
import { getLogger } from "../logger";
import { permissionGateKey } from "../services/questions/detectPermissionGate";
import { questionContentKey } from "../services/questions/detectQuestionFromScreen";
import type { ManagedSession, StartFreshSessionOptions, StartSessionOptions } from "../types";
import {
  encodeMessage,
  type HostEvent,
  type HostHeartbeatState,
  type HostPromptSnapshot,
  type HostRequest,
  type HostSession,
  type HostTransport,
  isHostEvent,
  LineDecoder,
  PTY_HOST_PROTOCOL_VERSION,
  type ReplayResult,
} from "./protocol";

/**
 * The pty-host: the process that actually owns the PTYs (plan Phase 6b).
 *
 * The whole feature rests on one property — this process is not the one being
 * restarted. It holds node-pty, the ring buffer, the xterm screen, the input
 * history, the queued-input state and the prompt/gate detectors, so a streamer
 * restart costs a socket reconnect rather than every live agent.
 *
 * It is deliberately thin above `LiveSessionManager`: the runners are the same
 * ones the in-process path uses, so there is one implementation of how a
 * session is spawned and detected, not two that can drift.
 *
 * **The idle reaper runs here, not in the streamer.** That is not a detail. A
 * host whose streamer went away for good would otherwise keep every PTY alive
 * forever, and the reaper is the only bound on that.
 */

/** How often to sweep for idle sessions. Mirrors the streamer's own cadence. */
export const HOST_IDLE_SWEEP_MS = 5 * 60 * 1000;

/** Agent silence after which a settled session is released. */
export const HOST_IDLE_AFTER_MS = 6 * 60 * 60 * 1000;

export const HOST_HEARTBEAT_TIMEOUT_MS = 30_000;
export const HOST_ORPHAN_SWEEP_MS = 10_000;

export interface SessionHostOptions {
  logger?: Logger;
  idleSweepMs?: number;
  idleAfterMs?: number;
  onShutdown?: () => void;
  heartbeatTimeoutMs?: number;
  orphanSweepMs?: number;
  onOrphaned?: () => void;
}

export class SessionHost {
  private runner: LiveSessionManager;
  private log: Logger;
  private subscribers = new Set<HostTransport>();
  private decoders = new WeakMap<HostTransport, LineDecoder>();
  /** Last time each session's agent produced output. Drives the reaper. */
  private lastAgentChunkAt = new Map<string, number>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleAfterMs: number;
  private onShutdown: (() => void) | undefined;
  private heartbeatTimeoutMs: number;
  private heartbeatLeases = new Map<HostTransport, number>();
  private lastRegistryHeartbeat: (HostHeartbeatState & { at: number }) | null = null;
  private orphanTimer: ReturnType<typeof setInterval> | null = null;
  private onOrphaned: (() => void) | undefined;
  private orphaned = false;
  private promptSnapshots = new Map<string, HostPromptSnapshot>();

  constructor(options: SessionHostOptions = {}) {
    this.log = options.logger ?? getLogger("pty-host");
    this.idleAfterMs = options.idleAfterMs ?? HOST_IDLE_AFTER_MS;
    this.onShutdown = options.onShutdown;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HOST_HEARTBEAT_TIMEOUT_MS;
    this.onOrphaned = options.onOrphaned;

    // Every runner callback becomes an event. The detectors run here, so a
    // callback with no event is a feature that silently stops working.
    this.runner = new LiveSessionManager({
      logger: this.log,
      onOutput: (sessionId, data) => {
        this.lastAgentChunkAt.set(sessionId, Date.now());
        this.emit({ type: "event", event: "output", sessionId, data });
      },
      onStatusChange: (session) => {
        if (session.status === "idle") this.promptSnapshots.delete(session.id);
        this.emit({ type: "event", event: "status-change", session });
      },
      onReady: (session) => this.emit({ type: "event", event: "ready", session }),
      onPermissionChange: (sessionId, gate) => {
        const prior = this.promptSnapshots.get(sessionId);
        if (gate === null) {
          this.promptSnapshots.delete(sessionId);
          this.emit({
            type: "event",
            event: "permission-change",
            sessionId,
            gate,
            ...(prior ? { occurrenceId: prior.occurrenceId } : {}),
          });
          return;
        }
        const occurrenceId =
          prior?.kind === "permission" && permissionGateKey(prior.gate) === permissionGateKey(gate)
            ? prior.occurrenceId
            : randomUUID();
        this.promptSnapshots.set(sessionId, {
          kind: "permission",
          sessionId,
          occurrenceId,
          gate,
        });
        this.emit({
          type: "event",
          event: "permission-change",
          sessionId,
          gate,
          occurrenceId,
        });
      },
      onPhaseChange: (sessionId, phase) =>
        this.emit({ type: "event", event: "phase-change", sessionId, phase }),
      onLiveQuestion: (sessionId, questions) => {
        const prior = this.promptSnapshots.get(sessionId);
        const occurrenceId =
          prior?.kind === "question" &&
          questionContentKey(prior.questions) === questionContentKey(questions)
            ? prior.occurrenceId
            : randomUUID();
        this.promptSnapshots.set(sessionId, {
          kind: "question",
          sessionId,
          occurrenceId,
          questions,
        });
        this.emit({ type: "event", event: "live-question", sessionId, questions, occurrenceId });
      },
      onLiveQuestionGone: (sessionId) => {
        this.promptSnapshots.delete(sessionId);
        this.emit({ type: "event", event: "live-question-gone", sessionId });
      },
      onUserMessage: (sessionId, text, ts) =>
        this.emit({ type: "event", event: "user-message", sessionId, text, ts }),
    });

    this.idleTimer = setInterval(() => this.reapIdle(), options.idleSweepMs ?? HOST_IDLE_SWEEP_MS);
    this.idleTimer.unref?.();
    this.orphanTimer = setInterval(
      () => this.reapOrphan(),
      options.orphanSweepMs ?? HOST_ORPHAN_SWEEP_MS,
    );
    this.orphanTimer.unref?.();
  }

  /**
   * Attach a connected streamer. Returns the disposer for its disconnect.
   *
   * A disconnect removes the subscriber and nothing else: the sessions stay,
   * which is the entire point of the host existing.
   */
  accept(transport: HostTransport): () => void {
    this.decoders.set(transport, new LineDecoder());
    transport.onLine((chunk) => this.handleChunk(transport, chunk));
    return () => {
      this.subscribers.delete(transport);
      this.heartbeatLeases.delete(transport);
      this.log.info("[pty-host] streamer disconnected; sessions kept", {
        event: "pty_host.streamer_disconnected",
        subscribers: this.subscribers.size,
      });
    };
  }

  private handleChunk(transport: HostTransport, chunk: string): void {
    const decoder = this.decoders.get(transport);
    if (!decoder) return;
    for (const line of decoder.push(chunk)) {
      let request: HostRequest;
      try {
        request = JSON.parse(line) as HostRequest;
      } catch {
        this.log.warn("[pty-host] dropped unparseable request", {
          event: "pty_host.bad_request",
        });
        continue;
      }
      // Events only travel host → streamer. One arriving here means a confused
      // peer, and answering it would invent a response id that matches nothing.
      if (isHostEvent(request as never)) continue;
      void this.dispatch(transport, request);
    }
  }

  private async dispatch(transport: HostTransport, request: HostRequest): Promise<void> {
    try {
      const result = await this.handle(transport, request);
      transport.send(encodeMessage({ id: request.id, ok: true, result }));
      if (request.type === "shutdown-host") this.onShutdown?.();
    } catch (err) {
      // A failure is always a response. Staying silent would leave the
      // streamer's promise pending forever — a hung session start rather than
      // an error it can report.
      transport.send(
        encodeMessage({
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async handle(transport: HostTransport, request: HostRequest): Promise<unknown> {
    switch (request.type) {
      case "subscribe":
        this.subscribers.add(transport);
        this.log.info("[pty-host] streamer subscribed", {
          event: "pty_host.streamer_subscribed",
          subscribers: this.subscribers.size,
        });
        return { promptSnapshots: [...this.promptSnapshots.values()] };

      case "status":
        return {
          protocolVersion: PTY_HOST_PROTOCOL_VERSION,
          sessions: this.runner.listSessions().map((session) => this.toHostSession(session)),
          promptSnapshots: [...this.promptSnapshots.values()],
        };

      case "heartbeat":
        this.heartbeatLeases.set(transport, Date.now());
        this.lastRegistryHeartbeat = {
          registryState: request.registryState,
          referencedSessionIds: [...request.referencedSessionIds],
          at: Date.now(),
        };
        return {};

      case "spawn": {
        const session =
          request.sessionId === null
            ? await this.runner.startFresh(request.options as StartFreshSessionOptions)
            : await this.runner.start(request.sessionId, {
                ...(request.options as StartSessionOptions),
                provider: request.provider,
              });
        return this.toHostSession(session);
      }

      case "write":
        return this.runner.sendInput(request.sessionId, request.input);

      case "keys":
        this.runner.sendKeys(request.sessionId, request.keys);
        return {};

      case "cancel":
        this.runner.cancel(request.sessionId);
        return {};

      case "kill": {
        if ("hold" in request && request.hold) {
          this.runner.putOnHold(request.sessionId);
          this.forget(request.sessionId);
        } else if ("pid" in request) {
          this.runner.killPid(request.pid);
        }
        return {};
      }

      case "shutdown-host":
        return {};

      case "replay": {
        const lines = await this.runner.getOutputLines(request.sessionId, request.maxLines);
        // The raw buffer travels too, so a reconnecting streamer's getOutput is
        // not empty just because it missed the events that filled it.
        return { lines, output: this.runner.getOutput(request.sessionId) } satisfies ReplayResult;
      }

      case "input-history":
        return { history: this.runner.getInputHistory(request.sessionId) };
    }
  }

  private toHostSession(session: ManagedSession): HostSession {
    return { session, pid: this.runner.getPid(session.id) };
  }

  private emit(event: HostEvent): void {
    const line = encodeMessage(event);
    for (const transport of this.subscribers) {
      try {
        transport.send(line);
      } catch {
        // Reaped by its own close handler; one bad write must not silence the
        // rest of the fan-out.
      }
    }
  }

  private forget(sessionId: string): void {
    this.lastAgentChunkAt.delete(sessionId);
    this.promptSnapshots.delete(sessionId);
  }

  /**
   * Release PTYs whose agent has been silent past the threshold.
   *
   * Same rule as the streamer's own reaper — a `running` session is never
   * touched however long the turn runs — but it lives here because this process
   * is the one holding the fds. An abandoned host with no reaper keeps every
   * agent alive indefinitely.
   *
   * Exposed so tests can drive one sweep instead of waiting on the interval.
   */
  reapIdle(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const session of this.runner.listSessions()) {
      if (session.status === "running") continue;

      const lastActive =
        this.lastAgentChunkAt.get(session.id) ??
        session.lastActivityAt?.getTime() ??
        session.startedAt.getTime();
      if (now - lastActive < this.idleAfterMs) continue;

      this.log.info(`[pty-host] releasing idle PTY for ${session.id}`, {
        event: "pty_host.idle_reap",
        sessionId: session.id,
        idleMs: now - lastActive,
      });
      this.runner.putOnHold(session.id);
      this.forget(session.id);
      this.emit({ type: "event", event: "exit", sessionId: session.id, exitCode: 0 });
      reaped.push(session.id);
    }
    return reaped;
  }

  /** Session count, for the supervisor and the orphan check in PR 9. */
  sessionCount(): number {
    return this.runner.listSessions().length;
  }

  reapOrphan(now: number = Date.now()): boolean {
    if (this.orphaned) return false;
    for (const lastSeen of this.heartbeatLeases.values()) {
      if (now - lastSeen <= this.heartbeatTimeoutMs) return false;
    }
    const registry = this.lastRegistryHeartbeat;
    if (registry?.registryState !== "known") return false;
    if (now - registry.at <= this.heartbeatTimeoutMs) return false;
    if (registry.referencedSessionIds.length > 0) return false;
    if (this.sessionCount() > 0) return false;

    this.orphaned = true;
    this.log.info("[pty-host] releasing unreferenced idle host", {
      event: "pty_host.orphan_reap",
    });
    this.onOrphaned?.();
    return true;
  }

  /**
   * Shut the host down, signalling its children.
   *
   * The opposite of `RemoteSessionRunner.dispose()`, which only drops a
   * connection: when the *host* goes away there is nothing left to hold the
   * fds, so leaving the agents running would orphan them with no owner.
   */
  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (this.orphanTimer) clearInterval(this.orphanTimer);
    this.orphanTimer = null;
    this.subscribers.clear();
    this.heartbeatLeases.clear();
    this.runner.dispose();
  }
}
