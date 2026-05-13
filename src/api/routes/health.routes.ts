import { Hono } from "hono";
import type { AppEnv } from "../app";

export const createHealthRoutes = () => {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => c.json({ ok: true, version: __VERSION__ }));

  return app;
};
