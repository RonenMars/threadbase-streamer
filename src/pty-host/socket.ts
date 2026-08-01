import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeMessage,
  type HostMessage,
  type HostTransport,
  isHostEvent,
  LineDecoder,
} from "./protocol";

/**
 * Socket plumbing for the pty-host (plan Phase 6b).
 *
 * A unix domain socket on POSIX, a named pipe on Windows. Both are local-only
 * by construction, which is the security property that matters: the host can
 * spawn arbitrary agent processes, so it must never be reachable over a TCP
 * port that something else on the network could find.
 */

/**
 * Where the host listens.
 *
 * Scoped by instance id, so two streamers configured as separate instances on
 * one machine do not fight over one host — the same reason DB-persisted
 * sessions are scoped by it.
 *
 * POSIX puts it under the config dir rather than /tmp: `THREADBASE_CONFIG_DIR`
 * already redirects the whole config tree in tests, and a path under a
 * user-owned directory cannot be pre-created by another user to hijack the
 * bind. Windows named pipes are not filesystem paths at all, so the config dir
 * has nothing to say about them.
 */
export function hostSocketPath(instanceId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\threadbase-pty-host-${instanceId}`;
  }
  const dir = process.env.THREADBASE_CONFIG_DIR ?? join(homedir(), ".threadbase");
  return join(dir, "run", `pty-host-${instanceId}.sock`);
}

/** Wrap a connected socket as the duplex line channel the runner expects. */
export function socketTransport(socket: Socket): HostTransport {
  socket.setEncoding("utf8");
  return {
    send(line: string) {
      // Writes are fire-and-forget: a full send buffer backpressures inside
      // node, and a dead socket surfaces through onClose rather than here.
      socket.write(line);
    },
    onLine(handler) {
      socket.on("data", (chunk: string) => handler(chunk));
    },
    onClose(handler) {
      let handled = false;
      const handleClose = () => {
        if (handled) return;
        handled = true;
        handler();
      };
      socket.once("close", handleClose);
      // A connection error is a close as far as every caller is concerned; the
      // runner's job is to fail in-flight requests either way.
      socket.once("error", handleClose);
    },
    close() {
      socket.destroy();
    },
  };
}

/** Connect to a host that is already listening. Rejects if none is. */
export function connectToHost(socketPath: string): Promise<HostTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socketTransport(socket));
    });
  });
}

export type PtyHostStatusProbe =
  | { reachable: true; protocolVersion: number; sessionCount: number }
  | { reachable: false; error: string };

/** Query host status without subscribing to events or adopting its sessions. */
export async function probePtyHostStatus(
  socketPath: string,
  timeoutMs = 1_000,
): Promise<PtyHostStatusProbe> {
  let transport: HostTransport;
  let connectTimedOut = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const connecting = connectToHost(socketPath);
  try {
    transport = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => {
          connectTimedOut = true;
          reject(new Error(`status timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        connectTimer.unref?.();
      }),
    ]);
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    if (connectTimedOut)
      void connecting.then(
        (late) => late.close(),
        () => {},
      );
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (connectTimer) clearTimeout(connectTimer);

  return await new Promise<PtyHostStatusProbe>((resolve) => {
    const decoder = new LineDecoder();
    let settled = false;
    const finish = (result: PtyHostStatusProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ reachable: false, error: `status timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();
    transport.onClose(() => finish({ reachable: false, error: "pty-host connection closed" }));
    transport.onLine((chunk) => {
      for (const line of decoder.push(chunk)) {
        let message: HostMessage;
        try {
          message = JSON.parse(line) as HostMessage;
        } catch {
          finish({ reachable: false, error: "pty-host returned an invalid status response" });
          return;
        }
        if (isHostEvent(message) || message.id !== 1) continue;
        if (!message.ok) {
          finish({ reachable: false, error: message.error });
          return;
        }
        const status = message.result as { protocolVersion?: unknown; sessions?: unknown };
        if (typeof status?.protocolVersion !== "number" || !Array.isArray(status.sessions)) {
          finish({ reachable: false, error: "pty-host returned an invalid status response" });
          return;
        }
        finish({
          reachable: true,
          protocolVersion: status.protocolVersion,
          sessionCount: status.sessions.length,
        });
      }
    });
    try {
      transport.send(encodeMessage({ id: 1, type: "status" }));
    } catch (err) {
      finish({ reachable: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export interface HostServerHandlers {
  /** One connected streamer. Returns a disposer run when it disconnects. */
  onConnection: (transport: HostTransport) => () => void;
}

/**
 * Listen for streamer connections.
 *
 * A stale socket file from a host that died without cleaning up would make
 * `listen` fail with EADDRINUSE forever, so an unconnectable one is removed
 * first — but only after a probe confirms nothing answers on it, because
 * deleting a live host's socket would strand every session it holds.
 */
export async function listenForStreamers(
  socketPath: string,
  handlers: HostServerHandlers,
): Promise<Server> {
  if (process.platform !== "win32") {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(socketPath), { recursive: true });
    try {
      const probe = await connectToHost(socketPath);
      probe.close();
      throw new Error(`a pty-host is already listening on ${socketPath}`);
    } catch (err) {
      if ((err as Error).message?.startsWith("a pty-host is already listening")) throw err;
      // Nothing answered — the file, if any, is a corpse.
      rmSync(socketPath, { force: true });
    }
  }

  const server = createServer((socket) => {
    const transport = socketTransport(socket);
    const dispose = handlers.onConnection(transport);
    transport.onClose(dispose);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

/** Broadcast helper: a message to every currently-connected streamer. */
export function broadcast(
  transports: Iterable<HostTransport>,
  message: Parameters<typeof encodeMessage>[0],
): void {
  const line = encodeMessage(message);
  for (const t of transports) {
    try {
      t.send(line);
    } catch {
      // A dead peer is reaped by its own close handler; one bad write must not
      // stop the others from being told.
    }
  }
}
