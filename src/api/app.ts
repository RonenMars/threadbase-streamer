import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { WebSocket } from "ws";
import { authMiddleware } from "./middleware/auth.middleware";
import { corsMiddleware } from "./middleware/cors.middleware";
import { errorMiddleware } from "./middleware/error.middleware";
import { createBrowseRoutes } from "./routes/browse.routes";
import { createConversationRoutes } from "./routes/conversations.routes";
import { createHealthRoutes } from "./routes/health.routes";
import { createMiscRoutes } from "./routes/misc.routes";
import { createPairRoutes } from "./routes/pair.routes";
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
  };
};

export const createHonoApp = (deps: ApiDeps, upgradeWebSocket?: UpgradeWebSocket<WebSocket>) => {
  const app = new Hono<AppEnv>();

  app.use("*", corsMiddleware());
  app.use("*", authMiddleware(deps));
  app.onError(errorMiddleware);

  app.route("/healthz", createHealthRoutes());
  app.route("/", createMiscRoutes(deps));
  app.route("/api/sessions", createSessionRoutes(deps));
  app.route("/api/conversations", createConversationRoutes(deps));
  app.route("/api/projects", createProjectRoutes(deps));
  app.route("/api/pair", createPairRoutes(deps));
  app.route("/api", createBrowseRoutes(deps));
  app.route("/", createScannerRoutes(deps));

  if (upgradeWebSocket) {
    app.route("/", createWsRoutes(deps, upgradeWebSocket));
  }

  return app;
};
