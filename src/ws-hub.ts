import type { WebSocket } from "ws";
import type { WSMessage } from "./types";

const PING_INTERVAL_MS = 30_000;

export class WSHub {
  private clients = new Set<WebSocket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", () => {
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
      this.broadcast({ type: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
  }
}
