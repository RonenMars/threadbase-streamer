import { Hono } from "hono";
import { getVersion } from "../../version";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createHealthRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const cacheAlert = deps.cacheMonitor()?.healthzField();
    return c.json({ ok: true, version: getVersion(), ...(cacheAlert ? { cacheAlert } : {}) });
  });

  return app;
};
