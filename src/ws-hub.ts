import type { WebSocket } from "ws";
import type { WSMessage } from "./types";

const PING_INTERVAL_MS = 30_000;
// How long to wait for a pong before treating the socket as dead.
// Must be less than PING_INTERVAL_MS.
const PONG_TIMEOUT_MS = 10_000;

export class WSHub {
  private clients = new Set<WebSocket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Per-socket pong-timeout handle; set when ping is sent, cleared on pong/close.
  private pongTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on("pong", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
    });

    ws.on("close", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
      this.clients.delete(ws);
    });

    ws.on("error", () => {
      const t = this.pongTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.pongTimers.delete(ws);
      }
      this.clients.delete(ws);
    });

    if (!this.pingTimer && this.clients.size > 0) {
      this.startPing();
    }
  }

  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    const dead: WebSocket[] = [];

    for (const client of this.clients) {
      try {
        if (client.readyState === client.OPEN) {
          client.send(data);
        } else {
          dead.push(client);
        }
      } catch {
        dead.push(client);
      }
    }

    for (const client of dead) {
      this.clients.delete(client);
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  dispose(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [, t] of this.pongTimers) {
      clearTimeout(t);
    }
    this.pongTimers.clear();
    for (const client of this.clients) {
      try {
        // terminate() (not close()) so the underlying TCP socket dies
        // immediately. A graceful close() only sends a close frame and waits
        // for the peer's reply — a slow/backgrounded client would keep the
        // connection (and thus the HTTP listener's port) alive until the peer
        // ACKs, which is what stalled shutdown and caused EADDRINUSE on the
        // next deploy.
        client.terminate();
      } catch {
        // Already closed
      }
    }
    this.clients.clear();
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.clients.size === 0 && this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        return;
      }
      for (const client of this.clients) {
        if (client.readyState !== client.OPEN) continue;
        // WS protocol ping — client must reply with a pong frame. If no pong
        // arrives within PONG_TIMEOUT_MS the socket is considered dead and
        // terminated. This is what detects iOS silently killing the TCP
        // connection without delivering a close frame to the JS layer.
        client.ping();
        const t = setTimeout(() => {
          this.pongTimers.delete(client);
          client.terminate();
        }, PONG_TIMEOUT_MS);
        this.pongTimers.set(client, t);
      }
    }, PING_INTERVAL_MS);
  }
}
