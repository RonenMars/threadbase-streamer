import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono as HonoApp } from "hono";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { IncomingMessage, Server } from "http";
import type { WebSocket } from "ws";
import { contextRegistry, refuseUnsealedIfPinned } from "../../e2ee/context";
import { getLogger } from "../../logger";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

const log = getLogger("ws");

export const createWsRoutes = (deps: ApiDeps, upgradeWebSocket: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();

  app.get(
    "/ws",
    // The downgrade refusal runs here, BEFORE `upgradeWebSocket` — once that
    // middleware has seen `Upgrade: websocket` it answers 101 unconditionally,
    // and a socket promoted and then closed is not the same answer as a 426 the
    // client can act on.
    //
    // The ticket itself was spent one layer up: `authMiddleware` consumes it
    // and sets both the principal and the context, because a ticketed upgrade
    // authenticates BY the ticket and carries no `Authorization` (§13). By the
    // time this runs, `e2eeContext` is either a live context or nothing.
    async (c, next) => {
      // W1a's guard, called and not re-implemented — two copies of a downgrade
      // rule is one copy that can be forgotten. A pinned device that turns up
      // with a bearer or `?key=` and no ticket gets 426, never a plaintext
      // socket.
      //
      // **Its stated limit applies here and is not this PR's to close.** The
      // pin is per DEVICE, so a pinned phone presenting the SHARED api key
      // resolves to the `legacy` principal with no device row, and the pin
      // cannot bite. That is the stage-3 shared-key problem.
      const refusal = refuseUnsealedIfPinned({
        principal: c.get("principal"),
        devicesRepo: deps.devicesRepo(),
        context: c.get("e2eeContext"),
      });
      if (refusal) {
        log.warn("[e2ee.upgrade_refused] pinned device presented no sealed context", {
          event: "e2ee.upgrade_refused",
        });
        return c.json(refusal.body, refusal.status);
      }
      await next();
    },
    // The principal is read here, at the upgrade, and captured for the life of
    // the socket. authMiddleware sets it because /ws is classified
    // `history:read`, but it only ever reaches the HTTP request — without
    // capturing it the socket has no principal at all, so every frame after
    // the upgrade is unauthorized-by-omission.
    upgradeWebSocket((c) => {
      const principal = c.get("principal") ?? null;
      const context = c.get("e2eeContext");
      let openWs: WebSocket | null = null;
      return {
        onOpen(_evt, ws) {
          const raw = ws.raw;
          if (!raw) {
            // **No orphan without a deadline clock.** The context was attached
            // by `authMiddleware` and its ticket is spent, but without a raw
            // socket `addClient` never runs — so nothing arms the 10 s
            // first-frame deadline, and the one mechanism that collects an
            // unproven context does not exist for this one. It would sit for
            // its full lifetime. Every other path that abandons a consumed
            // context destroys it; this one was the exception.
            if (context) contextRegistry().destroy(context.ctxId);
            return;
          }
          openWs = raw;
          deps.handleWsOpen(raw, context);
        },
        onMessage(evt, _ws) {
          if (openWs) deps.handleWsMessage(openWs, evt.data, principal);
        },
        onClose(_evt, _ws) {
          if (openWs) deps.handleWsClose(openWs);
        },
      };
    }),
  );

  return app;
};

/**
 * Ceiling on ONE client→server frame, enforced BEFORE the frame is allocated
 * (NONCE-DESIGN §10).
 *
 * Everything a client sends is a control message — `register`,
 * `subscribe_session`, `unsubscribe_session`, `hold_session` — none of which
 * reaches a kilobyte, so this is generous by three orders of magnitude and
 * still small enough that a socket without keys cannot make the process buffer
 * anything worth buffering.
 *
 * The server→client direction is bounded by the CLIENT, which is the only side
 * that can refuse a frame before allocating it; `terminal_replay` is the large
 * one and it is capped upstream by `REPLAY_MAX_LINES`.
 */
export const WS_MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/**
 * Strip inherited properties before @hono/node-ws copies raw Node headers with
 * `for...in`. Only bytes Node parsed from the request may reach authentication.
 */
function keepOwnUpgradeHeaders(request: IncomingMessage): void {
  const headers = Object.create(null) as typeof request.headers;
  for (const key of Object.keys(request.headers)) headers[key] = request.headers[key];
  request.headers = headers;
}

/**
 * Mount `/ws` on an app that is already built, and bind the frame ceiling.
 *
 * **This exists so the bound is wired in exactly one place.** §10 states the
 * gap plainly: `@hono/node-ws` constructs its `WebSocketServer` with
 * `{ noServer: true }` and nothing else, so `ws`'s 100 MiB `maxPayload` default
 * applies and a frame is fully assembled before any record-layer check runs —
 * anyone holding a socket without keys, a ticket thief or a legacy `?key=`
 * client, could push 100 MiB. §10 offers two ways out: build our own server
 * with a bound, or accept the ceiling and reap silent sockets.
 *
 * This is the first, without forking the upgrade path. `@hono/node-ws` RETURNS
 * the server it made, and `ws` reads `this.options.maxPayload` per upgrade in
 * `completeUpgrade` rather than at construction — so lowering it here bounds
 * every socket from the next one onwards. That is the whole "construct your own
 * server" outcome in one assignment, with no copy of the upgrade handling to
 * keep in sync. It is receiver-only: `maxPayload` bounds what `ws` will ACCEPT
 * and never what it will send, which is exactly the per-direction split §10
 * asks for.
 *
 * The cost is reaching into a dependency's `options`. That is why this is one
 * function called by both `server.ts` and the sealing tests rather than two
 * copies: a test that stood the wiring up itself would be asserting on its own
 * copy of it.
 */
export function mountWebSocket(
  app: HonoApp<AppEnv>,
  httpServer: Server,
  deps: ApiDeps,
): { wss: ReturnType<typeof createNodeWebSocket>["wss"] } {
  const { wss, injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  wss.options.maxPayload = WS_MAX_CLIENT_FRAME_BYTES;
  app.route("/", createWsRoutes(deps, upgradeWebSocket));
  httpServer.prependListener("upgrade", keepOwnUpgradeHeaders);
  injectWebSocket(httpServer);
  return { wss };
}
