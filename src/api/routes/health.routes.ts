import { Hono } from "hono";
import { getVersion } from "../../version";
import type { AppEnv } from "../app";

export const createHealthRoutes = () => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => c.json({ ok: true, version: getVersion() }));

  return app;
};
