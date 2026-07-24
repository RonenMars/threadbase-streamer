import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import { getLogger } from "../logger";
import type { Principal } from "../services/security/capabilities";
import { authMiddleware } from "./middleware/auth.middleware";
import { corsMiddleware } from "./middleware/cors.middleware";
import { errorMiddleware } from "./middleware/error.middleware";
import { createBrowseRoutes } from "./routes/browse.routes";
import { createCacheAlertRoutes } from "./routes/cacheAlert.routes";
import { createConfigRoutes } from "./routes/config.routes";
import { createConversationRoutes } from "./routes/conversations.routes";
import { createDeviceRoutes } from "./routes/devices.routes";
import { createHealthRoutes } from "./routes/health.routes";
import { createLogsRoutes } from "./routes/logs.routes";
import { createMiscRoutes } from "./routes/misc.routes";
import { createPairRoutes } from "./routes/pair.routes";
import { createProgressRoutes } from "./routes/progress.routes";
import { createProjectRoutes } from "./routes/projects.routes";
import { createScannerRoutes } from "./routes/scanner.routes";
import { createSessionRoutes } from "./routes/sessions.routes";
import { createWsRoutes } from "./routes/ws.routes";
import type { ApiDeps } from "./types/api-deps";

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    requestId?: string;
    validatedBody?: unknown;
    validatedQuery?: unknown;
    /** Who is making this request (C5). Set by authMiddleware. */
    principal?: Principal;
  };
};

export const createHonoApp = (deps: ApiDeps, upgradeWebSocket?: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();
  const httpLog = getLogger("http");

  app.use("*", async (c, next) => {
    const start = Date.now();
    const ua = c.req.header("user-agent") ?? "";
    await next();
    if (!deps.logMenubarRequests && c.req.header("x-client") === "menubar") return;
    const ms = Date.now() - start;
    httpLog.info(`[req] ${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms`, {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms,
      ua,
      event: "http.request",
    });
  });
  app.use("*", corsMiddleware(deps.browserCors));
  app.use("*", authMiddleware(deps));
  app.onError(errorMiddleware);

  app.route("/healthz", createHealthRoutes(deps));
  app.route("/", createMiscRoutes(deps));
  app.route("/api/sessions", createSessionRoutes(deps));
  app.route("/api/conversations", createConversationRoutes(deps));
  app.route("/api/cache/alert", createCacheAlertRoutes(deps));
  app.route("/api/config", createConfigRoutes(deps));
  app.route("/api/projects", createProjectRoutes(deps));
  app.route("/api/devices", createDeviceRoutes(deps));
  app.route("/api/pair", createPairRoutes(deps));
  app.route("/api", createBrowseRoutes(deps));
  app.route("/", createScannerRoutes(deps));
  app.route("/internal", createProgressRoutes(deps));
  app.route("/api/logs", createLogsRoutes());

  if (upgradeWebSocket) {
    app.route("/", createWsRoutes(deps, upgradeWebSocket));
  }

  return app;
};
