import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createWsRoutes = (deps: ApiDeps, upgradeWebSocket: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();

  app.get(
    "/ws",
    // The principal is read here, at the upgrade, and captured for the life of
    // the socket. authMiddleware sets it because /ws is classified
    // `history:read`, but it only ever reaches the HTTP request — without
    // capturing it the socket has no principal at all, so every frame after
    // the upgrade is unauthorized-by-omission.
    upgradeWebSocket((c) => {
      const principal = c.get("principal") ?? null;
      let openWs: WebSocket | null = null;
      return {
        onOpen(_evt, ws) {
          const raw = ws.raw;
          if (!raw) return;
          openWs = raw;
          deps.handleWsOpen(raw);
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
