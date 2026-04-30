import type { PTYManager } from "./pty-manager";
import type { SessionStore } from "./session-store";
import type { WSHub } from "./ws-hub";

export interface IdleSweeperOptions {
  ptyManager: PTYManager;
  sessionStore: SessionStore;
  wsHub: WSHub;
  idleTimeoutMs?: number;
  intervalMs?: number;
}

export class IdleSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly intervalMs: number;
  private readonly ptyManager: PTYManager;
  private readonly sessionStore: SessionStore;
  private readonly wsHub: WSHub;

  constructor(opts: IdleSweeperOptions) {
    this.ptyManager = opts.ptyManager;
    this.sessionStore = opts.sessionStore;
    this.wsHub = opts.wsHub;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  putSessionOnHold(sessionId: string): void {
    const session = this.sessionStore.getManaged(sessionId);
    if (!session || session.status !== "waiting_input") return;
    try {
      this.ptyManager.putOnHold(sessionId);
    } catch {
      // already gone
    }
    const now = new Date();
    this.sessionStore.updateManaged(sessionId, { status: "on_hold", completedAt: now });
    const resp = this.sessionStore.get(sessionId);
    if (resp) this.wsHub.broadcast({ type: "session_update", session: resp });
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessionStore.listManaged()) {
      if (session.status !== "waiting_input") continue;
      if (!session.lastActivityAt) continue;
      if (now - session.lastActivityAt.getTime() < this.idleTimeoutMs) continue;
      this.putSessionOnHold(session.id);
    }
  }
}
