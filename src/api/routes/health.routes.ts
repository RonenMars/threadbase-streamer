import { Hono } from "hono";
import { databaseHealthAlert } from "../../db/query-timing";
import { getBuildInfo, getVersion } from "../../version";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";

export const createHealthRoutes = (deps: ApiDeps) => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const cacheAlert = deps.cacheMonitor()?.healthzField();
    const databaseAlert = databaseHealthAlert();
    return c.json({
      ok: true,
      version: getVersion(),
      build: getBuildInfo(),
      ...(cacheAlert ? { cacheAlert } : {}),
      ...(databaseAlert ? { databaseAlert } : {}),
    });
  });

  return app;
};
