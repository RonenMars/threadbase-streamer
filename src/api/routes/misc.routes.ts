import { Hono } from "hono";
import { hostname } from "os";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createMiscRoutes = (
  deps: Pick<ApiDeps, "publicUrl" | "sessionStore" | "ptyAttachedIds">,
) => {
  const app = new Hono<AppEnv>();

  app.get("/api/info", (c) => {
    const ptyIds = deps.ptyAttachedIds();
    return c.json({
      version: __VERSION__,
      machineName: hostname(),
      platform: process.platform,
      activeSessions: deps.sessionStore.list(ptyIds).filter((s) => s.status === "running").length,
      publicUrl: deps.publicUrl,
    });
  });

  app.get("/api/profiles", (c) => c.json([]));

  app.post("/api/push/register", (c) => c.json({ ok: true }));

  return app;
};
