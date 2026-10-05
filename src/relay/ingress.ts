import { rmSync } from "fs";
import type { Server as HttpServer } from "http";
import { createServer, type Server } from "net";

// Sockets the relay ingress listener accepted. Membership is decided by WHICH
// LISTENER took the connection — never by a header, which a caller could forge
// and a proxy could drop, and never by `remoteAddress`, which is what makes a
// Cloudflare-tunnelled request indistinguishable from a local one.
const relaySockets = new WeakSet<object>();

/** True when the request's socket was accepted by the relay ingress listener. */
export function isViaRelay(socket: object | null | undefined): boolean {
  return socket != null && relaySockets.has(socket);
}

/**
 * Open a second listener on a unix socket (a named pipe on Windows) that feeds
 * the SAME http server, tagging every connection it accepts.
 *
 * A relay connector that dialled the TCP port instead would arrive from
 * 127.0.0.1 and inherit every loopback carve-out (`/healthz`, `/api/logs`,
 * `--local-no-auth`). Forwarding through this listener makes that impossible by
 * construction; `authMiddleware` reads the tag and accepts end-to-end-encrypted
 * traffic only.
 */
export function listenRelayIngress(httpServer: HttpServer, path: string): Promise<Server> {
  // A unix socket file outlives a crashed process and makes the next listen()
  // fail with EADDRINUSE. Named pipes are not files and need no cleanup.
  if (process.platform !== "win32") rmSync(path, { force: true });
  const ingress = createServer((socket) => {
    relaySockets.add(socket);
    httpServer.emit("connection", socket);
  });
  return new Promise((resolve, reject) => {
    ingress.once("error", reject);
    ingress.listen(path, () => {
      ingress.removeListener("error", reject);
      resolve(ingress);
    });
  });
}
