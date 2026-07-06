import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import { validateApiKey } from "../../auth";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createWsRoutes = (deps: ApiDeps, upgradeWebSocket: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // M1: the auth middleware lets /ws through unauthenticated; auth is
      // enforced here. A valid ?key= keeps working (backward compat) and marks
      // the socket pre-authed; otherwise the socket must send a first-message
      // { type: "auth", token } handshake (handled server-side).
      // Plan: https://github.com/RonenMars/threadbase-streamer/blob/a251353bfa417bd48ce3f15086bc336a2c622629/docs/plans/2026-06-24-security-hardening.md#L40
      const key = c.req.query("key");
      const preAuthed = typeof key === "string" && validateApiKey(key, deps.apiKey);
      let openWs: WebSocket | null = null;
      return {
        onOpen(_evt, ws) {
          const raw = ws.raw;
          if (!raw) return;
          openWs = raw;
          deps.handleWsOpen(raw, preAuthed);
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
