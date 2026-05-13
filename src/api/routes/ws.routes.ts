import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createWsRoutes = (deps: ApiDeps, upgradeWebSocket: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let openWs: WebSocket | null = null;
      return {
        onOpen(_evt, ws) {
          const raw = ws.raw;
          if (!raw) return;
          openWs = raw;
          deps.handleWsOpen(raw);
        },
        onMessage(evt, _ws) {
          if (openWs) deps.handleWsMessage(openWs, evt.data);
        },
        onClose(_evt, _ws) {
          if (openWs) deps.handleWsClose(openWs);
        },
      };
    }),
  );

  return app;
};
