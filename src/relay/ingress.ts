import { rmSync } from "fs";
import type { Server as HttpServer, IncomingMessage } from "http";
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

/** Set by the connector from the relay's opaque per-client tag. Meaningless on any other listener. */
export const RELAY_CLIENT_HEADER = "x-tb-relay-client";

/**
 * The key a pre-authentication rate limit buckets a request on.
 *
 * A relayed request has no address of its own, so every relay client would
 * otherwise share one bucket and a single stranger could spend the pairing
 * budget for all of them. The relay's tag separates them.
 *
 * ponytail: the tag is whatever the relay says, so a hostile relay can mint a
 * fresh bucket per request. The limits then stop being a bound on it; what
 * still holds is the pairing token and the Noise handshake behind them. Add a
 * per-tunnel ceiling if that ever has to be a bound too.
 */
export function rateLimitKey(req: IncomingMessage | undefined): string {
  if (!isViaRelay(req?.socket)) return req?.socket?.remoteAddress ?? "unknown";
  const tag = req?.headers[RELAY_CLIENT_HEADER];
  return `relay:${typeof tag === "string" ? tag : "unknown"}`;
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
